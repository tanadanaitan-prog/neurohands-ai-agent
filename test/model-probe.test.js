const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { checkModels } = require("../scripts/check-models");

const SECRET = "fixture-private-key-never-output";
const env = { GEMINI_API_KEY: SECRET, GEMINI_MODEL: "gemini-fixture", FALLBACK_PROVIDER: "groq", FALLBACK_API_KEY: SECRET };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const fallbackAnswer = () => json({ choices: [{ message: { content: SECRET } }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9, total_time: 0.5, private: SECRET } });
const geminiAnswer = () => json({ candidates: [{ content: { parts: [{ text: SECRET }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8, thoughtsTokenCount: 0, private: SECRET } });

test("model probe runs only two bounded requests concurrently and outputs no content or credentials", async () => {
  const calls = [];
  const resolvers = [];
  const pending = checkModels({ env, fetchImpl: (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => resolvers.push(resolve));
  } });
  assert.equal(calls.length, 2, "Both requests start without waiting for the primary");
  assert.equal(new URL(calls[0].url).search, "");
  assert.equal(calls[0].options.headers["x-goog-api-key"], SECRET);
  assert.equal(JSON.parse(calls[1].options.body).model, "openai/gpt-oss-120b");
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, false);
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens || body.generationConfig.maxOutputTokens, 128);
  }
  resolvers[0](geminiAnswer()); resolvers[1](fallbackAnswer());
  const results = await pending;
  assert.deepEqual(results.map((result) => result.status), ["ok", "ok"]);
  assert.equal(results[0].usage.totalTokenCount, 8);
  assert.equal(results[1].usage.total_tokens, 9);
  assert.equal(results[1].usage.total_time, 0.5);
  assert.equal(JSON.stringify(results).includes(SECRET), false);
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), ["elapsedMs", "httpStatus", "model", "provider", "status", "usage"]);
    assert.equal(result.httpStatus, 200);
    assert.ok(result.elapsedMs >= 0);
  }
});

test("missing keys and invalid configuration never call a provider or reveal secret model values", async () => {
  const noFetch = () => { assert.fail("No provider should be called"); };
  assert.deepEqual((await checkModels({ env: {}, fetchImpl: noFetch })).map((r) => r.status), ["missing_key", "missing_key"]);
  const results = await checkModels({ env: { ...env, GEMINI_MODEL: SECRET, FALLBACK_BASE_URL: `https://user:${SECRET}@example.invalid` }, fetchImpl: noFetch });
  assert.deepEqual(results.map((r) => r.status), ["invalid_configuration", "invalid_configuration"]);
  assert.equal(JSON.stringify(results).includes(SECRET), false);
});

test("the diagnostic skips disabled Gemini even when its key is configured", async () => {
  const calls = [];
  const results = await checkModels({ env: { ...env, GEMINI_ENABLED: " FALSE " }, fetchImpl: async (url) => {
    calls.push(new URL(url).hostname);
    assert.equal(new URL(url).hostname, "api.groq.com");
    return fallbackAnswer();
  } });
  assert.deepEqual(calls, ["api.groq.com"]);
  assert.deepEqual(results.map((result) => result.status), ["disabled", "ok"]);
  assert.equal(results[0].httpStatus, null);
  assert.equal(results[0].elapsedMs, 0);
  assert.deepEqual(results[0].usage, {});
  assert.equal(JSON.stringify(results).includes(SECRET), false);
});

test("CLI emits JSON only and exits successfully when no provider is configured", () => {
  // Deliberately clear the inherited environment: this test cannot use live keys.
  const child = spawnSync(process.execPath, [require.resolve("../scripts/check-models")], { env: {}, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, "");
  const results = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(results.map((result) => result.status), ["missing_key", "missing_key"]);
});

test("probe uses the first explicit fallback model without cascading to another model", async () => {
  let calls = 0;
  const results = await checkModels({ env: { FALLBACK_API_KEY: SECRET, FALLBACK_PROVIDER: "groq", FALLBACK_MODELS: " first-model,second-model", FALLBACK_MODEL: "third-model" }, fetchImpl: async (_url, options) => {
    calls += 1;
    assert.equal(JSON.parse(options.body).model, "first-model");
    return json({ error: { message: SECRET } }, 429);
  } });
  assert.equal(calls, 1);
  assert.equal(results[1].status, "http_error");
  assert.equal(results[1].httpStatus, 429);
  assert.equal(JSON.stringify(results).includes(SECRET), false);
});

test("transport, malformed JSON, empty and timed-out bodies produce safe diagnostic statuses", async (t) => {
  const cases = {
    transport_error: () => { throw new Error(SECRET); },
    invalid_json: () => new Response(SECRET),
    empty_response: () => json({ usageMetadata: { promptTokenCount: "secret", totalTokenCount: -1, thoughtsTokenCount: Infinity }, usage: { total_tokens: SECRET } }),
    timeout: () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  };
  for (const [expected, fetchImpl] of Object.entries(cases)) {
    await t.test(expected, async () => {
      const results = await checkModels({ env, fetchImpl, timeoutMs: 5 });
      assert.deepEqual(results.map((result) => result.status), [expected, expected]);
      assert.equal(JSON.stringify(results).includes(SECRET), false);
      assert.deepEqual(results[0].usage, {});
    });
  }
});

test("a hung primary cannot prevent a successful fallback result or exceed the probe deadline", async () => {
  let primarySignal;
  const started = performance.now();
  const results = await checkModels({ env, timeoutMs: 10, fetchImpl: (url, options) => {
    if (new URL(url).hostname === "generativelanguage.googleapis.com") {
      primarySignal = options.signal;
      return new Promise(() => {});
    }
    return fallbackAnswer();
  } });
  assert.deepEqual(results.map((result) => result.status), ["timeout", "ok"]);
  assert.equal(primarySignal.aborted, true);
  assert.ok(performance.now() - started < 1000);
});
