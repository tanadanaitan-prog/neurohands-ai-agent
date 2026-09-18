const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

const requestedAt = "2026-09-18T03:00:00.000Z";

async function fixture(t) {
  Object.assign(process.env, {
    LINE_CHANNEL_SECRET: "test-line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "test-line-token",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    SUPABASE_URL: "https://database.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_test-only",
    GEMINI_API_KEY: "",
    GEMINI_ENABLED: "false",
    FOUNDER_LINE_ID: "founder",
    JARVIS_ACTIVATION_CODE: "",
    NEUROHANDS_API_KEY: "private-api-key",
    CRON_SECRET: "",
    FALLBACK_PROVIDER: "groq",
    FALLBACK_API_KEY: "fallback-test-key",
    FALLBACK_BASE_URL: "https://model.invalid/v1",
    FALLBACK_MODEL: "test-model",
    FALLBACK_MODELS: "",
    SOFTWARE_ADMISSION_ENABLED: "false",
  });
  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");
  const requests = new Map();
  const runs = [];
  const modelBodies = [];
  let releaseModel = null;
  let holdModel = false;
  let loseFinishReceipt = false;
  let forceUncertainAtFinish = false;
  let modelCalls = 0;
  let bindingTenant = 1;

  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(String(address));
    const method = options.method || "GET";
    if (url.hostname === "model.invalid") {
      modelCalls++;
      const body = JSON.parse(options.body);
      modelBodies.push(body);
      if (holdModel) await new Promise((resolve) => { releaseModel = resolve; });
      return json({ choices: [{ message: { role: "assistant", content: "stored model answer" } }] });
    }
    assert.equal(url.hostname, "database.invalid");
    assert.equal(options.headers.apikey, "sb_secret_test-only");
    const resource = url.pathname.replace("/rest/v1/", "");
    if (resource === "rpc/nh_claim_agent_api_request") {
      const input = JSON.parse(options.body);
      const ledgerKey = input.p_idempotency_key_hash;
      let row = requests.get(ledgerKey);
      if (!row) {
        row = {
          decision: "acquired",
          execution_id: crypto.randomUUID(),
          requested_at: requestedAt,
          state: "in_progress",
          response_status: null,
          response_body: null,
          run_id: null,
          client_account_id: input.p_client_account_id,
          request_digest: input.p_request_digest,
        };
        requests.set(ledgerKey, row);
        return json([row]);
      }
      if (row.client_account_id !== input.p_client_account_id || row.request_digest !== input.p_request_digest) {
        return json([{ ...row, decision: "conflict", response_status: null, response_body: null }]);
      }
      return json([{ ...row, decision: row.state === "completed" ? "completed" : row.state }]);
    }
    if (resource === "rpc/nh_finish_agent_api_request") {
      const input = JSON.parse(options.body);
      const ledgerKey = input.p_idempotency_key_hash;
      const row = requests.get(ledgerKey);
      assert.ok(row);
      assert.equal(input.p_request_digest, row.request_digest);
      assert.equal(input.p_execution_id, row.execution_id);
      if (forceUncertainAtFinish) {
        forceUncertainAtFinish = false;
        Object.assign(row, { state: "uncertain", response_status: null, response_body: null });
      }
      if (row.state === "in_progress") Object.assign(row, {
        state: input.p_state,
        response_status: input.p_state === "completed" ? input.p_response_status : null,
        response_body: input.p_state === "completed" ? input.p_response_body : null,
        run_id: input.p_run_id,
      });
      if (loseFinishReceipt) {
        loseFinishReceipt = false;
        throw new TypeError("Injected lost completion receipt");
      }
      return json([{ ...row, decision: row.state }]);
    }
    if (resource === "client_agent_bindings") return json([{
      id: 1, line_user_id: "line-user", client_account_id: bindingTenant, department: "sales", status: "active",
    }]);
    if (resource === "client_accounts") return json([{ id: bindingTenant }]);
    if (resource === "agent_registry") return json([{
      agent_code: "AGT-001", callsign: "Aria", department: "sales", agent_name: "Sales agent",
      objective: "Answer the customer", active: true, allowed_tools: [], domains: ["sales"], responsibilities: ["Answer"],
    }]);
    if (resource === "agent_memory") return json([]);
    if (resource === "agent_runs" && method === "POST") {
      const row = { id: runs.length + 1, ...JSON.parse(options.body) };
      runs.push(row);
      return json([row], 201);
    }
    if (resource === "agent_runs" && method === "PATCH") {
      const id = Number(url.searchParams.get("id")?.replace("eq.", ""));
      const row = runs.find((item) => item.id === id);
      Object.assign(row, JSON.parse(options.body));
      return json([row]);
    }
    throw new Error(`Unexpected database resource ${resource}`);
  });

  const server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = ({ idempotencyKey, message = "test request", department = "sales" } = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ line_user_id: "line-user", department, message });
    const headers = { "content-type": "application/json", "x-api-key": "private-api-key" };
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port,
      path: "/api/agent/run", method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return {
    gateway, request, requests, runs, modelBodies,
    modelCalls: () => modelCalls,
    hold: () => { holdModel = true; },
    release: () => { holdModel = false; releaseModel?.(); },
    loseNextFinishReceipt: () => { loseFinishReceipt = true; },
    makeNextFinishUncertain: () => { forceUncertainAtFinish = true; },
    rebindTenant: (tenant) => { bindingTenant = tenant; },
  };
}

test("POST /api/agent/run uses one durable execution for each accepted key", async (t) => {
  await t.test("missing or malformed Idempotency-Key is rejected before database or model work", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request()).status, 400);
    assert.equal((await f.request({ idempotencyKey: "short" })).status, 400);
    assert.equal(f.modelCalls(), 0);
    assert.equal(f.requests.size, 0);
  });

  await t.test("completed retry returns the exact stored response without a new model or run", async (t) => {
    const f = await fixture(t);
    const first = await f.request({ idempotencyKey: "api-completed-0001" });
    assert.equal(first.status, 200, JSON.stringify({ body: first.body, ledger: [...f.requests.values()], runs: f.runs, modelCalls: f.modelCalls() }));
    assert.equal(first.body.reply, "stored model answer");
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
    assert.match(f.modelBodies[0].messages[0].content, new RegExp(requestedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const replay = await f.request({ idempotencyKey: "api-completed-0001" });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal(replay.headers["x-idempotent-replay"], "true");
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
  });

  await t.test("same tenant/key with changed message is rejected without execution", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request({ idempotencyKey: "api-conflict-0001", message: "first" })).status, 200);
    const conflict = await f.request({ idempotencyKey: "api-conflict-0001", message: "different" });
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error, /different request/i);
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
  });

  await t.test("same key cannot execute again after its LINE binding moves tenants", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request({ idempotencyKey: "api-rebound-tenant-0001" })).status, 200);
    f.rebindTenant(2);
    const conflict = await f.request({ idempotencyKey: "api-rebound-tenant-0001" });
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error, /different request/i);
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
  });

  await t.test("a lost completion receipt reconciles to the stored response without executing again", async (t) => {
    const f = await fixture(t);
    f.loseNextFinishReceipt();
    const result = await f.request({ idempotencyKey: "api-lost-finish-0001" });
    assert.equal(result.status, 200);
    assert.equal(result.body.reply, "stored model answer");
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
    const replay = await f.request({ idempotencyKey: "api-lost-finish-0001" });
    assert.deepEqual(replay.body, result.body);
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
  });

  await t.test("a concurrent retry sees in-progress state and cannot duplicate model or tool work", async (t) => {
    const f = await fixture(t);
    f.hold();
    const first = f.request({ idempotencyKey: "api-concurrent-0001" });
    for (let attempt = 0; attempt < 200 && f.modelCalls() === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(f.modelCalls(), 1, "The first request must reach the held model exactly once");
    const duplicate = await f.request({ idempotencyKey: "api-concurrent-0001" });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /in progress/i);
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
    f.release();
    assert.equal((await first).status, 200);
  });

  await t.test("a successful model result is withheld when its terminal database state became uncertain", async (t) => {
    const f = await fixture(t);
    f.makeNextFinishUncertain();
    const result = await f.request({ idempotencyKey: "api-terminal-mismatch-0001" });
    assert.equal(result.status, 503);
    assert.match(result.body.error, /could not be confirmed|check its status/i);
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.runs.length, 1);
    const retry = await f.request({ idempotencyKey: "api-terminal-mismatch-0001" });
    assert.equal(retry.status, 409);
    assert.equal(f.modelCalls(), 1);
  });

  await t.test("uncertain and failed prior states never restart execution", async (t) => {
    for (const state of ["uncertain", "failed"]) {
      const f = await fixture(t);
      const key = `api-${state}-0001`;
      const keyHash = crypto.createHash("sha256").update(key).digest("hex");
      const requestDigest = require("../src/lib/api-agent-idempotency").requestDigest({
        clientAccountId: 1, department: "sales", lineUserId: "line-user", message: "test request",
      });
      f.requests.set(keyHash, { decision: state, execution_id: crypto.randomUUID(),
        requested_at: requestedAt, state, response_status: null, response_body: null, run_id: null,
        client_account_id: 1, request_digest: requestDigest });
      const result = await f.request({ idempotencyKey: key });
      assert.equal(result.status, 409);
      assert.equal(f.modelCalls(), 0);
      assert.equal(f.runs.length, 0);
    }
  });

  await t.test("API execution identity is stable and separate from LINE event identity", async (t) => {
    const f = await fixture(t);
    const executionId = crypto.randomUUID();
    assert.equal(f.gateway.modelExecutionIdentity({ apiExecutionId: executionId }, 9), `api:${executionId}`);
  });
});
