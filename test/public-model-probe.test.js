const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { checkPublicModel } = require("../scripts/check-public-model");

const KEY = "private-test-credential-do-not-print";
const MODEL = "thinkingmachines/inkling-small:free";
const BASE_URL = "https://openrouter.ai/api/v1";
const toolCall = (changes = {}) => ({
  id: "call_fixture_1", type: "function",
  function: { name: "get_fixture_order", arguments: '{"order_id":"SYNTHETIC-ORDER-001"}' }, ...changes,
});
const toolReply = (call = toolCall(), usage) => ({ choices: [{ message: { tool_calls: [call] } }], usage });
const answer = (content = "21", usage) => ({ choices: [{ message: { content } }], usage });
const response = (data) => ({ ok: true, status: 200, json: async () => data });
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    assert.ok(calls.length <= 2, "the test must never issue a third model request");
    return response(replies[calls.length - 1]);
  };
  return { calls, fetchImpl };
}

test("verifies only a validated fictional tool call followed by exact total, with fixed request bounds", async () => {
  const transport = fakeFetch([
    toolReply(toolCall(), { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }),
    answer(" 21\n", { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 }),
  ]);
  const accessed = [];
  const env = new Proxy({ THIRD_API_KEY: KEY, THIRD_MODEL: MODEL, THIRD_PROVIDER: "openrouter", THIRD_BASE_URL: BASE_URL }, {
    get(target, name) {
      accessed.push(name);
      assert.ok(["THIRD_API_KEY", "THIRD_MODEL", "THIRD_PROVIDER", "THIRD_BASE_URL"].includes(name));
      return target[name];
    },
  });
  const result = await checkPublicModel({ env, fetchImpl: transport.fetchImpl });
  assert.equal(result.status, "verified");
  assert.equal(result.verified, true);
  assert.equal(result.requests, 2);
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 });
  assert.ok(accessed.includes("THIRD_API_KEY"));
  for (const call of transport.calls) {
    assert.equal(call.url, `${BASE_URL}/chat/completions`);
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.options.headers["HTTP-Referer"], undefined);
    assert.equal(call.body.model, MODEL);
    assert.equal(call.body.max_tokens, 128);
    assert.equal(call.body.n, 1);
    assert.equal(JSON.stringify(call.body).includes(KEY), false);
    assert.equal(call.options.signal.aborted, true, "transport is closed after the test");
  }
  assert.deepEqual(transport.calls[0].body.tool_choice, { type: "function", function: { name: "get_fixture_order" } });
  const toolResult = transport.calls[1].body.messages.find((message) => message.role === "tool");
  assert.deepEqual(JSON.parse(toolResult.content), { order_id: "SYNTHETIC-ORDER-001", quantity: 3, unit_price: 7 });
  assert.equal(transport.calls[1].body.tool_choice, "none");
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("missing key and foreign or paid configuration make no network request", async () => {
  for (const env of [
    {}, { THIRD_API_KEY: " " },
    { THIRD_API_KEY: KEY, THIRD_PROVIDER: "groq" },
    { THIRD_API_KEY: KEY, THIRD_MODEL: "thinkingmachines/inkling-small" },
    { THIRD_API_KEY: KEY, THIRD_MODEL: "openai/gpt-4.1-mini" },
    { THIRD_API_KEY: KEY, THIRD_BASE_URL: "https://example.invalid/api/v1" },
    { THIRD_API_KEY: KEY, THIRD_BASE_URL: "http://openrouter.ai/api/v1" },
    { THIRD_API_KEY: KEY, THIRD_BASE_URL: "https://openrouter.ai/api/v1?redirect=elsewhere" },
  ]) {
    const result = await checkPublicModel({ env, fetchImpl: () => assert.fail("must not contact any provider") });
    assert.equal(result.verified, false);
    assert.equal(result.requests, 0);
    assert.ok(["missing_key", "invalid_configuration"].includes(result.status));
    assert.equal(result.usage.total_tokens, null);
  }
});

test("rejects absent, unknown, malformed or unscoped tools before a second request", async () => {
  const wrongTools = [
    answer("21"), toolReply(toolCall({ type: "not-a-function" })),
    toolReply(toolCall({ function: { name: "read_document", arguments: "{}" } })),
    toolReply(toolCall({ function: { name: "get_fixture_order", arguments: "{" } })),
    toolReply(toolCall({ function: { name: "get_fixture_order", arguments: "null" } })),
    toolReply(toolCall({ function: { name: "get_fixture_order", arguments: "[]" } })),
    toolReply(toolCall({ function: { name: "get_fixture_order", arguments: '{"order_id":"REAL-ORDER"}' } })),
    toolReply(toolCall({ function: { name: "get_fixture_order", arguments: '{"order_id":"SYNTHETIC-ORDER-001","url":"https://example.invalid"}' } })),
    toolReply(toolCall({ id: "invalid\ncall" })),
    { choices: [{ message: { tool_calls: [toolCall(), toolCall()] } }] },
  ];
  for (const reply of wrongTools) {
    const transport = fakeFetch([reply]);
    const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, fetchImpl: transport.fetchImpl });
    assert.equal(result.status, "tool_validation_failed");
    assert.equal(result.verified, false);
    assert.equal(transport.calls.length, 1);
  }
});

test("does not verify a wrong or verbose answer, or follow a second tool call", async () => {
  for (const reply of [answer("20"), answer("The total is 21."), answer(""), toolReply(), null]) {
    const transport = fakeFetch([toolReply(), reply]);
    const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, fetchImpl: transport.fetchImpl });
    assert.equal(result.verified, false);
    assert.equal(result.status, "answer_mismatch");
    assert.equal(transport.calls.length, 2);
    assert.equal(result.usage.total_tokens, null);
  }
});

test("reports unknown token usage instead of inventing zero and keeps valid partial counts", async () => {
  const transport = fakeFetch([
    toolReply(toolCall(), { prompt_tokens: 2, completion_tokens: -1, total_tokens: "3" }),
    answer("21", { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
  ]);
  const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, fetchImpl: transport.fetchImpl });
  assert.deepEqual(result.usage, { prompt_tokens: 6, completion_tokens: null, total_tokens: null });
});

test("HTTP failures have no retries or raw response disclosure", async () => {
  let calls = 0;
  const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, fetchImpl: async () => {
    calls += 1;
    return { ok: false, status: 429, json: () => assert.fail(`must not read error body ${KEY}`) };
  } });
  assert.equal(result.status, "http_error");
  assert.equal(result.verified, false);
  assert.equal(result.attempts[0].httpStatus, 429);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("transport and JSON errors never disclose credentials or raw errors", async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`private transport error ${KEY}`); },
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(`private JSON error ${KEY}`); } }),
  ]) {
    const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, fetchImpl });
    assert.equal(result.verified, false);
    assert.ok(["transport_error", "invalid_response"].includes(result.status));
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("one shared deadline covers fetch and body reads; a late response cannot start another request", async () => {
  for (const hangDuringRead of [false, true]) {
    let resolvePending;
    let calls = 0;
    let signal;
    const pending = new Promise((resolve) => { resolvePending = resolve; });
    const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, timeoutMs: 5, fetchImpl: async (_url, options) => {
      calls += 1;
      signal = options.signal;
      return hangDuringRead ? { ok: true, status: 200, json: () => pending } : pending;
    } });
    assert.equal(result.status, "timeout");
    assert.equal(result.verified, false);
    assert.equal(signal.aborted, true);
    const snapshot = JSON.stringify(result);
    resolvePending(hangDuringRead ? toolReply() : response(toolReply()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result), snapshot, "late transport completion must not mutate the report");
  }
});

test("the second request's stalled body is bounded and cannot become verified", async () => {
  let calls = 0;
  const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, timeoutMs: 5, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response(toolReply()) : { ok: true, status: 200, json: () => new Promise(() => {}) };
  } });
  assert.equal(result.status, "timeout");
  assert.equal(result.requests, 2);
  assert.equal(result.verified, false);
});

test("a caller cannot extend the shared deadline past 15 seconds", async () => {
  const realSetTimeout = globalThis.setTimeout;
  let configuredDelay;
  globalThis.setTimeout = (callback, delay) => {
    configuredDelay = delay;
    return realSetTimeout(callback, 1);
  };
  try {
    const result = await checkPublicModel({ env: { THIRD_API_KEY: KEY }, timeoutMs: 60000,
      fetchImpl: () => new Promise(() => {}) });
    assert.equal(configuredDelay, 15000);
    assert.equal(result.status, "timeout");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("CLI without a key reports a safe failure and ignores arbitrary prompt arguments", () => {
  // An empty child environment guarantees this CLI test cannot use live keys.
  const child = spawnSync(process.execPath, [require.resolve("../scripts/check-public-model"), "--prompt", KEY],
    { env: {}, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "missing_key");
  assert.equal(result.verified, false);
  assert.equal(result.requests, 0);
  assert.equal(child.stdout.includes(KEY), false);
});
