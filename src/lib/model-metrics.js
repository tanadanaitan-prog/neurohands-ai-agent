const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();
const tokenFields = ["input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "cached_input_tokens"];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const providerLabels = Object.freeze({ gemini: "Gemini", openai: "OpenAI", groq: "Groq", openrouter: "OpenRouter",
  mistral: "Mistral", cerebras: "Cerebras", custom: "Custom provider", fallback: "Fallback provider" });
const failureLabels = Object.freeze({ authentication_rejected: "authentication rejected", credit_exhausted: "credits exhausted",
  spend_limit_reached: "spending limit reached", quota_exhausted: "quota exhausted", http_error: "HTTP request failed" });
const safeReason = (reason) => typeof reason === "string" && Object.hasOwn(failureLabels, reason) ? reason : null;
function safeProvider(provider) {
  if (typeof provider !== "string" || provider.length > 24) return null;
  const name = provider.trim().toLowerCase();
  return Object.hasOwn(providerLabels, name) ? name : null;
}

function createRunMetrics(runId) {
  return { runId, started: performance.now(), attempts: [], blocked_providers: [] };
}

function withRunMetrics(collector, work) { return context.run(collector, work); }

function recordProviderBlocked(provider, reason) {
  const collector = context.getStore();
  const safe = safeProvider(provider), failure = safeReason(reason);
  if (!collector || !safe || !failure) return null;
  collector.blocked_providers ||= [];
  let entry = collector.blocked_providers.find((item) => item.provider === safe && item.reason === failure);
  if (!entry) {
    entry = { provider: safe, reason: failure };
    collector.blocked_providers.push(entry);
  }
  return entry;
}

function beginModelAttempt(provider, model, secrets = []) {
  const collector = context.getStore();
  const safeModel = typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,119}$/.test(model) &&
    !model.includes("://") && !secrets.some((secret) => secret && model.includes(secret));
  const attempt = {
    run_id: collector?.runId ?? null, attempt: collector ? collector.attempts.length + 1 : null,
    provider, model: safeModel ? model : "invalid_model_label", status: "pending", http_status: null,
    elapsed_ms: 0, ...Object.fromEntries(tokenFields.map((field) => [field, null])),
  };
  collector?.attempts.push(attempt);
  return attempt;
}

function finishModelAttempt(attempt, status, httpStatus, elapsedMs, data, failureReason) {
  const gemini = attempt.provider.toLowerCase() === "gemini";
  const usage = gemini ? data?.usageMetadata : data?.usage;
  Object.assign(attempt, {
    status, http_status: Number.isInteger(httpStatus) ? httpStatus : null,
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    input_tokens: count(gemini ? usage?.promptTokenCount : usage?.prompt_tokens),
    output_tokens: count(gemini ? usage?.candidatesTokenCount : usage?.completion_tokens),
    total_tokens: count(gemini ? usage?.totalTokenCount : usage?.total_tokens),
    reasoning_tokens: count(gemini ? usage?.thoughtsTokenCount : usage?.completion_tokens_details?.reasoning_tokens),
    cached_input_tokens: count(gemini ? usage?.cachedContentTokenCount : usage?.prompt_tokens_details?.cached_tokens),
  });
  if (status === "http_error" && safeReason(failureReason)) attempt.failure_reason = failureReason;
  else delete attempt.failure_reason;
  return attempt;
}

function finalizeRunMetrics(collector) {
  if (!collector) return null;
  const attempts = collector.attempts.map((attempt) => {
    const copy = { ...attempt };
    if (copy.status !== "http_error" || !safeReason(copy.failure_reason)) delete copy.failure_reason;
    return copy;
  });
  const blocked = new Map();
  for (const entry of Array.isArray(collector.blocked_providers) ? collector.blocked_providers : []) {
    const provider = safeProvider(entry?.provider), reason = safeReason(entry?.reason);
    if (provider && reason) blocked.set(`${provider}:${reason}`, { provider, reason });
  }
  const totals = Object.fromEntries(tokenFields.map((field) => {
    const known = attempts.filter((attempt) => attempt[field] !== null);
    const sum = known.reduce((total, attempt) => total + attempt[field], 0);
    const safeSum = Number.isSafeInteger(sum) ? sum : null;
    const complete = attempts.every((attempt) => attempt.status !== "pending") && known.length === attempts.length && safeSum !== null;
    return [field, {
      observed: known.length || !attempts.length ? safeSum : null,
      unknown_attempts: attempts.length - known.length,
      complete: complete ? safeSum : null,
    }];
  }));
  return {
    version: 1, finalized: true, attempt_count: attempts.length,
    run_elapsed_ms: Math.max(0, Math.round(performance.now() - collector.started)),
    model_elapsed_ms: attempts.reduce((sum, attempt) => sum + attempt.elapsed_ms, 0),
    totals, attempts, ...(blocked.size ? { blocked_providers: [...blocked.values()] } : {}),
  };
}

function formatModelIssues(metrics) {
  const issues = new Map();
  const add = (provider, reason, skipped) => {
    const name = safeProvider(provider), failure = safeReason(reason);
    if (!name || !failure) return;
    const key = `${name}:${failure}`;
    const item = issues.get(key) || { provider: name, reason: failure, attempted: false, skipped: false };
    item[skipped ? "skipped" : "attempted"] = true;
    issues.set(key, item);
  };
  for (const attempt of Array.isArray(metrics.attempts) ? metrics.attempts.slice(0, 100) : []) {
    if (attempt?.status === "http_error") add(attempt.provider, attempt.failure_reason, false);
  }
  for (const entry of Array.isArray(metrics.blocked_providers) ? metrics.blocked_providers.slice(0, 40) : []) {
    add(entry?.provider, entry?.reason, true);
  }
  if (!issues.size) return "";
  return `\nModel issue(s): ${[...issues.values()].map((item) => `${providerLabels[item.provider]}: ${failureLabels[item.reason]}${
    item.skipped ? item.attempted ? " (further requests skipped)" : " (request skipped)" : ""}`).join("; ")}.`;
}

function formatRunMetrics(metrics) {
  if (!metrics || metrics.version !== 1 || metrics.finalized !== true) return "Usage: unavailable for this run.";
  const total = metrics.totals?.total_tokens;
  const nullableCount = (value) => value === null || count(value) !== null;
  if (!total || !nullableCount(total.complete) || !nullableCount(total.observed) ||
      count(total.unknown_attempts) === null || count(metrics.attempt_count) === null ||
      count(metrics.run_elapsed_ms) === null || count(metrics.model_elapsed_ms) === null ||
      total.unknown_attempts > metrics.attempt_count ||
      (total.complete !== null && (total.unknown_attempts !== 0 || total.complete !== total.observed))) {
    return "Usage: unavailable for this run.";
  }
  const tokens = total.complete !== null ? `${total.complete} total tokens reported`
    : `${total.observed === null ? "unknown" : total.observed} observed tokens; ${total.unknown_attempts} attempt(s) with unknown usage`;
  return `Usage: ${metrics.attempt_count} model call(s), ${tokens}.\nTime: ${metrics.run_elapsed_ms} ms run / ${metrics.model_elapsed_ms} ms model requests. Cost: unpriced.${formatModelIssues(metrics)}`;
}

module.exports = { createRunMetrics, withRunMetrics, beginModelAttempt, finishModelAttempt, recordProviderBlocked, finalizeRunMetrics, formatRunMetrics };
