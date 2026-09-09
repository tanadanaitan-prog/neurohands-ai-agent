const MAX_ERROR_BYTES = 16 * 1024;
const GENERIC_FAILURE = "http_error";
const failureCodes = new Map([
  ["credit_balance_exhausted", "credit_exhausted"],
  ["insufficient_quota", "quota_exhausted"],
  ["organization_spend_limit_exceeded", "spend_limit_reached"],
  ["project_spend_limit_exceeded", "spend_limit_reached"],
  ["organization_usage_limit_exceeded", "quota_exhausted"],
  ["billing_hard_limit_reached", "spend_limit_reached"],
  ["invalid_api_key", "authentication_rejected"],
]);
const permanentReasons = new Set(failureCodes.values());
const routes = new Set(["gemini", "fallback", "third"]);

function classifyProviderFailure(status, payload) {
  if (status === 401) return "authentication_rejected";
  if (!Number.isInteger(status) || status < 400 || status > 599 ||
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      !payload.error || typeof payload.error !== "object" || Array.isArray(payload.error)) return GENERIC_FAILURE;
  for (const value of [payload.error.code, payload.error.type]) {
    if (typeof value !== "string") continue;
    const reason = failureCodes.get(value.trim().toLowerCase());
    if (reason) return reason;
  }
  return GENERIC_FAILURE;
}

function cancelWithoutWaiting(target) {
  // A broken upstream can also leave cancellation pending; never extend the request deadline.
  try { Promise.resolve(target?.cancel()).catch(() => {}); } catch {}
}

async function readProviderFailure(response, { signal, maxBytes = MAX_ERROR_BYTES } = {}) {
  if (response?.status === 401) {
    cancelWithoutWaiting(response.body);
    return "authentication_rejected";
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || signal?.aborted) {
    cancelWithoutWaiting(response?.body);
    return GENERIC_FAILURE;
  }
  const byteLimit = Math.min(maxBytes, MAX_ERROR_BYTES);
  let reader, onAbort;
  try {
    if (!response?.body || typeof response.body.getReader !== "function") return GENERIC_FAILURE;
    reader = response.body.getReader();
    const aborted = Symbol("aborted");
    const abortPromise = signal ? new Promise((resolve) => {
      onAbort = () => resolve(aborted);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }) : null;
    const chunks = [];
    let bytes = 0, reads = 0;
    while (true) {
      // Also bound empty chunks, which otherwise consume no byte budget.
      if (signal?.aborted || ++reads > byteLimit + 1) return GENERIC_FAILURE;
      const part = await (abortPromise ? Promise.race([reader.read(), abortPromise]) : reader.read());
      if (part === aborted || signal?.aborted) return GENERIC_FAILURE;
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) return GENERIC_FAILURE;
      bytes += part.value.byteLength;
      if (bytes > byteLimit) return GENERIC_FAILURE;
      if (part.value.byteLength) chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return classifyProviderFailure(response.status, payload);
  } catch {
    return GENERIC_FAILURE;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    cancelWithoutWaiting(reader);
    try { reader?.releaseLock(); } catch {}
  }
}

function createProviderFailures() {
  // The owner passes static route labels. No endpoint, credential or provider body is retained.
  const blocked = new Map();
  return {
    block(route, reason) {
      if (routes.has(route) && permanentReasons.has(reason)) blocked.set(route, reason);
    },
    get(route) { return blocked.get(route) || null; },
    entries() { return [...blocked].map(([route, reason]) => ({ route, reason })); },
  };
}

module.exports = { MAX_ERROR_BYTES, classifyProviderFailure, readProviderFailure, createProviderFailures };
