const { test } = require("node:test");
const assert = require("node:assert/strict");

const PRIVATE_MARKER = "fixture-private-value-never-log";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const answer = (text = "Recovered answer") => json({ choices: [{ message: { content: text } }] });
const geminiAnswer = (text) => json({ candidates: [{ content: { parts: [{ text }] } }] });
const schema = { name: "request_human", parameters: { type: "object", properties: {} } };

function loadGateway(t, overrides = {}) {
  const values = {
    GEMINI_API_KEY: PRIVATE_MARKER, GEMINI_ENABLED: "true", GEMINI_MODEL: "fixture-gemini",
    FALLBACK_API_KEY: PRIVATE_MARKER, FALLBACK_PROVIDER: "groq",
    FALLBACK_BASE_URL: "https://fallback.invalid", FALLBACK_MODELS: "first,second", FALLBACK_MODEL: "",
    SUPABASE_URL: "https://database.invalid", SUPABASE_SERVICE_KEY: "sb_secret_fixture",
    ENABLE_STUDIO: "false", ...overrides,
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[require.resolve("../src/server")];
  });
  delete require.cache[require.resolve("../src/server")];
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const metrics = [];
  t.mock.method(console, "info", (label, detail) => metrics.push({ label, ...JSON.parse(detail) }));
  return { gateway: require("../src/server"), logs, metrics };
}

function shortTimeout(t) {
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 15000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException(PRIVATE_MARKER, "TimeoutError")), 2);
    return controller.signal;
  });
}

const primaryFailures = {
  timeout: (_url, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason);
    else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }),
  transport: () => { throw new TypeError(PRIVATE_MARKER); },
  invalid_json: () => new Response(PRIVATE_MARKER),
  malformed_parts: () => json({ candidates: [{ content: { parts: { text: PRIVATE_MARKER } } }] }),
  malformed_tool: () => json({ candidates: [{ content: { parts: [{ functionCall: { name: "request_human", args: [] } }] } }] }),
  empty_answer: () => geminiAnswer("   "),
  http_error: () => json({ error: PRIVATE_MARKER }, 429),
};

for (const [status, code] of [[401, "invalid_api_key"], [429, "credit_balance_exhausted"], [429, "project_spend_limit_exceeded"]]) {
  test(`account-wide ${code} stops model cascade and later requests until restart`, async (t) => {
    const { gateway, logs } = loadGateway(t, { GEMINI_ENABLED: "false", FALLBACK_MODELS: "one,two,three" });
    let count = 0;
    t.mock.method(globalThis, "fetch", async () => {
      count++;
      return json({ error: { code, message: PRIVATE_MARKER } }, status);
    });
    assert.equal(await gateway.askAI("Policy", "First"), null);
    assert.equal(await gateway.askAI("Policy", "Second"), null);
    assert.equal(count, 1, "Do not try other models or another message with the same rejected account");
    assert.equal(logs.some(line => line.includes(PRIVATE_MARKER)), false);
  });
}

test("a paused primary account still permits a separately configured fallback", async (t) => {
  const { gateway } = loadGateway(t);
  let primary = 0, fallback = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (new URL(url).hostname === "generativelanguage.googleapis.com") {
      primary++;
      return json({ error: { code: "insufficient_quota" } }, 429);
    }
    fallback++;
    return answer();
  });
  assert.equal(await gateway.askAI("Policy", "First"), "Recovered answer");
  assert.equal(await gateway.askAI("Policy", "Second"), "Recovered answer");
  assert.equal(primary, 1);
  assert.equal(fallback, 2);
});

test("LLM recovery uses mocked providers only", async (t) => {
  await t.test("Gemini remains the primary when the enable flag is absent", async (t) => {
    const { gateway } = loadGateway(t, { GEMINI_ENABLED: undefined });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
      calls++;
      assert.equal(new URL(url).hostname, "generativelanguage.googleapis.com");
      return geminiAnswer("Primary answer");
    });
    assert.equal(await gateway.askAI("Policy", "Question"), "Primary answer");
    assert.equal(calls, 1);
  });

  await t.test("disabled Gemini retains its key but plain answers use only the fallback", async (t) => {
    const { gateway, metrics } = loadGateway(t, { GEMINI_ENABLED: " false " });
    const hosts = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      hosts.push(new URL(url).hostname);
      assert.equal(new URL(url).hostname, "fallback.invalid");
      return answer();
    });
    assert.equal(await gateway.askAI("Policy", "Question"), "Recovered answer");
    assert.equal(process.env.GEMINI_API_KEY, PRIVATE_MARKER);
    assert.deepEqual(hosts, ["fallback.invalid"]);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].provider, "custom");
  });

  await t.test("disabled Gemini lets Aria complete an authorized fallback document-tool exchange", async (t) => {
    const { gateway } = loadGateway(t, { GEMINI_ENABLED: "false" });
    const modelHosts = [];
    const toolRecords = [];
    let completed;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "fallback.invalid") {
        modelHosts.push(address.hostname);
        const body = JSON.parse(options.body);
        if (modelHosts.length === 1) {
          assert.equal(body.tools[0].function.name, "read_document");
          return json({ choices: [{ message: { tool_calls: [
            { id: "fixture-read", function: { name: "read_document", arguments: JSON.stringify({ doc_code: "FIXTURE-DOC" }) } },
          ] } }] });
        }
        const result = JSON.parse(body.messages.at(-1).content);
        assert.equal(result.readable, true);
        assert.equal(result.content.text, "Fixture document answer");
        return answer("Fixture document answer");
      }
      assert.equal(address.hostname, "database.invalid", "Disabled Gemini must never receive a request");
      switch (address.pathname) {
        case "/rest/v1/client_agent_bindings": return json([{ client_account_id: 1, department: "sales" }]);
        case "/rest/v1/client_accounts": return json([{ id: 1, active: true }]);
        case "/rest/v1/agent_memory": return json([]);
        case "/rest/v1/client_documents":
          assert.equal(address.searchParams.get("client_account_id"), "eq.1");
          assert.equal(address.searchParams.get("department"), "eq.sales");
          assert.equal(address.searchParams.get("doc_code"), "eq.FIXTURE-DOC");
          return json([{ doc_code: "FIXTURE-DOC", parsed_status: "parsed", parsed_summary: { text: "Fixture document answer", extraction_complete: true } }]);
        case "/rest/v1/tool_calls":
          toolRecords.push(JSON.parse(options.body));
          return json([{ id: 2 }]);
        case "/rest/v1/agent_runs":
          if (options.method === "PATCH") completed = JSON.parse(options.body);
          return json([{ id: 1 }]);
        default: throw new Error("Unexpected fixture request");
      }
    });
    const ctx = { lineUserId: "fixture-client", clientAccountId: 1, department: "sales" };
    const agent = { agent_code: "AGT-001", allowed_tools: ["read_document"], domains: [], responsibilities: [] };
    assert.equal(await gateway.runAgent(ctx, "Read my document", agent), "Fixture document answer");
    assert.deepEqual(modelHosts, ["fallback.invalid", "fallback.invalid"]);
    assert.equal(toolRecords.length, 1);
    assert.equal(toolRecords[0].allowed, true);
    assert.equal(toolRecords[0].status, "success");
    assert.equal(completed.status, "completed");
    assert.equal(ctx.runStatus, "completed");
    assert.equal(process.env.GEMINI_API_KEY, PRIVATE_MARKER);
  });

  for (const [reason, fail] of Object.entries(primaryFailures)) {
    await t.test(`plain Gemini ${reason} falls through to fallback without exposing private data`, async (t) => {
      const { gateway, logs } = loadGateway(t);
      if (reason === "timeout") shortTimeout(t);
      const hosts = [];
      t.mock.method(globalThis, "fetch", async (url, options) => {
        const host = new URL(url).hostname;
        hosts.push(host);
        if (host === "generativelanguage.googleapis.com") {
          assert.equal(new URL(url).search, "");
          assert.equal(options.headers["x-goog-api-key"], PRIVATE_MARKER);
          return fail(url, options);
        }
        assert.equal(host, "fallback.invalid");
        const body = JSON.parse(options.body);
        assert.deepEqual(body.messages, [
          { role: "system", content: PRIVATE_MARKER }, { role: "user", content: "Business question" },
        ]);
        return answer();
      });
      assert.equal(await gateway.askAI(PRIVATE_MARKER, "Business question"), "Recovered answer");
      assert.deepEqual(hosts, ["generativelanguage.googleapis.com", "fallback.invalid"]);
      assert.equal(logs.some((line) => line.includes(PRIVATE_MARKER)), false);
      assert.ok(logs.some((line) => line.startsWith("Gemini request failed")));
    });
  }

  for (const [reason, fail] of Object.entries(primaryFailures)) {
    await t.test(`Gemini tool loop ${reason} returns a fallback signal`, async (t) => {
      const { gateway, logs } = loadGateway(t);
      if (reason === "timeout") shortTimeout(t);
      t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(new URL(url).hostname, "generativelanguage.googleapis.com");
        assert.equal(new URL(url).search, "");
        assert.equal(options.headers["x-goog-api-key"], PRIVATE_MARKER);
        return fail(url, options);
      });
      const result = await gateway.askGeminiWithTools(PRIVATE_MARKER, "Question", [schema], { allowedTools: [schema.name] }, 1);
      assert.equal(result.apiFailed, true);
      assert.equal(result.text, null);
      assert.equal(logs.some((line) => line.includes(PRIVATE_MARKER)), false);
    });
  }

  await t.test("fallback skips failed, malformed and empty answers; only usable models become cached", async (t) => {
    const { gateway, logs } = loadGateway(t, { GEMINI_API_KEY: "", FALLBACK_MODELS: "transport,json,empty,good" });
    const models = [];
    let secondRequest = false;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(new URL(url).hostname, "fallback.invalid");
      const model = JSON.parse(options.body).model;
      models.push(model);
      if (secondRequest) {
        if (model === "good") throw new TypeError(PRIVATE_MARKER);
        return answer("Replacement model");
      }
      if (model === "transport") throw new TypeError(PRIVATE_MARKER);
      if (model === "json") return new Response(PRIVATE_MARKER);
      if (model === "empty") return answer(" ");
      return answer();
    });
    assert.equal(await gateway.askAI("Policy", "Question"), "Recovered answer");
    assert.deepEqual(models, ["transport", "json", "empty", "good"]);
    secondRequest = true;
    assert.equal(await gateway.askAI("Policy", "Question"), "Replacement model");
    assert.deepEqual(models.slice(4), ["good", "transport"]);
    assert.equal(logs.some((line) => line.includes(PRIVATE_MARKER)), false);
  });

  await t.test("malformed tool arguments are rejected before any tool can execute", async (t) => {
    const { gateway } = loadGateway(t, { GEMINI_API_KEY: "" });
    const models = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(new URL(url).hostname, "fallback.invalid");
      const model = JSON.parse(options.body).model;
      models.push(model);
      if (model === "first") return json({ choices: [{ message: { tool_calls: [
        { id: "bad-call", function: { name: "request_human", arguments: "{broken" } },
      ] } }] });
      return answer();
    });
    const result = await gateway.runOpenAIToolLoop("Policy", "Question", [schema], { allowedTools: [schema.name] }, 1);
    assert.equal(result.text, "Recovered answer");
    assert.deepEqual(models, ["first", "second"]);
  });

  await t.test("valid Gemini tool requests still respect authorization", async (t) => {
    const { gateway } = loadGateway(t);
    let modelCalls = 0;
    const persisted = [];
    const ctx = { allowedTools: [], agentCode: "AGT-001" };
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        modelCalls++;
        if (modelCalls === 1) return json({ candidates: [{ content: { parts: [
          { functionCall: { name: "request_human", args: {} } },
        ] } }] });
        assert.equal(JSON.parse(options.body).contents.at(-1).parts[0].functionResponse.response.content.error,
          "Tool request_human not permitted.");
        return geminiAnswer("Request unavailable");
      }
      assert.equal(address.hostname, "database.invalid");
      assert.equal(address.pathname, "/rest/v1/tool_calls", "A blocked call must never reach the business tool");
      persisted.push(JSON.parse(options.body));
      return json([{ id: 1 }]);
    });
    const result = await gateway.askGeminiWithTools("Policy", "Question", [schema], ctx, 1);
    assert.equal(result.text, "Request unavailable");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].allowed, false);
    assert.equal(persisted[0].status, "blocked");
    assert.equal(ctx.toolFailed, true);
  });

  await t.test("Aria completes through fallback after Gemini transport failure", async (t) => {
    const { gateway } = loadGateway(t);
    const modelHosts = [];
    let completed;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        modelHosts.push(address.hostname);
        throw new TypeError(PRIVATE_MARKER);
      }
      if (address.hostname === "fallback.invalid") { modelHosts.push(address.hostname); return answer(); }
      assert.equal(address.hostname, "database.invalid");
      switch (address.pathname) {
        case "/rest/v1/client_agent_bindings": return json([{ client_account_id: 1, department: "sales" }]);
        case "/rest/v1/client_accounts": return json([{ id: 1, active: true }]);
        case "/rest/v1/agent_memory": return json([]);
        case "/rest/v1/agent_runs":
          if (options.method === "PATCH") completed = JSON.parse(options.body);
          return json([{ id: 1 }]);
        default: throw new Error("Unexpected fixture request");
      }
    });
    const ctx = { lineUserId: "fixture-client", clientAccountId: 1, department: "sales" };
    const agent = { agent_code: "AGT-001", allowed_tools: [], domains: [], responsibilities: [] };
    assert.equal(await gateway.runAgent(ctx, "Business question", agent), "Recovered answer");
    assert.deepEqual(modelHosts, ["generativelanguage.googleapis.com", "fallback.invalid"]);
    assert.equal(completed.status, "completed");
    assert.equal(ctx.runStatus, "completed");
  });

  await t.test("tool evidence failures remain failures and are not mistaken for provider outages", async (t) => {
    const { gateway } = loadGateway(t);
    let modelCalls = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        modelCalls++;
        return json({ candidates: [{ content: { parts: [{ functionCall: { name: "request_human", args: {} } }] } }] });
      }
      assert.equal(address.hostname, "database.invalid");
      assert.equal(address.pathname, "/rest/v1/tool_calls");
      return json({ error: PRIVATE_MARKER }, 503);
    });
    await assert.rejects(gateway.askGeminiWithTools("Policy", "Question", [schema], { allowedTools: [] }, 1),
      /Database operation failed/);
    assert.equal(modelCalls, 1);
  });

  await t.test("all failed models return no answer instead of escaping into the LINE handler", async (t) => {
    const { gateway } = loadGateway(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; throw new TypeError(PRIVATE_MARKER); });
    assert.equal(await gateway.askAI("Policy", "Question"), null);
    assert.equal(requests, 3);
    const failed = await gateway.askGeminiWithTools("Policy", "Question", [], {}, 1);
    assert.equal(failed.apiFailed, true);
    assert.equal(failed.text, null);
  });

  await t.test("model measurements contain numeric provider usage and elapsed time, never response content", async (t) => {
    const { gateway, metrics } = loadGateway(t);
    let primary = true;
    t.mock.method(globalThis, "fetch", async (url) => {
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        if (!primary) return json({}, 503);
        return json({ candidates: [{ content: { parts: [{ text: PRIVATE_MARKER }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 23 } });
      }
      return json({ choices: [{ message: { content: PRIVATE_MARKER } }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } });
    });
    assert.equal(await gateway.askAI(PRIVATE_MARKER, PRIVATE_MARKER), PRIVATE_MARKER);
    primary = false;
    assert.equal(await gateway.askAI(PRIVATE_MARKER, PRIVATE_MARKER), PRIVATE_MARKER);
    assert.deepEqual(metrics.map(({ input_tokens, output_tokens, total_tokens }) =>
      [input_tokens, output_tokens, total_tokens]), [[12, 7, 23], [15, 5, 20]]);
    assert.ok(metrics.every((metric) => Number.isInteger(metric.elapsed_ms) && metric.elapsed_ms >= 0));
    assert.equal(JSON.stringify(metrics).includes(PRIVATE_MARKER), false);
  });

  await t.test("missing or invalid provider usage remains unavailable rather than zero", async (t) => {
    const { gateway, metrics } = loadGateway(t, { GEMINI_API_KEY: "" });
    t.mock.method(globalThis, "fetch", async () => json({ choices: [{ message: { content: "Answer" } }],
      usage: { prompt_tokens: -1, completion_tokens: PRIVATE_MARKER } }));
    assert.equal(await gateway.askAI("Policy", "Question"), "Answer");
    assert.equal(metrics[0].input_tokens, null);
    assert.equal(metrics[0].output_tokens, null);
    assert.equal(metrics[0].total_tokens, null);
    assert.equal(JSON.stringify(metrics).includes(PRIVATE_MARKER), false);
  });
});
