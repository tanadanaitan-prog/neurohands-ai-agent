const { test } = require("node:test");
const assert = require("node:assert/strict");

const PRIVATE_MARKER = "fixture-private-value-never-log";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function loadGateway(t, overrides = {}) {
  const values = {
    GEMINI_API_KEY: PRIVATE_MARKER, GEMINI_ENABLED: "true", GEMINI_MODEL: "gemini-3.6-flash",
    FALLBACK_API_KEY: "", FALLBACK_PROVIDER: "", FALLBACK_BASE_URL: "", FALLBACK_MODELS: "",
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

test("Gemini thinkingConfig is sent only for gemini-3 and later", async (t) => {
  await t.test("gemini-2.5-flash request has NO thinkingConfig", async (t) => {
    const { gateway } = loadGateway(t, { GEMINI_MODEL: "gemini-2.5-flash" });
    const requests = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);
        return json({ candidates: [{ content: { parts: [{ text: "Answer" }] } }] });
      }
      assert.equal(address.hostname, "database.invalid");
      if (address.pathname === "/rest/v1/staff_activations") return json([{ role: "admin" }]);
      if (address.pathname === "/rest/v1/jarvis_notes") return json([]);
      if (address.pathname === "/rest/v1/agent_runs") return json([{ id: 1 }]);
      if (address.pathname === "/rest/v1/jarvis_audit_log") return json([{ id: 1 }]);
      throw new Error(`Unexpected: ${address.pathname}`);
    });

    const ctx = { lineUserId: "fixture-operator" };
    await gateway.runJarvis(ctx, "Test");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].generationConfig.thinkingConfig, undefined, "gemini-2.5-flash should NOT have thinkingConfig");
  });

  await t.test("gemini-3.6-flash request has thinkingLevel LOW", async (t) => {
    const { gateway } = loadGateway(t, { GEMINI_MODEL: "gemini-3.6-flash" });
    const requests = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);
        return json({ candidates: [{ content: { parts: [{ text: "Answer" }] } }] });
      }
      assert.equal(address.hostname, "database.invalid");
      if (address.pathname === "/rest/v1/staff_activations") return json([{ role: "admin" }]);
      if (address.pathname === "/rest/v1/jarvis_notes") return json([]);
      if (address.pathname === "/rest/v1/agent_runs") return json([{ id: 1 }]);
      if (address.pathname === "/rest/v1/jarvis_audit_log") return json([{ id: 1 }]);
      throw new Error(`Unexpected: ${address.pathname}`);
    });

    const ctx = { lineUserId: "fixture-operator" };
    await gateway.runJarvis(ctx, "Test");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].generationConfig.thinkingConfig.thinkingLevel, "LOW", "gemini-3.6-flash should have LOW thinking");
  });
});

test("Gemini empty final answer after tools triggers tool-free retry and records error code", async (t) => {
  await t.test("Jarvis with tool call then empty MAX_TOKENS response retries with mode NONE", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];
    const toolRecords = [];
    const completions = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          // First call: return one tool call
          return json({
            candidates: [{ content: { parts: [
              { functionCall: { name: "list_clients", args: {} } },
            ] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
          });
        }

        if (requests.length === 2) {
          // Second call after tools: empty text with MAX_TOKENS and thoughtSignature
          return json({
            candidates: [{ content: { parts: [
              { thoughtSignature: "fixture-thought-hash-preserved" },
            ] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0, thoughtsTokenCount: 1170 },
          });
        }

        if (requests.length === 3) {
          // Third call: tool-free retry with mode NONE, still empty
          return json({
            candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0, thoughtsTokenCount: 1200 },
          });
        }
      }

      // Database mocks for Jarvis
      assert.equal(address.hostname, "database.invalid");
      const query = address.pathname + address.search;
      if (query.startsWith("/rest/v1/staff_activations")) return json([{ role: "admin" }]);
      if (query.startsWith("/rest/v1/jarvis_notes")) {
        if (options.method === "POST") return json([{ id: 1 }]);
        return json([]);
      }
      if (query.startsWith("/rest/v1/client_accounts")) return json([{ client_code: "KNC", company: "Test Co" }]);
      if (query.startsWith("/rest/v1/orders")) return json([]);
      if (query.startsWith("/rest/v1/support_cases")) return json([]);
      if (query.startsWith("/rest/v1/agent_tasks")) return json([]);
      if (query.startsWith("/rest/v1/jarvis_checklist")) return json([]);
      if (query.startsWith("/rest/v1/bot_feedback")) return json([]);
      if (query.startsWith("/rest/v1/messages")) return json([]);
      if (query.startsWith("/rest/v1/tool_calls")) {
        toolRecords.push(JSON.parse(options.body));
        return json([{ id: toolRecords.length }]);
      }
      if (query.startsWith("/rest/v1/agent_runs")) {
        if (options.method === "PATCH") completions.push(JSON.parse(options.body));
        return json([{ id: 42 }]);
      }
      if (query.startsWith("/rest/v1/jarvis_audit_log")) return json([{ id: 1 }]);
      throw new Error(`Unexpected fixture request: ${query}`);
    });

    const ctx = { lineUserId: "fixture-operator" };
    const reply = await gateway.runJarvis(ctx, "List clients and status");

    // Verify all requests had thinkingLevel: LOW
    assert.equal(requests.length, 3);
    requests.forEach((req, i) => {
      assert.equal(req.generationConfig.thinkingConfig.thinkingLevel, "LOW", 
        `Request ${i + 1} must have thinkingLevel LOW`);
    });

    // Verify first request has tools
    assert.ok(requests[0].tools);
    assert.equal(requests[0].toolConfig, undefined);

    // Verify second request has tools (after tool responses)
    assert.ok(requests[1].tools);
    assert.equal(requests[1].toolConfig, undefined);

    // Verify third request has mode NONE (retry)
    assert.equal(requests[2].toolConfig.functionCallingConfig.mode, "NONE");

    // Verify tool ran
    assert.equal(toolRecords.length, 1);
    assert.equal(toolRecords[0].tool_name, "list_clients");

    // Verify error was recorded with correct code
    assert.equal(completions.length, 1, "Should have exactly one completion record");
    const completed = completions[0];
    assert.equal(completed.status, "error");
    assert.equal(completed.error, "empty_final_max_tokens");

    // Verify llm_metrics includes finish_reason and thoughts_token_count
    const metrics = completed.llm_metrics;
    assert.ok(metrics.attempts, "Should have attempts array");
    assert.ok(metrics.attempts.length >= 2, "Should have at least 2 attempts (tool call + empty final)");
    const emptyFinalAttempt = metrics.attempts[1];
    assert.equal(emptyFinalAttempt.finish_reason, "MAX_TOKENS", "Empty final attempt should have MAX_TOKENS finish_reason");
    assert.equal(emptyFinalAttempt.thoughts_token_count, 1170, "Empty final attempt should record 1170 thoughts_token_count");

    // Verify user-facing reply mentions the issue
    assert.match(reply, /could not verify/i);
  });

  await t.test("Jarvis retry succeeds on second attempt with mode NONE", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          return json({
            candidates: [{ content: { parts: [
              { functionCall: { name: "list_clients", args: {} } },
            ] } }],
          });
        }

        if (requests.length === 2) {
          // Empty response after tool
          return json({
            candidates: [{ content: { parts: [
              { thoughtSignature: "preserved-hash" },
            ] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { thoughtsTokenCount: 1170 },
          });
        }

        if (requests.length === 3) {
          // Retry succeeds
          return json({
            candidates: [{ content: { parts: [{ text: "The clients are listed above." }] } }],
          });
        }
      }

      assert.equal(address.hostname, "database.invalid");
      switch (address.pathname) {
        case "/rest/v1/staff_activations":
          return json([{ role: "admin" }]);
        case "/rest/v1/jarvis_notes":
          return json([]);
        case "/rest/v1/client_accounts":
          return json([{ client_code: "KNC", company: "Test Co" }]);
        case "/rest/v1/agent_runs":
          return json([{ id: 50 }]);
        case "/rest/v1/tool_calls":
          return json([{ id: 1 }]);
        case "/rest/v1/jarvis_audit_log":
          return json([{ id: 1 }]);
        default:
          throw new Error(`Unexpected: ${address.pathname}`);
      }
    });

    const ctx = { lineUserId: "fixture-operator" };
    const reply = await gateway.runJarvis(ctx, "List clients");

    assert.equal(requests.length, 3);
    assert.equal(requests[2].toolConfig.functionCallingConfig.mode, "NONE");
    assert.equal(reply, "The clients are listed above.");
  });

  await t.test("runAgent with read_document after empty final triggers retry", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];
    const toolRecords = [];
    let completed;

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          return json({
            candidates: [{ content: { parts: [
              { functionCall: { name: "read_document", args: { doc_code: "TEST-DOC-001" } } },
            ] } }],
          });
        }

        if (requests.length === 2) {
          // Empty response with thoughts
          return json({
            candidates: [{ content: { parts: [
              { thoughtSignature: "hash-preserved" },
            ] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { thoughtsTokenCount: 1180 },
          });
        }

        if (requests.length === 3) {
          // Retry also empty
          return json({
            candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { thoughtsTokenCount: 1190 },
          });
        }
      }

      assert.equal(address.hostname, "database.invalid");
      switch (address.pathname) {
        case "/rest/v1/client_agent_bindings":
          return json([{ client_account_id: 1, department: "sales" }]);
        case "/rest/v1/client_accounts":
          return json([{ id: 1, active: true }]);
        case "/rest/v1/agent_memory":
          return json([]);
        case "/rest/v1/client_documents":
          return json([{ doc_code: "TEST-DOC-001", parsed_status: "parsed", 
            parsed_summary: { text: "Document content", extraction_complete: true } }]);
        case "/rest/v1/tool_calls":
          toolRecords.push(JSON.parse(options.body));
          return json([{ id: toolRecords.length }]);
        case "/rest/v1/agent_runs":
          if (options.method === "PATCH") completed = JSON.parse(options.body);
          return json([{ id: 100 }]);
        default:
          throw new Error(`Unexpected: ${address.pathname}`);
      }
    });

    const ctx = { lineUserId: "fixture-client", clientAccountId: 1, department: "sales" };
    const agent = { agent_code: "AGT-001", allowed_tools: ["read_document"], domains: [], responsibilities: [] };
    const reply = await gateway.runAgent(ctx, "Read TEST-DOC-001", agent);

    // Verify thinkingLevel LOW in all requests
    assert.equal(requests.length, 3);
    requests.forEach((req, i) => {
      assert.equal(req.generationConfig.thinkingConfig.thinkingLevel, "LOW",
        `Request ${i + 1} must have LOW thinking`);
    });

    // Verify mode NONE on retry
    assert.equal(requests[2].toolConfig.functionCallingConfig.mode, "NONE");

    // Verify tool ran exactly once
    assert.equal(toolRecords.length, 1);
    assert.equal(toolRecords[0].tool_name, "read_document");

    // Verify error code
    assert.equal(completed.status, "error");
    assert.equal(completed.error, "empty_final_max_tokens");
    assert.match(reply, /could not complete/i);
  });

  await t.test("normal reply makes one call with no retry", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);
        return json({
          candidates: [{ content: { parts: [{ text: "Normal answer" }] } }],
        });
      }

      assert.equal(address.hostname, "database.invalid");
      switch (address.pathname) {
        case "/rest/v1/staff_activations":
          return json([{ role: "admin" }]);
        case "/rest/v1/jarvis_notes":
          return json([]);
        case "/rest/v1/agent_runs":
          return json([{ id: 200 }]);
        case "/rest/v1/jarvis_audit_log":
          return json([{ id: 1 }]);
        default:
          throw new Error(`Unexpected: ${address.pathname}`);
      }
    });

    const ctx = { lineUserId: "fixture-operator" };
    const reply = await gateway.runJarvis(ctx, "What is the status?");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].generationConfig.thinkingConfig.thinkingLevel, "LOW");
    assert.equal(reply, "Normal answer");
  });

  await t.test("thoughtSignature parts are preserved unchanged in tool responses", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          return json({
            candidates: [{ content: { parts: [
              { thoughtSignature: "first-signature-hash" },
              { functionCall: { name: "list_clients", args: {} } },
            ] } }],
          });
        }

        if (requests.length === 2) {
          // Verify thoughtSignature was sent back unchanged
          const modelParts = body.contents.find(c => c.role === "model")?.parts;
          assert.ok(modelParts);
          assert.equal(modelParts[0].thoughtSignature, "first-signature-hash");
          
          return json({
            candidates: [{ content: { parts: [{ text: "Client list complete" }] } }],
          });
        }
      }

      assert.equal(address.hostname, "database.invalid");
      switch (address.pathname) {
        case "/rest/v1/staff_activations":
          return json([{ role: "admin" }]);
        case "/rest/v1/jarvis_notes":
          return json([]);
        case "/rest/v1/client_accounts":
          return json([{ client_code: "KNC", company: "Test Co" }]);
        case "/rest/v1/agent_runs":
          return json([{ id: 300 }]);
        case "/rest/v1/tool_calls":
          return json([{ id: 1 }]);
        case "/rest/v1/jarvis_audit_log":
          return json([{ id: 1 }]);
        default:
          throw new Error(`Unexpected: ${address.pathname}`);
      }
    });

    const ctx = { lineUserId: "fixture-operator" };
    const reply = await gateway.runJarvis(ctx, "List clients");

    assert.equal(requests.length, 2);
    assert.equal(reply, "Client list complete");
  });

  await t.test("empty response with only whitespace text triggers retry", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          return json({
            candidates: [{ content: { parts: [
              { functionCall: { name: "list_clients", args: {} } },
            ] } }],
          });
        }

        if (requests.length === 2) {
          // Only whitespace text
          return json({
            candidates: [{ content: { parts: [{ text: "   " }] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { thoughtsTokenCount: 1150 },
          });
        }

        if (requests.length === 3) {
          return json({
            candidates: [{ content: { parts: [{ text: "Recovered" }] } }],
          });
        }
      }

      assert.equal(address.hostname, "database.invalid");
      switch (address.pathname) {
        case "/rest/v1/staff_activations":
          return json([{ role: "admin" }]);
        case "/rest/v1/jarvis_notes":
          return json([]);
        case "/rest/v1/client_accounts":
          return json([{ client_code: "KNC", company: "Test Co" }]);
        case "/rest/v1/agent_runs":
          return json([{ id: 400 }]);
        case "/rest/v1/tool_calls":
          return json([{ id: 1 }]);
        case "/rest/v1/jarvis_audit_log":
          return json([{ id: 1 }]);
        default:
          throw new Error(`Unexpected: ${address.pathname}`);
      }
    });

    const ctx = { lineUserId: "fixture-operator" };
    const reply = await gateway.runJarvis(ctx, "List clients");

    assert.equal(requests.length, 3);
    assert.equal(requests[2].toolConfig.functionCallingConfig.mode, "NONE");
    assert.equal(reply, "Recovered");
  });

  await t.test("empty final with finishReason STOP records empty_final error code", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];
    const completions = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          return json({
            candidates: [{ content: { parts: [
              { functionCall: { name: "list_clients", args: {} } },
            ] } }],
          });
        }

        if (requests.length === 2) {
          return json({
            candidates: [{ content: { parts: [
              { thoughtSignature: "hash" },
            ] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0, thoughtsTokenCount: 800 },
          });
        }

        if (requests.length === 3) {
          return json({
            candidates: [{ content: { parts: [{ thoughtSignature: "hash2" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0 },
          });
        }
      }

      assert.equal(address.hostname, "database.invalid");
      const query = address.pathname + address.search;
      if (query.startsWith("/rest/v1/staff_activations")) return json([{ role: "admin" }]);
      if (query.startsWith("/rest/v1/jarvis_notes")) return json([]);
      if (query.startsWith("/rest/v1/client_accounts")) return json([{ client_code: "KNC", company: "Test" }]);
      if (query.startsWith("/rest/v1/tool_calls")) return json([{ id: 1 }]);
      if (query.startsWith("/rest/v1/agent_runs")) {
        if (options.method === "PATCH") completions.push(JSON.parse(options.body));
        return json([{ id: 500 }]);
      }
      if (query.startsWith("/rest/v1/jarvis_audit_log")) return json([{ id: 1 }]);
      throw new Error(`Unexpected: ${query}`);
    });

    const ctx = { lineUserId: "fixture-operator" };
    await gateway.runJarvis(ctx, "List clients");

    assert.equal(completions.length, 1);
    assert.equal(completions[0].error, "empty_final", "Should record empty_final when finishReason is STOP");
  });

  await t.test("empty final with absent finishReason records empty_final error code", async (t) => {
    const { gateway } = loadGateway(t);
    const requests = [];
    const completions = [];

    t.mock.method(globalThis, "fetch", async (url, options) => {
      const address = new URL(url);
      if (address.hostname === "generativelanguage.googleapis.com") {
        const body = JSON.parse(options.body);
        requests.push(body);

        if (requests.length === 1) {
          return json({
            candidates: [{ content: { parts: [
              { functionCall: { name: "list_clients", args: {} } },
            ] } }],
          });
        }

        if (requests.length === 2) {
          return json({
            candidates: [{ content: { parts: [{ thoughtSignature: "hash" }] } }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0 },
          });
        }

        if (requests.length === 3) {
          return json({
            candidates: [{ content: { parts: [{ thoughtSignature: "hash2" }] } }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0 },
          });
        }
      }

      assert.equal(address.hostname, "database.invalid");
      const query = address.pathname + address.search;
      if (query.startsWith("/rest/v1/staff_activations")) return json([{ role: "admin" }]);
      if (query.startsWith("/rest/v1/jarvis_notes")) return json([]);
      if (query.startsWith("/rest/v1/client_accounts")) return json([{ client_code: "KNC", company: "Test" }]);
      if (query.startsWith("/rest/v1/tool_calls")) return json([{ id: 1 }]);
      if (query.startsWith("/rest/v1/agent_runs")) {
        if (options.method === "PATCH") completions.push(JSON.parse(options.body));
        return json([{ id: 600 }]);
      }
      if (query.startsWith("/rest/v1/jarvis_audit_log")) return json([{ id: 1 }]);
      throw new Error(`Unexpected: ${query}`);
    });

    const ctx = { lineUserId: "fixture-operator" };
    await gateway.runJarvis(ctx, "List clients");

    assert.equal(completions.length, 1);
    assert.equal(completions[0].error, "empty_final", "Should record empty_final when finishReason is absent");
  });
});
