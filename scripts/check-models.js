// Run in Railway's environment: node scripts/check-models.js
// One small request per configured provider. Never prints response bodies or secrets.
const { performance } = require("node:perf_hooks");

const TIMEOUT_MS = 25000;
const FALLBACK_BASES = {
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
};
const GEMINI_USAGE = ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount"];
const FALLBACK_USAGE = ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_time", "completion_time", "queue_time", "total_time"];

function numericUsage(source, fields) {
  return Object.fromEntries(fields.filter((field) => typeof source?.[field] === "number" && Number.isFinite(source[field]) && source[field] >= 0)
    .map((field) => [field, source[field]]));
}

function safeModel(model, secrets) {
  return typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model) && !model.includes("://") &&
    !secrets.some((secret) => secret && model.includes(secret)) ? model : null;
}

function configuration(env) {
  const secrets = [env.GEMINI_API_KEY, env.FALLBACK_API_KEY].filter(Boolean);
  const geminiModel = env.GEMINI_MODEL === undefined ? "gemini-2.5-flash" : env.GEMINI_MODEL;
  const requestedProvider = String(env.FALLBACK_PROVIDER || "").toLowerCase();
  const provider = Object.hasOwn(FALLBACK_BASES, requestedProvider) ? requestedProvider : "fallback";
  const fallbackModel = [env.FALLBACK_MODELS, env.FALLBACK_MODEL].flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim()).find(Boolean) || (requestedProvider === "groq" ? "openai/gpt-oss-120b" : null);
  const fallbackBase = env.FALLBACK_BASE_URL || FALLBACK_BASES[requestedProvider];
  let fallbackUrl;
  try {
    const parsed = new URL(fallbackBase);
    // Do not forward keys over HTTP, through URL credentials or redirects.
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      fallbackUrl = `${parsed.href.replace(/\/$/, "")}/chat/completions`;
    }
  } catch { /* Missing/invalid config is reported without printing its value. */ }

  return [
    {
      provider: "gemini", model: safeModel(geminiModel, secrets), key: env.GEMINI_API_KEY,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: { contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }], generationConfig: { maxOutputTokens: 128 } },
    },
    {
      provider, model: safeModel(fallbackModel, secrets), key: env.FALLBACK_API_KEY, url: fallbackUrl,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.FALLBACK_API_KEY}` },
      body: { model: fallbackModel, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 128 },
    },
  ];
}

async function probe(config, { fetchImpl, timeoutMs, now }) {
  const started = now();
  const result = { provider: config.provider, model: config.model, status: "missing_key", httpStatus: null, elapsedMs: 0, usage: {} };
  if (!config.key) return result;
  if (!config.model || !config.url) return { ...result, status: "invalid_configuration" };
  const controller = new AbortController();
  let timer;
  let response;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ...result, status: "timeout" });
    }, timeoutMs);
  });
  const request = (async () => {
    try {
      response = await fetchImpl(config.url, {
        method: "POST", headers: config.headers, body: JSON.stringify(config.body),
        signal: controller.signal, redirect: "error",
      });
      result.httpStatus = Number.isInteger(response.status) ? response.status : null;
      if (!response.ok) return { ...result, status: "http_error" };
      const data = await response.json();
      const gemini = config.provider === "gemini";
      result.usage = numericUsage(gemini ? data?.usageMetadata : data?.usage, gemini ? GEMINI_USAGE : FALLBACK_USAGE);
      const hasText = gemini ? data?.candidates?.[0]?.content?.parts?.some?.((part) => typeof part?.text === "string" && part.text.trim())
        : typeof data?.choices?.[0]?.message?.content === "string" && Boolean(data.choices[0].message.content.trim());
      return { ...result, status: hasText ? "ok" : "empty_response" };
    } catch {
      return { ...result, status: controller.signal.aborted ? "timeout" : response ? "invalid_json" : "transport_error" };
    }
  })();
  try {
    const completed = await Promise.race([request, timeout]);
    return { ...completed, elapsedMs: Math.max(0, Math.round(now() - started)) };
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancel an unread error body so failed responses do not retain a connection.
    if (response?.body && !response.body.locked) Promise.resolve(response.body.cancel()).catch(() => {});
  }
}

async function checkModels({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = () => performance.now() } = {}) {
  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(TIMEOUT_MS, timeoutMs)) : TIMEOUT_MS;
  return Promise.all(configuration(env).map((config) => probe(config, { fetchImpl, timeoutMs: boundedTimeout, now })));
}

if (require.main === module) {
  checkModels().then((results) => results.forEach((result) => process.stdout.write(`${JSON.stringify(result)}\n`)))
    .catch(() => process.stdout.write(`${JSON.stringify({ provider: "diagnostic", model: null, status: "internal_error", httpStatus: null, elapsedMs: 0, usage: {} })}\n`));
}

module.exports = { checkModels };
