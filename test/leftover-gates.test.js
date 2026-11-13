"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const telemetry = require("../src/observability/sentry");
const { createPdpaRetention } = require("../src/lib/pdpa-retention");
const { runDeliberateFailureDrill, runHealthCheck } = require("../scripts/health-check");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function loadGateway(t, overrides = {}) {
  const values = {
    LINE_CHANNEL_SECRET: "fixture-line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "fixture-line-token",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    SUPABASE_URL: "https://database.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_fixture",
    GEMINI_API_KEY: "fixture-gemini-key",
    GEMINI_ENABLED: "true",
    GEMINI_MODEL: "fixture-gemini",
    GEMINI_MODELS: "",
    GEMINI_FALLBACK_MODELS: "",
    FALLBACK_PROVIDER: "",
    FALLBACK_API_KEY: "",
    FALLBACK_BASE_URL: "",
    FALLBACK_MODEL: "",
    FALLBACK_MODELS: "",
    FOUNDER_LINE_ID: "Ufounder",
    NEUROHANDS_API_KEY: "fixture-api-key",
    ENABLE_STUDIO: "false",
    SOFTWARE_ADMISSION_ENABLED: "false",
    ...overrides,
  };
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve("../src/server")];
  });
  delete require.cache[require.resolve("../src/server")];
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  return require("../src/server");
}

test("G16 (BUG-jarvis-empty-final): post-tool empty Gemini final turn recovers via single tool-disabled synthesis without repeating tool execution", async (t) => {
  const gateway = loadGateway(t);
  let geminiCalls = 0;
  let toolExecutions = 0;
  const seenToolArrays = [];

  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.hostname === "generativelanguage.googleapis.com") {
      geminiCalls += 1;
      const body = JSON.parse(options.body);
      seenToolArrays.push(body.tools || null);
      if (geminiCalls === 1) {
        return json({
          candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "list_clients", args: {} } }] } }],
        });
      }
      if (geminiCalls === 2) {
        return json({
          candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "   " }] } }],
        });
      }
      return json({
        candidates: [{ content: { role: "model", parts: [{ text: "Active client: KNC Glass (KNC)." }] } }],
      });
    }
    if (address.hostname === "database.invalid") {
      const table = address.pathname.replace("/rest/v1/", "");
      if (table === "staff_activations") return json([{ id: 1, line_user_id: "Ustaff", role: "admin", active: true }]);
      if (table === "agent_runs") {
        if ((options.method || "GET") === "GET") return json([]);
        return json([{ id: 77 }]);
      }
      if (table === "jarvis_notes") return json([]);
      if (table === "client_accounts") {
        toolExecutions += 1;
        return json([{ id: 1, client_code: "KNC", company: "KNC Glass", active: true }]);
      }
      if (table === "tool_calls") return json([{ id: 1 }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const ctx = { lineUserId: "Ustaff" };
  const reply = await gateway.runJarvis(ctx, "Which active clients do we have?");
  assert.equal(ctx.runStatus, "completed");
  assert.equal(reply, "Active client: KNC Glass (KNC).");
  assert.equal(toolExecutions, 1, "Tool must execute once and never repeat during synthesis");
  assert.equal(geminiCalls, 3);
  assert.ok(Array.isArray(seenToolArrays[0]), "Initial call includes tool declarations");
  assert.equal(seenToolArrays[2], null, "Synthesis recovery call omits tool declarations");
});

test("G6 (TASK-034): slow agent failure after 'Checking...' sends follow-up apology push so customer is not stranded", async (t) => {
  const gateway = loadGateway(t);
  const lineCalls = [];

  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.hostname === "api.line.me") {
      lineCalls.push({ path: address.pathname, body: JSON.parse(options.body) });
      return json({});
    }
    return json([{ id: 1 }]);
  });

  const slowFailingRunner = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    throw new Error("Simulated slow runner crash");
  };

  await assert.rejects(
    gateway.respondAgentWithRace(
      { source: { userId: "Ucustomer1" }, replyToken: "reply-tok-1" },
      { lineUserId: "Ucustomer1", clientAccountId: 1, department: "sales" },
      "Check my order",
      { agent_code: "AGT-001" },
      slowFailingRunner,
      10
    ),
    /Simulated slow runner crash/
  );

  assert.equal(lineCalls.length, 2);
  assert.equal(lineCalls[0].path, "/v2/bot/message/reply");
  assert.equal(lineCalls[0].body.messages[0].text, "⏳ Checking...");
  assert.equal(lineCalls[1].path, "/v2/bot/message/push");
  assert.equal(lineCalls[1].body.to, "Ucustomer1");
  assert.match(lineCalls[1].body.messages[0].text, /could not complete/i);
});

test("P0 / G5 (TASK-047) & G15: unactivated visitors cannot read KNC prices; cross-tenant and expired rows/docs are filtered", async (t) => {
  const gateway = loadGateway(t, { LEGACY_CATALOG_OWNER_CLIENT_ACCOUNT_ID: "1" });
  const lineReplies = [];
  const pastIso = "2020-01-01T00:00:00.000Z";
  const futureIso = "2099-01-01T00:00:00.000Z";

  const bindingsByUser = {
    Uknc: [{ client_account_id: 1, department: "sales", status: "active" }],
    Uother: [{ client_account_id: 2, department: "sales", status: "active" }],
  };

  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.hostname === "api.line.me") {
      lineReplies.push(JSON.parse(options.body));
      return json({});
    }
    const table = address.pathname.replace("/rest/v1/", "");
    if (table === "client_agent_bindings") {
      const uid = address.searchParams.get("line_user_id")?.slice(3);
      return json(bindingsByUser[uid] || []);
    }
    if (table === "client_accounts") {
      const idFilter = address.searchParams.get("id") || "";
      const rows = [{ id: 1, active: true }, { id: 2, active: true }];
      if (idFilter.startsWith("eq.")) {
        const want = idFilter.slice(3);
        return json(rows.filter((r) => String(r.id) === want));
      }
      if (idFilter.startsWith("in.(") && idFilter.endsWith(")")) {
        const want = new Set(idFilter.slice(4, -1).split(","));
        return json(rows.filter((r) => want.has(String(r.id))));
      }
      return json(rows);
    }
    if (table === "glass_types") {
      return json([
        { product_code: "KNC-CLR-6", glass_name: "Clear Float", thickness_mm: 6, price_per_sqft: 45, client_account_id: 1, expires_at: futureIso },
        { product_code: "KNC-OLD-6", glass_name: "Expired Promo", thickness_mm: 6, price_per_sqft: 19, client_account_id: 1, expires_at: pastIso },
        { product_code: "OTH-LAM-8", glass_name: "Other Tenant Glass", thickness_mm: 8, price_per_sqft: 99, client_account_id: 2, expires_at: futureIso },
      ]);
    }
    if (table === "edging_services") {
      return json([
        { service_code: "EDG-KNC", service_name: "Flat Polish", price_per_sqft: 12, client_account_id: 1, expires_at: futureIso },
        { service_code: "EDG-OTH", service_name: "Tenant 2 Bevel", price_per_sqft: 30, client_account_id: 2, expires_at: futureIso },
      ]);
    }
    if (table === "client_documents") {
      const code = address.searchParams.get("doc_code")?.slice(3);
      const docs = [
        { doc_code: "DOC-FRESH", department: "sales", file_name: "fresh.xlsx", parsed_status: "parsed", row_count: 4, created_at: "2026-10-01T00:00:00Z", expires_at: futureIso, parsed_summary: { text: "Fresh rate card", extraction_complete: true } },
        { doc_code: "DOC-EXPIRED", department: "sales", file_name: "expired.xlsx", parsed_status: "parsed", row_count: 4, created_at: "2025-01-01T00:00:00Z", expires_at: pastIso, parsed_summary: { text: "Stale 2025 rate", extraction_complete: true } },
      ];
      return json(code ? docs.filter((d) => d.doc_code === code) : docs);
    }
    if (table === "tool_calls") return json([{ id: 1 }]);
    return json([]);
  });

  await gateway.handleEvent({
    type: "postback",
    source: { type: "user", userId: "Uvisitor_unactivated" },
    replyToken: "tok-vis",
    postback: { data: "menu=products" },
  });
  assert.match(lineReplies[0].messages[0].text, /Please activate first/);
  assert.doesNotMatch(lineReplies[0].messages[0].text, /THB\/sqft|KNC-CLR-6/);

  const kncText = await gateway.getProductText("Uknc");
  assert.match(kncText, /KNC-CLR-6/);
  assert.doesNotMatch(kncText, /KNC-OLD-6/, "Expired KNC SKU must be filtered");
  assert.doesNotMatch(kncText, /OTH-LAM-8|EDG-OTH/, "Tenant 2 catalog must never leak to KNC");

  const ctx = {
    lineUserId: "Uknc",
    clientAccountId: 1,
    department: "sales",
    allowedTools: ["get_product_info", "list_documents", "read_document"],
  };
  const prodOut = await gateway.executeToolWithLog(ctx, 1, "get_product_info", {});
  assert.deepEqual(prodOut.products.map((p) => p.product_code), ["KNC-CLR-6"]);

  const docsOut = await gateway.executeToolWithLog(ctx, 1, "list_documents", {});
  assert.deepEqual(docsOut.documents.map((d) => d.doc_code), ["DOC-FRESH"]);

  const staleRead = await gateway.executeToolWithLog(ctx, 1, "read_document", { doc_code: "DOC-EXPIRED" });
  assert.equal(staleRead.readable, false);
  assert.equal(staleRead.expired, true);
});

test("G12: Express gateway wires sentry.middleware before error handler without leaking PII", async (t) => {
  const captured = [];
  const fakeInstance = {
    enabled: true,
    status: "configured",
    middleware(err, _req, _res, next) {
      const safe = telemetry.beforeSend({
        exception: { values: [{ type: err.name, value: err.message }] },
        request: { data: "PRIVATE_CUSTOMER_LINE_PAYLOAD" },
      });
      if (safe) captured.push(safe);
      next(err);
    },
    flush: async () => true,
    close: async () => true,
  };
  t.mock.method(telemetry, "createSentry", () => fakeInstance);
  const gateway = loadGateway(t);
  const server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: "/api/agent/run",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }
    );
    req.on("error", reject);
    req.end('{"broken_json": "PRIVATE_CUSTOMER_LINE_PAYLOAD');
  });

  assert.equal(res.status, 400);
  assert.equal(captured.length, 1);
  assert.equal(JSON.stringify(captured).includes("PRIVATE_CUSTOMER_LINE_PAYLOAD"), false);
});

test("G8 (TASK-038) & G3 (PDPA): PostgreSQL migrations count per-business chats accurately and erase/purge customer PII cleanly", async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  await pg.exec(fs.readFileSync(path.join(__dirname, "fixtures/legacy-schema.sql"), "utf8"));
  await pg.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql"), "utf8"));
  await pg.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260909155146_jarvis_operator_runs.sql"), "utf8"));
  await pg.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20261102000001_per_business_chat_rollup.sql"), "utf8"));
  await pg.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20261102000002_pdpa_retention_deletion.sql"), "utf8"));

  const kncId = (await pg.query("select id from client_accounts where client_code = 'KNC'")).rows[0].id;
  const b2Id = (await pg.query("insert into client_accounts(client_code, company) values ('BIZ2', 'Second Business') returning id")).rows[0].id;

  await pg.query(
    "insert into client_agent_bindings(client_account_id, line_user_id, department, status) values ($1, 'Uknc_chat', 'sales', 'active'), ($2, 'Ubiz2_chat', 'sales', 'active')",
    [kncId, b2Id]
  );
  const kncClientId = (await pg.query("insert into clients(line_user_id, client_account_id, name) values ('Uknc_chat', $1, 'Somchai') returning id", [kncId])).rows[0].id;
  await pg.query("insert into orders(order_no, client_id, client_account_id, stage) values ('PO-KNC-900', $1, $2, 'confirmed')", [kncClientId, kncId]);

  await pg.query("insert into messages(line_user_id, direction, text_content, answered_by, status) values ('Uknc_chat', 'in', 'Hello KNC', 'bot', 'received')");
  const runId = (await pg.query(
    "insert into agent_runs(agent_code, line_user_id, client_account_id, department, input, status, output) values ('AGT-001', 'Uknc_chat', $1, 'sales', 'Hello KNC', 'completed', 'Hi Somchai') returning id",
    [kncId]
  )).rows[0].id;
  await pg.query(
    "insert into messages(line_user_id, client_account_id, run_id, direction, text_content, answered_by, status) values ('Uknc_chat', $1, $2, 'out', 'Hi Somchai', 'agent:AGT-001', 'sent')",
    [kncId, runId]
  );
  await pg.query("insert into tool_calls(run_id, agent_code, tool_name, allowed, status) values ($1, 'AGT-001', 'get_recent_orders', true, 'success')", [runId]);
  await pg.query("insert into agent_memory(agent_code, client_account_id, line_user_id, memory_type, content, source_run_id) values ('AGT-001', $1, 'Uknc_chat', 'preference', 'Tempered 10mm', $2)", [kncId, runId]);
  await pg.query("insert into messages(line_user_id, direction, text_content, answered_by, status) values ('Ubiz2_chat', 'in', 'Hello BIZ2', 'bot', 'received')");
  await pg.query("insert into messages(line_user_id, direction, text_content, answered_by, status) values ('Upublic', 'out', 'Welcome', 'concierge', 'sent')");
  await pg.query("insert into messages(line_user_id, direction, text_content, answered_by, status) values ('Ufounder', 'out', 'Digest', 'jarvis', 'sent')");

  const kncCounts = (await pg.query("select * from public.nh_count_business_chats($1)", [kncId])).rows[0];
  assert.equal(Number(kncCounts.inbound_messages), 1);
  assert.equal(Number(kncCounts.outbound_messages), 1);
  assert.equal(Number(kncCounts.completed_agent_runs), 1);
  assert.equal(Number(kncCounts.unique_line_users), 1);

  const b2Counts = (await pg.query("select * from public.nh_count_business_chats($1)", [b2Id])).rows[0];
  assert.equal(Number(b2Counts.inbound_messages), 1);
  assert.equal(Number(b2Counts.outbound_messages), 0);

  const pdpa = createPdpaRetention({
    db: async (endpoint, opts) => {
      if (endpoint === "rpc/nh_erase_line_user_data") {
        const r = await pg.query("select public.nh_erase_line_user_data($1, $2) as res", [opts.body.p_line_user_id, opts.body.p_client_account_id]);
        return [r.rows[0].res];
      }
      if (endpoint === "rpc/nh_purge_expired_customer_data") {
        const r = await pg.query("select public.nh_purge_expired_customer_data($1) as res", [opts.body.p_retention_days]);
        return [r.rows[0].res];
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  });

  const erased = await pdpa.eraseLineUserData("Uknc_chat", kncId);
  assert.equal(erased.erased, true);
  assert.equal(erased.memories_deleted, 1);
  assert.equal(erased.messages_deleted, 2);
  assert.equal(erased.runs_deleted, 1);
  assert.equal(erased.bindings_revoked, 1);
  assert.equal(erased.clients_deleted, 1);

  assert.equal((await pg.query("select count(*)::int as n from messages where line_user_id = 'Uknc_chat'")).rows[0].n, 0);
  assert.equal((await pg.query("select count(*)::int as n from orders where order_no = 'PO-KNC-900' and client_id is null")).rows[0].n, 1, "Commercial order header survives detached from erased PII");
  assert.equal((await pg.query("select count(*)::int as n from messages where line_user_id = 'Ubiz2_chat'")).rows[0].n, 1, "Other tenant data untouched");

  await pg.query(
    "insert into messages(line_user_id, client_account_id, direction, text_content, answered_by, status, created_at) values ('Uold', $1, 'in', '2 years old', 'bot', 'received', now() - interval '400 days')",
    [b2Id]
  );
  const purged = await pdpa.purgeExpiredCustomerData(365);
  assert.equal(purged.purged, true);
  assert.equal(purged.messages_deleted, 1);
});

test("G7 (TASK-035): health-check probe and deliberate failure drill detect 503 outage and verify recovery", async () => {
  const drill = await runDeliberateFailureDrill();
  assert.equal(drill.drillPassed, true);
  assert.deepEqual(drill.phases, {
    baseline_healthy: true,
    outage_detected: true,
    recovery_confirmed: true,
  });
  await assert.rejects(() => runHealthCheck({ baseUrl: "ftp://invalid" }), TypeError);
});

test("Continuity & multi-model failover: mid-conversation HTTP 429 usage limit switches to GEMINI_FALLBACK_MODELS with full conversation + tool output intact and zero repeated tool calls", async (t) => {
  const gateway = loadGateway(t, {
    GEMINI_MODEL: "gemini-2.5-flash",
    GEMINI_FALLBACK_MODELS: "gemini-2.5-flash-lite,gemini-2.0-flash",
  });
  const modelCalls = [];
  let toolExecutions = 0;

  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.hostname === "generativelanguage.googleapis.com") {
      const m = address.pathname.match(/\/models\/([^/:]+):generateContent$/);
      const calledModel = m ? m[1] : "unknown";
      const body = JSON.parse(options.body);
      modelCalls.push({ model: calledModel, contentsLen: body.contents.length });

      if (modelCalls.length === 1) {
        return json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { id: "call-1", name: "list_clients", args: {} } }],
              },
            },
          ],
        });
      }
      if (calledModel === "gemini-2.5-flash") {
        return json(
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Per-model usage limit reached for gemini-2.5-flash",
            },
          },
          429
        );
      }
      return json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Resumed on fallback model: active client is KNC Glass (KNC)." }],
            },
          },
        ],
      });
    }
    if (address.hostname === "database.invalid") {
      const table = address.pathname.replace("/rest/v1/", "");
      if (table === "staff_activations") return json([{ id: 1, line_user_id: "Ustaff", role: "admin", active: true }]);
      if (table === "agent_runs") {
        if ((options.method || "GET") === "GET") {
          return json([
            {
              id: 12,
              line_user_id: "Ustaff",
              run_kind: "operator",
              client_account_id: null,
              agent_code: null,
              department: "operations",
              objective: "Assist the Neurohands operator with verified business information and approved actions.",
              status: "completed",
              delivered_at: "2026-10-15T10:00:00.000Z",
              input: "Earlier question",
              output: "Earlier answer",
            },
          ]);
        }
        return json([{ id: 88 }]);
      }
      if (table === "jarvis_notes") return json([]);
      if (table === "client_accounts") {
        toolExecutions += 1;
        return json([{ id: 1, client_code: "KNC", company: "KNC Glass", active: true }]);
      }
      if (table === "tool_calls") return json([{ id: 1 }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const ctx = { lineUserId: "Ustaff" };
  const reply = await gateway.runJarvis(ctx, "Resume client status check");
  assert.equal(ctx.runStatus, "completed");
  assert.equal(reply, "Resumed on fallback model: active client is KNC Glass (KNC).");
  assert.equal(toolExecutions, 1, "Mutating/DB tool must never re-execute across model failover");
  assert.deepEqual(
    modelCalls.map((c) => c.model),
    ["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
  );
  assert.equal(
    modelCalls[2].contentsLen,
    5,
    "Fallback model receives prior history (2) + current user (1) + functionCall (1) + functionResponse (1)"
  );
});
