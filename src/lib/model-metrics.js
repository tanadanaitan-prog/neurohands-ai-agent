const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();
const tokenFields = ["input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "cached_input_tokens"];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function createRunMetrics(runId) {
  return { runId, started: performance.now(), attempts: [] };
}

function withRunMetrics(collector, work) { return context.run(collector, work); }

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

function finishModelAttempt(attempt, status, httpStatus, elapsedMs, data) {
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
  return attempt;
}

function finalizeRunMetrics(collector) {
  if (!collector) return null;
  const attempts = collector.attempts.map((attempt) => ({ ...attempt }));
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
    totals, attempts,
  };
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
  return `Usage: ${metrics.attempt_count} model call(s), ${tokens}.\nTime: ${metrics.run_elapsed_ms} ms run / ${metrics.model_elapsed_ms} ms model requests. Cost: unpriced.`;
}

module.exports = { createRunMetrics, withRunMetrics, beginModelAttempt, finishModelAttempt, finalizeRunMetrics, formatRunMetrics };
