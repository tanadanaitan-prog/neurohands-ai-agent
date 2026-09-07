const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const XLSX = require("xlsx");

const apiHeaders = { "x-api-key": "local-proof-api", "content-type": "application/json" };
const marker = "KNC-PILOT-739261";

async function fixture(t) {
  Object.assign(process.env, {
    LINE_CHANNEL_SECRET: "local-proof-signing", LINE_CHANNEL_ACCESS_TOKEN: "local-proof-line",
    SUPABASE_URL: "https://database.invalid", SUPABASE_SERVICE_KEY: "sb_secret_local-proof",
    NEUROHANDS_API_KEY: "local-proof-api", GEMINI_API_KEY: "", FOUNDER_LINE_ID: "",
    FALLBACK_API_KEY: "local-proof-model", FALLBACK_PROVIDER: "groq",
    FALLBACK_BASE_URL: "https://model.invalid", FALLBACK_MODELS: "local-proof", FALLBACK_MODEL: "",
    ENABLE_STUDIO: "false", JARVIS_ACTIVATION_CODE: "", CRON_SECRET: "",
  });
  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");
  const tables = {
    client_accounts: [{ id: 1, client_code: "KNC", company: "KNC Glass" }, { id: 2, client_code: "OTH", company: "Other client" }],
    activation_codes: [{ id: 1, code: "TEST-KNC-LOCAL-ONLY", client_account_id: 1, department: "sales", status: "active", max_uses: 1, used_count: 0 }],
    client_agent_bindings: [], clients: [], settings: [], client_documents: [], tool_calls: [], agent_runs: [], agent_memory: [], jarvis_audit_log: [],
    agent_registry: [{ id: 1, agent_code: "AGT-001", callsign: "Aria", department: "sales", agent_name: "KNC agent", active: true, customer_facing: true, allowed_tools: ["read_document"], domains: ["sales"], responsibilities: ["Read authorized documents"], objective: "Answer from evidence" }],
  };
  const state = { tables, objects: new Map(), requests: [], faults: new Set(), documentCode: null, modelCalls: 0 };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(String(address)), method = options.method || "GET";
    state.requests.push({ host: url.hostname, path: url.pathname, query: url.search, method });
    if (url.hostname === "api.line.me") return json({ message: "Rejected for local test" }, 429);
    if (url.hostname === "model.invalid") {
      state.modelCalls += 1;
      assert.equal(options.headers.Authorization, "Bearer local-proof-model");
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].role, "system");
      const result = body.messages.filter((message) => message.role === "tool").at(-1);
      if (!result) return json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "local-call-1", type: "function", function: { name: "read_document", arguments: JSON.stringify({ doc_code: state.documentCode, client_account_id: 999 }) } }] } }] });
      const evidence = JSON.parse(result.content);
      const retrieved = evidence.content?.sheet_data?.flatMap((sheet) => sheet.rows).flat().find((value) => value === marker);
      return json({ choices: [{ message: { role: "assistant", content: retrieved ? `The retrieved reference is ${retrieved}.` : "The document is not available to this client." } }] });
    }
    assert.equal(url.hostname, "database.invalid", "Never contact a live service in these tests");
    assert.equal(options.headers.apikey, "sb_secret_local-proof");
    assert.equal(options.headers.Authorization, undefined);
    if (url.pathname.startsWith("/storage/v1/object/neurohands-docs/")) {
      if (state.faults.has("storage")) return json({}, 503);
      assert.equal(method, "POST");
      assert.equal(options.headers["x-upsert"], "false");
      assert.equal(state.objects.has(url.pathname), false);
      state.objects.set(url.pathname, Buffer.from(options.body));
      return json({ Key: url.pathname });
    }
    const name = url.pathname.replace("/rest/v1/", "");
    assert.ok(Object.hasOwn(tables, name), `Unexpected table ${name}`);
    if (state.faults.has(`${method}:${name}`)) return json({ error: "Injected failure" }, 503);
    const matches = (row) => [...url.searchParams].every(([key, value]) => {
      if (["select", "order", "limit"].includes(key)) return true;
      if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
      return true;
    });
    if (method === "GET") return json(tables[name].filter(matches));
    const fields = JSON.parse(options.body);
    if (method === "POST") {
      const row = { id: tables[name].length + 1, ...fields };
      tables[name].push(row);
      return json([row], 201);
    }
    assert.equal(method, "PATCH");
    const updated = tables[name].filter(matches);
    updated.forEach((row) => Object.assign(row, fields));
    return options.headers.Prefer?.includes("return=representation") ? json(updated) : new Response(null, { status: 204 });
  });
  const server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, body = Buffer.alloc(0), headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: "POST", headers }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text, data: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Info"], ["The reference is in the second sheet."]]), "Cover");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Reference", "Amount"], ...Array.from({ length: 30 }, (_, i) => [`Item ${i}`, i]), [marker, "1827.43"]]), "Pilot evidence");
  const file = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const upload = () => request(`/api/upload?t=${gateway.makeUploadToken(1, "sales", "operator")}`, file, { "x-file-name": "pilot-proof.xlsx", "content-type": "application/octet-stream" });
  const activate = () => gateway.activateByCode("local-knc-user", "TEST-KNC-LOCAL-ONLY");
  const run = (line = "local-knc-user", department = "sales") => request("/api/agent/run", JSON.stringify({ line_user_id: line, department, message: "What is the distinctive reference in my uploaded document?" }), apiHeaders);
  return { ...state, state, gateway, request, upload, activate, run, file };
}

test("Phase 1 document proof with simulated providers (not a live LINE/deployment proof)", async (t) => {
  await t.test("upload → KNC registration → activation → document answer → authorized persisted trace", async (t) => {
    const f = await fixture(t);
    const uploaded = await f.upload();
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.data.parsed, "parsed");
    f.state.documentCode = uploaded.data.doc_code;
    const document = f.tables.client_documents[0];
    assert.equal(document.client_account_id, 1);
    assert.equal(document.department, "sales");
    assert.equal(document.parsed_summary.source.sha256, crypto.createHash("sha256").update(f.file).digest("hex"));
    assert.deepEqual([...f.objects.values()][0], f.file);
    assert.equal((await f.activate()).ok, true);
    assert.equal(f.tables.activation_codes[0].used_count, 1);
    const answer = await f.run();
    assert.equal(answer.status, 200);
    assert.ok(answer.data.reply.includes(marker));
    assert.equal(answer.data.status, "completed");
    const run = f.tables.agent_runs.find((run) => run.id === answer.data.run_id);
    const trace = f.tables.tool_calls.find((call) => call.run_id === run.id);
    assert.equal(run.client_account_id, 1);
    assert.equal(trace.tool_name, "read_document");
    assert.equal(trace.allowed, true);
    assert.equal(trace.status, "success");
    assert.equal(trace.output.readable, true);
    assert.equal(trace.output.doc_code, document.doc_code);
    assert.equal(trace.output.content.sheet_data[1].rows[31][0], marker);
    assert.equal(f.requests.filter((request) => request.host === "api.line.me").length, 0);
  });

  await t.test("wrong client, unbound department, unactivated and revoked users cannot retrieve KNC content", async (t) => {
    const f = await fixture(t);
    f.state.documentCode = (await f.upload()).data.doc_code;
    assert.equal((await f.run()).status, 403);
    assert.equal(f.state.modelCalls, 0);
    await f.activate();
    assert.equal((await f.run("local-knc-user", "finance")).status, 403);
    f.tables.client_agent_bindings.push({ id: 2, line_user_id: "other-user", client_account_id: 2, department: "sales", status: "active" });
    const other = await f.run("other-user");
    assert.equal(other.status, 200);
    assert.equal(other.text.includes(marker), false);
    assert.deepEqual(f.tables.tool_calls.at(-1).output, { found: false });
    f.tables.client_agent_bindings[0].status = "revoked";
    assert.equal((await f.run()).status, 403);
  });

  await t.test("agent without read_document permission records blocked evidence and cannot return document data", async (t) => {
    const f = await fixture(t);
    f.state.documentCode = (await f.upload()).data.doc_code;
    await f.activate();
    f.tables.agent_registry[0].allowed_tools = [];
    const result = await f.run();
    assert.equal(result.status, 503);
    assert.equal(result.text.includes(marker), false);
    assert.equal(f.tables.tool_calls.at(-1).status, "blocked");
    assert.equal(f.tables.tool_calls.at(-1).allowed, false);
    assert.equal(f.requests.filter((r) => r.path === "/rest/v1/client_documents" && r.method === "GET").length, 0);
  });

  for (const target of ["GET:client_documents", "POST:tool_calls", "POST:agent_runs", "PATCH:agent_runs"]) {
    await t.test(`${target} failure never produces a completed run or a notification claim`, async (t) => {
      const f = await fixture(t);
      f.state.documentCode = (await f.upload()).data.doc_code;
      await f.activate();
      f.state.faults.add(target);
      const result = await f.run();
      assert.equal(result.status, 503);
      assert.equal(result.data.status, "error");
      assert.doesNotMatch(result.data.reply, /notified|informed|KNC-PILOT-/i);
      assert.equal(f.tables.agent_runs.some((run) => run.status === "completed"), false);
      if (target === "POST:tool_calls") assert.equal(f.state.modelCalls, 1, "Do not continue the model loop without persisted evidence");
    });
  }

  for (const target of ["POST:client_documents", "storage", "PATCH:client_documents"]) {
    await t.test(`${target} failure does not claim a confirmed upload`, async (t) => {
      const f = await fixture(t);
      f.state.faults.add(target);
      const result = await f.upload();
      assert.equal(result.status, 503);
      assert.equal(result.data.ok, undefined);
      if (target === "POST:client_documents") assert.equal(f.objects.size, 0);
      if (target === "PATCH:client_documents") {
        assert.equal(f.objects.size, 1, "Keep the original for recovery");
        assert.equal(f.tables.client_documents[0].parsed_status, "pending");
      }
    });
  }

  await t.test("concurrent uploads get different codes and preserve each original", async (t) => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 5 }, () => f.upload()));
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(new Set(results.map((result) => result.data.doc_code)).size, 5);
    assert.equal(f.objects.size, 5);
  });

  await t.test("invalid upload claims and nonexistent client cannot write storage", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request("/api/upload?t=invalid", f.file)).status, 403);
    assert.equal((await f.request(`/api/upload?t=${f.gateway.makeUploadToken(99, "sales", "operator")}`, f.file, { "x-file-name": "proof.xlsx", "content-type": "application/octet-stream" })).status, 403);
    assert.equal(f.objects.size, 0);
  });

  await t.test("rejected LINE replies and pushes are failures, not delivery receipts", async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.gateway.replyToLine("test-reply", "test"), /LINE reply rejected/);
    await assert.rejects(f.gateway.pushToLine("test-user", "test"), /LINE push rejected/);
  });
});

test("document extraction handles quoted CSV, source provenance and explicit partial/unsupported states", async () => {
  const { parseDocument } = require("../src/lib/document-parser");
  const csv = await parseDocument("values.csv", "text/csv", Buffer.from('reference,note,exact\n"A, B","first line\nsecond line","9007199254740993"'));
  assert.equal(csv.status, "parsed");
  assert.deepEqual(csv.summary.sample[0], ["A, B", "first line\nsecond line", "9007199254740993"]);
  assert.equal(csv.summary.sheet_data[0].first_row, 1);
  assert.equal((await parseDocument("long.txt", "text/plain", Buffer.from("x".repeat(31000)))).status, "partial");
  assert.equal((await parseDocument("broken.docx", "application/octet-stream", Buffer.from("not a docx"))).status, "failed");
  const pdf = await parseDocument("paper.pdf", "application/pdf", Buffer.from("%PDF"));
  assert.equal(pdf.status, "unsupported");
  assert.equal(pdf.summary.extraction_complete, false);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 520 }, (_, index) => [index])), "Large");
  const large = await parseDocument("large.xlsx", "application/octet-stream", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  assert.equal(large.status, "partial");
  assert.equal(large.rows, 520);
  assert.equal(large.summary.sheet_data[0].extracted_rows, 500);
});
