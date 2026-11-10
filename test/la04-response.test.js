const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const json = (value) => new Response(JSON.stringify(value));
const geminiText = (text) => json({ candidates: [{ content: { parts: [{ text }] } }] });
const openaiText = (content) => json({ choices: [{ message: { content } }] });
const tool = { name: "fixture_write", parameters: { type: "object", properties: {} } };

function gatewayFixture(t, overrides = {}) {
  const values = { GEMINI_ENABLED: "true", GEMINI_MODEL: "fixture", GEMINI_API_KEY: "synthetic-key",
    FALLBACK_API_KEY: "synthetic-key", FALLBACK_BASE_URL: "https://fixture-model.invalid",
    FALLBACK_MODELS: "fixture-one,fixture-two", FALLBACK_MODEL: "", ENABLE_STUDIO: "false",
    SOFTWARE_ADMISSION_ENABLED: "false", SUPABASE_URL: "https://fixture-db.invalid", SUPABASE_SERVICE_KEY: "synthetic-key", ...overrides };
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

for (const provider of ["gemini", "openai"]) {
  test(`${provider}: an empty final after a write gets one text-only synthesis without another write`, async t => {
    const gateway = gatewayFixture(t);
    let requests = 0, writes = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const body = JSON.parse(options.body);
      requests++;
      if (requests === 1) return provider === "gemini"
        ? json({ candidates: [{ content: { parts: [{ functionCall: { name: tool.name, args: {} } }] } }] })
        : json({ choices: [{ message: { tool_calls: [{ id: "write-one", function: { name: tool.name, arguments: "{}" } }] } }] });
      if (requests === 2) return provider === "gemini" ? geminiText("   ") : openaiText("   ");
      assert.equal(body.tools, undefined, "Recovery must not expose any executable tool");
      const transcript = JSON.stringify(provider === "gemini" ? body.contents : body.messages);
      assert.match(transcript, /task_id.*42/);
      assert.match(transcript, /fixture_write/);
      return provider === "gemini" ? geminiText("Saved task 42.") : openaiText("Saved task 42.");
    });
    const execute = async () => { writes++; return { task_id: 42 }; };
    const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
      "Policy", "Save a task", [tool], {}, 11, { execute });
    assert.equal(result.text, "Saved task 42.");
    assert.equal(writes, 1);
    assert.equal(requests, 3);
  });

  test(`${provider}: failed text synthesis is bounded and cannot execute an unsolicited tool`, async t => {
    const gateway = gatewayFixture(t);
    let requests = 0, writes = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const body = JSON.parse(options.body);
      requests++;
      if (requests === 1 || requests >= 3) {
        if (requests >= 3) assert.equal(body.tools, undefined);
        return provider === "gemini"
          ? json({ candidates: [{ content: { parts: [{ functionCall: { name: tool.name, args: {} } }] } }] })
          : json({ choices: [{ message: { tool_calls: [{ id: "attempted-write", function: { name: tool.name, arguments: "{}" } }] } }] });
      }
      return provider === "gemini" ? geminiText(" ") : openaiText(" ");
    });
    const execute = async () => { writes++; return { task_id: 42 }; };
    const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
      "Policy", "Save a task", [tool], {}, 11, { execute });
    assert.equal(result.text, null);
    assert.equal(writes, 1);
    assert.equal(requests, 3);
  });

  test(`${provider}: blocked empty output does not trigger synthesis`, async t => {
    const gateway = gatewayFixture(t, { FALLBACK_MODELS: "fixture-one" });
    let requests = 0, writes = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      if (requests === 1) return provider === "gemini"
        ? json({ candidates: [{ content: { parts: [{ functionCall: { name: tool.name, args: {} } }] } }] })
        : json({ choices: [{ message: { tool_calls: [{ id: "one", function: { name: tool.name, arguments: "{}" } }] } }] });
      return provider === "gemini"
        ? json({ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: " " }] } }] })
        : json({ choices: [{ finish_reason: "content_filter", message: { content: " ", refusal: "Blocked" } }] });
    });
    const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
      "Policy", "Save a task", [tool], {}, 11, { execute: async () => { writes++; return { task_id: 42 }; } });
    assert.ok(!result.text);
    assert.equal(requests, 2);
    assert.equal(writes, 1);
  });

  test(`${provider}: empty first output cannot start post-tool synthesis`, async t => {
    const gateway = gatewayFixture(t, { FALLBACK_MODELS: "fixture-one" });
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return provider === "gemini" ? geminiText(" ") : openaiText(" ");
    });
    const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
      "Policy", "Question", [tool], {}, 11, { execute: async () => assert.fail("No tool was requested") });
    assert.ok(!result.text);
    assert.equal(requests, 1);
  });

  for (const reason of provider === "gemini" ? ["SAFETY", "MAX_TOKENS"] : ["content_filter", "length"]) {
    test(`${provider}: ${reason} synthesis text is not accepted as a complete answer`, async t => {
      const gateway = gatewayFixture(t);
      let requests = 0, writes = 0;
      t.mock.method(globalThis, "fetch", async () => {
        requests++;
        if (requests === 1) return provider === "gemini"
          ? json({ candidates: [{ content: { parts: [{ functionCall: { name: tool.name, args: {} } }] } }] })
          : json({ choices: [{ message: { tool_calls: [{ id: "one", function: { name: tool.name, arguments: "{}" } }] } }] });
        if (requests === 2) return provider === "gemini" ? geminiText(" ") : openaiText(" ");
        return provider === "gemini"
          ? json({ candidates: [{ finishReason: reason, content: { parts: [{ text: "INCOMPLETE OR BLOCKED" }] } }] })
          : json({ choices: [{ finish_reason: reason, message: { content: "INCOMPLETE OR BLOCKED" } }] });
      });
      const result = await gateway[provider === "gemini" ? "askGeminiWithTools" : "runOpenAIToolLoop"](
        "Policy", "Save a task", [tool], {}, 11, { execute: async () => { writes++; return { task_id: 42 }; } });
      assert.equal(result.text, null);
      assert.equal(requests, 3);
      assert.equal(writes, 1);
    });
  }
}

test("synthesis validators exclude provider thought/refusal content", () => {
  const { postToolText } = require("../src/lib/post-tool-response");
  assert.equal(postToolText("gemini", { candidates: [{ content: { parts: [{ text: "private thought", thought: true }] } }] }), null);
  assert.equal(postToolText("gemini", { candidates: [{ content: { parts: [{ text: "private thought", thought: true }, { text: "Final." }] } }] }), "Final.");
  assert.equal(postToolText("openai", { choices: [{ message: { content: "Do not use", refusal: "Refused" } }] }), null);
});

function deliveryFixture() {
  const source = fs.readFileSync(require.resolve("../src/server"), "utf8");
  const start = source.indexOf("async function respondAgentWithRace(");
  const end = source.indexOf("\nasync function handleMessage(", start);
  assert.ok(start > 0 && end > start);
  let fireTimeout;
  const sends = [], logs = [];
  const context = {
    runAgent() { throw new Error("Explicit synthetic runner required"); },
    setTimeout(callback) { fireTimeout = callback; return 1; }, clearTimeout() {},
    async replyToLine(_token, text) { sends.push({ route: "reply", text }); return true; },
    async pushToLine(_id, text) { sends.push({ route: "push", text }); return true; },
    async logMessage(row) { logs.push(row); }, async db() { throw new Error("Unexpected database operation"); },
    databaseFailureCode() { return null; },
    C06_DATABASE_DEGRADED_RESPONSE: "Some work may already be saved. Check before repeating.",
    console: { error() {} },
  };
  vm.runInNewContext(source.slice(start, end) + "\nthis.respond = respondAgentWithRace;", context);
  return { context, sends, logs, timeout: () => fireTimeout(),
    event: { replyToken: "synthetic-token", source: { userId: "synthetic-user" } } };
}

test("a rejected runner after Checking receives one terminal notice and preserves the failure", async () => {
  const f = deliveryFixture();
  let rejectRunner;
  const runner = () => new Promise((_resolve, reject) => { rejectRunner = reject; });
  const pending = f.context.respond(f.event, {}, "Question", {}, runner);
  await f.timeout();
  rejectRunner(new Error("synthetic private failure"));
  await assert.rejects(pending, /synthetic private failure/);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].route, "reply");
  assert.match(f.sends[0].text, /Checking/);
  assert.equal(f.sends[1].route, "push");
  assert.match(f.sends[1].text, /Check before repeating/);
  assert.doesNotMatch(f.sends[1].text, /synthetic private failure/);
  assert.equal(f.logs.length, 1);
});

test("a rejected final send is not blindly retried with another LINE message", async () => {
  const f = deliveryFixture();
  f.context.replyToLine = async () => { f.sends.push({ route: "reply" }); throw new Error("Delivery uncertain"); };
  await assert.rejects(f.context.respond(f.event, {}, "Question", {}, async () => "Answer"), /Delivery uncertain/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.logs.length, 0);
});

test("a fast runner failure receives one terminal reply and preserves the original failure", async () => {
  const f = deliveryFixture();
  await assert.rejects(f.context.respond(f.event, {}, "Question", {}, async () => { throw new Error("runner failed"); }), /runner failed/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].route, "reply");
  assert.match(f.sends[0].text, /Check before repeating/);
  assert.equal(f.logs.length, 1);
});

test("an uncertain final push after Checking gets no second push", async () => {
  const f = deliveryFixture();
  let resolveRunner;
  const pending = f.context.respond(f.event, {}, "Question", {}, () => new Promise(resolve => { resolveRunner = resolve; }));
  await f.timeout();
  f.context.pushToLine = async () => { f.sends.push({ route: "push" }); throw new Error("push uncertain"); };
  resolveRunner("Final answer");
  await assert.rejects(pending, /push uncertain/);
  assert.deepEqual(f.sends.map(row => row.route), ["reply", "push"]);
  assert.equal(f.logs.length, 0);
});
