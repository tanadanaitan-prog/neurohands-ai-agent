// Isolated synthetic test: never imports the app or reads customer data.
const { performance } = require("node:perf_hooks");

const MODEL = "thinkingmachines/inkling-small:free";
const BASE_URL = "https://openrouter.ai/api/v1";
const ENDPOINT = `${BASE_URL}/chat/completions`;
const TIMEOUT_MS = 15000;
const ORDER_ID = "SYNTHETIC-ORDER-001";
const FIXTURE = Object.freeze({ order_id: ORDER_ID, quantity: 3, unit_price: 7 });
const TOOL = {
  type: "function",
  function: {
    name: "get_fixture_order",
    description: "Read one fictional order made solely for this public model test.",
    parameters: {
      type: "object", properties: { order_id: { type: "string", enum: [ORDER_ID] } },
      required: ["order_id"], additionalProperties: false,
    },
  },
};
const TOKEN_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens"];

function usageOf(source) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field,
    Number.isSafeInteger(source?.[field]) && source[field] >= 0 ? source[field] : null]));
}

function validatedToolCall(data) {
  const calls = data?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) return null;
  const call = calls[0];
  if (call?.type !== "function" || call.function?.name !== TOOL.function.name ||
    typeof call.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) ||
    typeof call.function.arguments !== "string" || call.function.arguments.length > 512) return null;
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { return null; }
  if (!args || typeof args !== "object" || Array.isArray(args) ||
    Object.keys(args).length !== 1 || args.order_id !== ORDER_ID) return null;
  // Retain only the validated call, never arbitrary model text or extra fields.
  return { id: call.id, type: "function", function: { name: TOOL.function.name, arguments: JSON.stringify({ order_id: ORDER_ID }) } };
}

async function checkPublicModel({
  env = {
    THIRD_API_KEY: process.env.THIRD_API_KEY,
    THIRD_PROVIDER: process.env.THIRD_PROVIDER,
    THIRD_MODEL: process.env.THIRD_MODEL,
    THIRD_BASE_URL: process.env.THIRD_BASE_URL,
  },
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const started = now();
  const result = {
    provider: "openrouter", model: MODEL, scope: "synthetic_public_fixture_only",
    verified: false, status: "missing_key", requests: 0, elapsedMs: 0,
    usage: usageOf(null), attempts: [],
  };
  const finish = (status) => ({ ...result, status, verified: status === "verified",
    elapsedMs: Math.max(0, Math.round(now() - started)) });
  if ((env.THIRD_PROVIDER !== undefined && env.THIRD_PROVIDER !== "openrouter") ||
    (env.THIRD_MODEL !== undefined && env.THIRD_MODEL !== MODEL) ||
    (env.THIRD_BASE_URL !== undefined && env.THIRD_BASE_URL !== BASE_URL)) return finish("invalid_configuration");
  const key = typeof env.THIRD_API_KEY === "string" ? env.THIRD_API_KEY.trim() : "";
  if (!key) return finish("missing_key");

  const controller = new AbortController();
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(TIMEOUT_MS, timeoutMs)) : TIMEOUT_MS;
  let timer;
  let activeResponse;
  let activeRequestStarted = started;
  const cancelBody = (response) => {
    try {
      if (response?.body && !response.body.locked) Promise.resolve(response.body.cancel()).catch(() => {});
    } catch { /* Cleanup must not disclose transport errors or replace the result. */ }
  };
  const elapsed = (start) => Math.max(0, Math.round(now() - start));
  async function request(messages, useTool) {
    if (controller.signal.aborted) return { status: "timeout" };
    const requestStarted = now();
    activeRequestStarted = requestStarted;
    const attempt = { httpStatus: null, status: "pending", elapsedMs: 0, usage: usageOf(null) };
    result.attempts.push(attempt);
    result.requests += 1;
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL, max_tokens: 128, temperature: 0, n: 1, messages, tools: [TOOL],
          tool_choice: useTool ? { type: "function", function: { name: TOOL.function.name } } : "none",
        }),
      });
      activeResponse = response;
      if (controller.signal.aborted) return { status: "timeout" };
      attempt.httpStatus = Number.isInteger(response.status) ? response.status : null;
      if (!response.ok) return { status: attempt.status = "http_error" };
      const data = await response.json();
      if (controller.signal.aborted) return { status: "timeout" };
      attempt.usage = usageOf(data?.usage);
      attempt.status = "ok";
      return { status: "ok", data };
    } catch {
      return { status: attempt.status = controller.signal.aborted ? "timeout" : response ? "invalid_response" : "transport_error" };
    } finally {
      attempt.elapsedMs = elapsed(requestStarted);
      cancelBody(response);
    }
  }
  const messages = [{ role: "user", content: `This is a fictional public test. Use get_fixture_order for ${ORDER_ID}. Then calculate quantity multiplied by unit_price.` }];
  const run = async () => {
    const first = await request(messages, true);
    if (first.status !== "ok") return first.status;
    const call = validatedToolCall(first.data);
    if (!call) return "tool_validation_failed";
    messages.push({ role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: JSON.stringify(FIXTURE) },
      { role: "user", content: "Using only the fictional tool result, return quantity multiplied by unit_price as digits with no other text." });
    const second = await request(messages, false);
    if (second.status !== "ok") return second.status;
    const reply = second.data?.choices?.[0]?.message;
    return typeof reply?.content === "string" && reply.content.trim() === String(FIXTURE.quantity * FIXTURE.unit_price) &&
      (!reply.tool_calls || (Array.isArray(reply.tool_calls) && reply.tool_calls.length === 0)) ? "verified" : "answer_mismatch";
  };
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, deadlineMs);
  });
  try {
    const status = await Promise.race([run(), timeout]);
    for (const attempt of result.attempts) {
      if (attempt.status === "pending") {
        attempt.status = status === "timeout" ? "timeout" : "invalid_response";
        attempt.elapsedMs = elapsed(activeRequestStarted);
      }
    }
    result.usage = Object.fromEntries(TOKEN_FIELDS.map((field) => {
      const total = result.attempts.reduce((sum, attempt) => sum + (attempt.usage[field] ?? 0), 0);
      return [field, result.attempts.every((attempt) => attempt.usage[field] !== null) && Number.isSafeInteger(total) ? total : null];
    }));
    // Snapshot attempts so a late, aborted transport cannot change returned evidence.
    result.attempts = result.attempts.map((attempt) => ({ ...attempt, usage: { ...attempt.usage } }));
    return finish(status);
  } finally {
    clearTimeout(timer);
    controller.abort();
    cancelBody(activeResponse);
  }
}

if (require.main === module) {
  checkPublicModel().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.verified ? 0 : 1;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({ verified: false, status: "internal_error" })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { checkPublicModel };
