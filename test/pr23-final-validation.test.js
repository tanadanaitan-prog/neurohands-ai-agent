"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const tool = { name: "fixture_write", parameters: { type: "object", properties: {} } };
const textResponse = (provider, text, reason) => provider === "gemini"
  ? { candidates: [{ ...(reason ? { finishReason: reason } : {}), content: { parts: [{ text }] } }] }
  : { choices: [{ ...(reason ? { finish_reason: reason } : {}), message: { content: text } }] };
const toolResponse = provider => provider === "gemini"
  ? { candidates: [{ content: { parts: [{ functionCall: { name: tool.name, args: {} } }] } }] }
  : { choices: [{ message: { tool_calls: [{ id: "one-effect", function: { name: tool.name, arguments: "{}" } }] } }] };

function gatewayFixture(t) {
  const values = { GEMINI_ENABLED: "true", GEMINI_MODEL: "fixture", GEMINI_API_KEY: "synthetic-key",
    FALLBACK_API_KEY: "synthetic-key", FALLBACK_BASE_URL: "https://fixture-model.invalid",
    FALLBACK_MODELS: "fixture-one,fixture-two", FALLBACK_MODEL: "", ENABLE_STUDIO: "false",
    SOFTWARE_ADMISSION_ENABLED: "false", SUPABASE_URL: "https://fixture-db.invalid", SUPABASE_SERVICE_KEY: "synthetic-key" };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  delete require.cache[require.resolve("../src/server")];
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[require.resolve("../src/server")];
  });
  return require("../src/server");
}

async function ordinaryFinal(t, provider, final, afterTool = true) {
  const gateway = gatewayFixture(t);
  const expectedRequests = afterTool ? 2 : 1;
  let requests = 0, writes = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), provider === "gemini" ? /generativelanguage\.googleapis\.com/ : /^https:\/\/fixture-model\.invalid\//);
    assert.equal(options.method, "POST");
    assert.ok(++requests <= expectedRequests, "An ordinary final must not trigger retry, model cascade or synthesis");
    return new Response(JSON.stringify(afterTool && requests === 1 ? toolResponse(provider) : final));
  });
  const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
    "Policy", "Synthetic request", [tool], {}, 11,
    { execute: async () => { writes++; return { saved: true, task_id: 42 }; } });
  assert.equal(requests, expectedRequests);
  assert.equal(writes, afterTool ? 1 : 0, "A completed action must never replay");
  assert.equal(result.iterations, expectedRequests);
  return result;
}

const rejected = [
  ["gemini", "SAFETY", textResponse("gemini", "UNSAFE_FINAL", "SAFETY")],
  ["gemini", "MAX_TOKENS", textResponse("gemini", "UNSAFE_FINAL", "MAX_TOKENS")],
  ["gemini", "prompt block", { ...textResponse("gemini", "UNSAFE_FINAL", "STOP"), promptFeedback: { blockReason: "SAFETY" } }],
  ["gemini", "blocked safety rating", { candidates: [{ finishReason: "STOP", safetyRatings: [{ blocked: true }], content: { parts: [{ text: "UNSAFE_FINAL" }] } }] }],
  ["gemini", "malformed safety ratings", { candidates: [{ finishReason: "STOP", safetyRatings: {}, content: { parts: [{ text: "UNSAFE_FINAL" }] } }] }],
  ["openai", "content_filter", textResponse("openai", "UNSAFE_FINAL", "content_filter")],
  ["openai", "length", textResponse("openai", "UNSAFE_FINAL", "length")],
  ["openai", "refusal", { choices: [{ finish_reason: "stop", message: { content: "UNSAFE_FINAL", refusal: "Refused" } }] }],
];

for (const [provider, label, final] of rejected) {
  for (const afterTool of [false, true]) {
    test(`${provider}: ordinary ${label} final ${afterTool ? "after one action" : "before any tool"} is rejected without another request`, async t => {
      const result = await ordinaryFinal(t, provider, final, afterTool);
      assert.equal(result.text, null);
    });
  }
}

for (const provider of ["gemini", "openai"]) {
  for (const reason of [undefined, provider === "gemini" ? "STOP" : "stop"]) {
    for (const afterTool of [false, true]) {
      test(`${provider}: valid ordinary final (${reason || "legacy missing finish reason"}) ${afterTool ? "after one action" : "before any tool"} is preserved`, async t => {
        const result = await ordinaryFinal(t, provider, textResponse(provider, "  Verified answer.  ", reason), afterTool);
        assert.equal(result.text, "Verified answer.");
      });
    }
  }

  test(`${provider}: the last allowed empty final still permits one tool-free synthesis`, async t => {
    const gateway = gatewayFixture(t);
    let requests = 0, writes = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(++requests <= 6);
      if (requests <= 4) return new Response(JSON.stringify(toolResponse(provider)));
      if (requests === 5) return new Response(JSON.stringify(textResponse(provider, " ", provider === "gemini" ? "MAX_TOKENS" : "length")));
      assert.equal(body.tools, undefined, "Synthesis exposes no executable tools");
      const transcript = JSON.stringify(provider === "gemini" ? body.contents : body.messages);
      assert.match(transcript, /task_id.*42/);
      return new Response(JSON.stringify(textResponse(provider, "Saved task 42.", provider === "gemini" ? "STOP" : "stop")));
    });
    const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
      "Policy", "Synthetic request", [tool], {}, 11,
      { execute: async () => { writes++; return { saved: true, task_id: 42 }; } });
    assert.equal(result.text, "Saved task 42.");
    assert.equal(requests, 6);
    assert.equal(writes, 4);
    assert.equal(result.iterations, 6);
  });
}

for (const publicAnswer of [false, true]) {
  test(`gemini: ordinary ${publicAnswer ? "mixed thought and public" : "thought-only"} final excludes private thoughts without synthesis`, async t => {
    const final = { candidates: [{ finishReason: "STOP", content: { parts: [
      { text: "PRIVATE_THOUGHT", thought: true }, ...(publicAnswer ? [{ text: "Verified answer." }] : []),
    ] } }] };
    const result = await ordinaryFinal(t, "gemini", final);
    assert.equal(result.text, publicAnswer ? "Verified answer." : null);
  });
}
