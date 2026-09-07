const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { equalSecret, supabaseHeaders } = require("../src/lib/security");

function loadGateway(overrides = {}) {
  Object.assign(process.env, {
    LINE_CHANNEL_SECRET: "test-line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "test-line-token",
    SUPABASE_URL: "https://example.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_test-only",
    GEMINI_API_KEY: "",
    FOUNDER_LINE_ID: "",
    JARVIS_ACTIVATION_CODE: "",
    NEUROHANDS_API_KEY: "test-api-secret",
    CRON_SECRET: "test-cron-secret",
    FALLBACK_PROVIDER: "groq",
    FALLBACK_API_KEY: "test-fallback-secret",
    FALLBACK_BASE_URL: "https://example.invalid/v1",
    FALLBACK_MODEL: "test-model",
    FALLBACK_MODELS: "",
    ...overrides,
  });
  delete require.cache[require.resolve("../src/server")];
  return require("../src/server");
}

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return (path, { method = "GET", headers = {}, body = "" } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path, method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("gateway regression checks (all external services mocked)", async (t) => {
  const blockedFetch = () => { throw new Error("Unexpected external request during local test"); };
  t.mock.method(globalThis, "fetch", blockedFetch);

  await t.test("missing secrets disable admin and cron routes, and unsigned uploads", async (t) => {
    const { app } = loadGateway({ NEUROHANDS_API_KEY: "", CRON_SECRET: "", LINE_CHANNEL_SECRET: "" });
    const request = await serve(t, app);
    for (const headers of [{}, { "x-api-key": "anything", "x-cron-secret": "anything" }]) {
      assert.equal((await request("/api/agent/run", { method: "POST", headers })).status, 401);
      assert.equal((await request("/cron/daily", { method: "POST", headers })).status, 401);
    }
    assert.equal((await request("/upload?t=abc.def")).status, 403);
    assert.equal((await request("/api/upload?t=abc.def", { method: "POST" })).status, 403);
    assert.equal((await request("/")).status, 200);
  });

  await t.test("configured credentials reject wrong keys and accept valid keys", async (t) => {
    const { app } = loadGateway();
    const request = await serve(t, app);
    assert.equal((await request("/api/agent/run", { method: "POST", headers: { "x-api-key": "wrong" } })).status, 401);
    assert.equal((await request("/cron/daily", { method: "POST", headers: { "x-cron-secret": "wrong" } })).status, 401);
    assert.equal((await request("/api/agent/run", { method: "POST", headers: { "x-api-key": "test-api-secret" } })).status, 400);
    t.mock.method(globalThis, "fetch", async (url) => {
      assert.match(String(url), /^https:\/\/example\.invalid\/rest\/v1\//);
      return new Response("[]", { status: 200 });
    });
    assert.equal((await request("/cron/daily", { method: "POST", headers: { "x-cron-secret": "test-cron-secret" } })).status, 200);
  });

  await t.test("LINE webhook accepts only the correct raw-body signature", async (t) => {
    const request = await serve(t, loadGateway().app);
    const body = JSON.stringify({ events: [] });
    const headers = { "content-type": "application/json" };
    assert.equal((await request("/webhook", { method: "POST", headers, body })).status, 403);
    headers["x-line-signature"] = crypto.createHmac("sha256", "test-line-secret").update(body).digest("base64");
    assert.equal((await request("/webhook", { method: "POST", headers, body })).status, 200);
    assert.equal((await request("/webhook", { method: "POST", headers, body: body + " " })).status, 403);
  });

  await t.test("upload links reject tampering, expiration and malformed claims", async (t) => {
    const gateway = loadGateway();
    const request = await serve(t, gateway.app);
    const token = gateway.makeUploadToken(42, "sales", "test-user");
    assert.equal((await request(`/upload?t=${token}`)).status, 200);
    assert.equal((await request(`/upload?t=${token}tampered`)).status, 403);
    assert.equal(gateway.checkUploadToken(token + ".extra"), null);
    const sign = (payload) => Buffer.from(payload).toString("base64url") + "." + crypto.createHmac("sha256", "test-line-secret").update(payload).digest("hex");
    for (const payload of ["42|sales|0|test-user", "42|sales|NaN|test-user", `invalid|sales|${Date.now() + 60000}|test-user`]) {
      assert.equal(gateway.checkUploadToken(sign(payload)), null);
    }
  });

  await t.test("fallback receives the agent system instructions", async (t) => {
    const gateway = loadGateway();
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.messages[0], { role: "system", content: "Use only this customer's data." });
      assert.equal(body.messages[1].content, "Hello");
      return new Response(JSON.stringify({ choices: [{ message: { content: "Hello back" } }] }));
    });
    const result = await gateway.runOpenAIToolLoop("Use only this customer's data.", "Hello", [], {}, null);
    assert.equal(result.text, "Hello back");
  });

  await t.test("restored document parser handles CSV and the updated Excel dependency", async () => {
    const { parseDocument } = loadGateway();
    const csv = await parseDocument("sample.csv", "text/csv", Buffer.from("product,quantity\nGlass,2"));
    assert.equal(csv.status, "parsed");
    assert.equal(csv.rows, 2);
    const XLSX = require("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["product", "quantity"], ["Glass", 2]]), "Orders");
    const excel = await parseDocument("sample.xlsx", "application/octet-stream", XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
    assert.equal(excel.status, "parsed");
    assert.deepEqual(excel.summary.headers, ["product", "quantity"]);
    assert.deepEqual(excel.summary.sample, [["Glass", 2]]);
    assert.equal((await parseDocument("sample.pdf", "application/pdf", Buffer.from("%PDF"))).status, "unsupported");
  });
});

test("secret comparison and modern/legacy Supabase headers", () => {
  assert.equal(equalSecret("", ""), false);
  assert.equal(equalSecret("secret", undefined), false);
  assert.equal(equalSecret("secret", "different"), false);
  assert.equal(equalSecret("secret", "secret"), true);
  assert.deepEqual(supabaseHeaders("sb_secret_test-only"), { apikey: "sb_secret_test-only" });
  assert.deepEqual(supabaseHeaders("legacy-test-jwt"), { apikey: "legacy-test-jwt", Authorization: "Bearer legacy-test-jwt" });
  assert.throws(() => supabaseHeaders(""), /required/);
});
