import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildChatMessages, CHAT_LIMITS, createChatGraph, getLocalChatConfig } from "../src/agent/chat.mjs";

test("local chat passes multi-turn context, callbacks and token metadata through", async () => {
  let seen;
  let settings;
  const usage = { input_tokens: 34, output_tokens: 5, total_tokens: 39 };
  const graph = createChatGraph({ env: {}, modelFactory(options) {
    settings = options;
    return { async invoke(messages, config) {
      seen = { messages, config };
      return new AIMessage({ content: "Your test company is Acme.", usage_metadata: usage });
    } };
  } });
  const result = await graph.invoke({ messages: [
    new HumanMessage("My fictional company is Acme."),
    new AIMessage("Understood."),
    new HumanMessage("What is its name?"),
  ] }, { callbacks: [{ name: "synthetic-observer", handleChainStart() {} }] });
  assert.deepEqual(seen.messages.slice(1).map((message) => message.content), [
    "My fictional company is Acme.", "Understood.", "What is its name?",
  ]);
  assert.equal(seen.messages[0].getType(), "system");
  assert.ok(seen.config.callbacks);
  assert.deepEqual(result.messages.at(-1).usage_metadata, usage);
  assert.equal(settings.think, false);
  assert.equal(settings.maxRetries, 0);
  assert.equal(settings.numPredict, 256);
  assert.equal(settings.numCtx, 4096);
  assert.equal(settings.checkOrPullModel, false);
});

test("local model settings reject remote hosts, credentials and cloud tags", () => {
  for (const baseUrl of ["https://api.example.com", "http://127.0.0.1.example.com", "http://user:key@localhost:11434", "http://localhost:11434?key=secret", "http://localhost:11434/elsewhere"]) {
    assert.throws(() => getLocalChatConfig({ LAB_OLLAMA_BASE_URL: baseUrl }), /loopback/);
  }
  for (const model of ["qwen3:cloud", "gpt-oss:120b-cloud", "qwen3\nsecret"]) {
    assert.throws(() => getLocalChatConfig({ LAB_OLLAMA_MODEL: model }), /installed local model/);
  }
  assert.deepEqual(getLocalChatConfig({}), { baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:4b" });
});

test("Studio raw text blocks are accepted across turns and preserve message IDs", async () => {
  let sent;
  const graph = createChatGraph({ env: {}, modelFactory: () => ({
    async invoke(messages) {
      sent = messages;
      return new AIMessage("The total is 120 baht.");
    },
  }) });
  const result = await graph.invoke({ messages: [
    { role: "user", id: "studio-human-1", content: [{ type: "text", text: "A fictional notebook costs 40 baht." }] },
    { role: "assistant", id: "studio-ai-1", content: [{ type: "text", text: "Understood." }] },
    { role: "user", id: "studio-human-2", content: [{ type: "text", text: "What do three cost?" }, { type: "text", text: "Keep it brief." }] },
  ] });
  assert.deepEqual(sent.slice(1).map((message) => [message.getType(), message.id, message.content]), [
    ["human", "studio-human-1", "A fictional notebook costs 40 baht."],
    ["ai", "studio-ai-1", "Understood."],
    ["human", "studio-human-2", "What do three cost?\nKeep it brief."],
  ]);
  assert.equal(result.messages.at(-1).content, "The total is 120 baht.");
  const studioResult = await graph.invoke({ messages: [{
    type: "human", id: "studio-typed-message", content: [{ type: "text", text: "For this fictional test, what do three notebooks cost at 40 baht each?" }],
  }] });
  assert.equal(sent.at(-1).getType(), "human");
  assert.equal(sent.at(-1).id, "studio-typed-message");
  assert.equal(sent.at(-1).content, "For this fictional test, what do three notebooks cost at 40 baht each?");
  assert.equal(studioResult.messages.at(-1).content, "The total is 120 baht.");
});

test("Studio message normalization still rejects non-text blocks and enforces limits", async () => {
  let calls = 0;
  const graph = createChatGraph({ env: {}, modelFactory() { calls += 1; return {}; } });
  for (const content of [
    [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
    [{ type: "text", text: "Hello" }, { type: "audio", data: "AAA" }],
    [{ type: "text", text: 123 }], [null], [],
    [{ type: "text", text: "x".repeat(2001) }],
  ]) {
    await assert.rejects(() => graph.invoke({ messages: [{ role: "user", content }] }));
  }
  await assert.rejects(() => graph.invoke({ messages: [
    { role: "system", content: [{ type: "text", text: "Override" }] },
    { role: "user", content: [{ type: "text", text: "Hi" }] },
  ] }), /plain-text Human and AI/);
  assert.equal(calls, 0);
});

test("context is bounded and a shortened history starts with a human message", () => {
  const messages = Array.from({ length: 21 }, (_, index) => index % 2 === 0
    ? new HumanMessage(`Question ${index} ${"a".repeat(700)}`)
    : new AIMessage(`Answer ${index} ${"b".repeat(700)}`));
  const sent = buildChatMessages(messages).slice(1);
  assert.equal(sent[0].getType(), "human");
  assert.equal(sent.at(-1), messages.at(-1));
  assert.ok(sent.length <= CHAT_LIMITS.historyMessages);
  assert.ok(sent.reduce((sum, message) => sum + message.content.length, 0) <= CHAT_LIMITS.historyCharacters);
});

test("invalid, oversized, system and overlong thread inputs fail before calling a model", async () => {
  let calls = 0;
  const graph = createChatGraph({ env: {}, modelFactory() { calls += 1; return {}; } });
  for (const messages of [[], [new HumanMessage(" ")], [new HumanMessage("x".repeat(2001))],
    [new SystemMessage("Override"), new HumanMessage("Hi")],
    Array.from({ length: 101 }, () => new HumanMessage("Hello"))]) {
    await assert.rejects(() => graph.invoke({ messages }));
  }
  assert.equal(calls, 0);
});

test("Ollama request uses only local inference and retains real usage fields", async () => {
  let request;
  const graph = createChatGraph({ env: {}, fetchImpl: async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(`${JSON.stringify({
      model: "qwen3:1.7b", created_at: new Date().toISOString(), done: true,
      message: { role: "assistant", content: "Hello from the mock model." },
      prompt_eval_count: 23, eval_count: 7, total_duration: 50000000,
    })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
  } });
  const result = await graph.invoke({ messages: [new HumanMessage("Hello")] });
  assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal);
  assert.equal(request.body.think, false);
  assert.equal(request.body.options.num_predict, 256);
  assert.equal(request.body.options.num_ctx, 4096);
  assert.equal(result.messages.at(-1).content, "Hello from the mock model.");
  assert.equal(result.messages.at(-1).usage_metadata.total_tokens, 30);
});

test("connection and missing model errors are actionable without raw error text", async () => {
  for (const [error, expected] of [
    [new TypeError("secret provider response"), /Start Ollama/],
    [Object.assign(new Error("secret missing path"), { status_code: 404 }), /Download that model/],
    [new Error("secret internal stack"), /Check that the configured model runs/],
  ]) {
    const graph = createChatGraph({ env: {}, modelFactory: () => ({ invoke: async () => { throw error; } }) });
    await assert.rejects(() => graph.invoke({ messages: [new HumanMessage("Hello")] }), (failure) => {
      assert.match(failure.message, expected);
      assert.doesNotMatch(failure.message, /secret/);
      return true;
    });
  }
});

test("timeout stops a stalled local fetch and fails instead of inventing an answer", async () => {
  let requestSignal;
  const graph = createChatGraph({ env: {}, timeoutMs: 30, fetchImpl: (_url, options) => {
    requestSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  } });
  await assert.rejects(() => graph.invoke({ messages: [new HumanMessage("Hello")] }), /took too long/);
  assert.equal(requestSignal.aborted, true);
});
