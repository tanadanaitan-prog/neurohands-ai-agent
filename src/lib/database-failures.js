const MAX_DATABASE_ERROR_BYTES = 8 * 1024;

const DATABASE_FAILURES = Object.freeze({
  READ_ONLY: "database_read_only",
  CONNECTION_EXHAUSTED: "database_connection_exhausted",
  TIMEOUT: "database_timeout",
  UNAVAILABLE: "database_unavailable",
  REQUEST_FAILED: "database_request_failed",
});

const SAFE_DATABASE_FAILURES = new Set(Object.values(DATABASE_FAILURES));

function classifyDatabaseFailure(status, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return status === 504 ? DATABASE_FAILURES.TIMEOUT : DATABASE_FAILURES.REQUEST_FAILED;
  }
  const code = typeof payload.code === "string" ? payload.code.trim().toUpperCase() : "";
  if (code === "25006") return DATABASE_FAILURES.READ_ONLY;
  if (code === "53300" || code === "PGRST003") return DATABASE_FAILURES.CONNECTION_EXHAUSTED;
  if (["57014", "25P03", "25P04"].includes(code)) return DATABASE_FAILURES.TIMEOUT;
  if (["PGRST000", "PGRST001", "PGRST002", "57P01", "57P02", "57P03"].includes(code)) {
    return DATABASE_FAILURES.UNAVAILABLE;
  }
  return status === 504 ? DATABASE_FAILURES.TIMEOUT : DATABASE_FAILURES.REQUEST_FAILED;
}

function cancelWithoutWaiting(target) {
  try { Promise.resolve(target?.cancel()).catch(() => {}); } catch {}
}

async function readDatabaseFailure(response, { signal, maxBytes = MAX_DATABASE_ERROR_BYTES } = {}) {
  if (signal?.aborted) {
    cancelWithoutWaiting(response?.body);
    return DATABASE_FAILURES.TIMEOUT;
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    cancelWithoutWaiting(response?.body);
    return DATABASE_FAILURES.REQUEST_FAILED;
  }
  const byteLimit = Math.min(maxBytes, MAX_DATABASE_ERROR_BYTES);
  let reader, onAbort;
  try {
    if (!response?.body || typeof response.body.getReader !== "function") {
      return classifyDatabaseFailure(response?.status, null);
    }
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
      if (signal?.aborted) return DATABASE_FAILURES.TIMEOUT;
      if (++reads > byteLimit + 1) return DATABASE_FAILURES.REQUEST_FAILED;
      const part = await (abortPromise ? Promise.race([reader.read(), abortPromise]) : reader.read());
      if (part === aborted || signal?.aborted) return DATABASE_FAILURES.TIMEOUT;
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) return DATABASE_FAILURES.REQUEST_FAILED;
      bytes += part.value.byteLength;
      if (bytes > byteLimit) return DATABASE_FAILURES.REQUEST_FAILED;
      if (part.value.byteLength) chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return classifyDatabaseFailure(response.status, payload);
  } catch {
    return signal?.aborted ? DATABASE_FAILURES.TIMEOUT : DATABASE_FAILURES.REQUEST_FAILED;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    cancelWithoutWaiting(reader);
    try { reader?.releaseLock(); } catch {}
  }
}

function databaseOperationError(code) {
  const safe = SAFE_DATABASE_FAILURES.has(code) ? code : DATABASE_FAILURES.REQUEST_FAILED;
  const error = new Error("Database operation failed");
  error.code = safe;
  return error;
}

function databaseFailureCode(error) {
  return SAFE_DATABASE_FAILURES.has(error?.code) ? error.code : null;
}

module.exports = {
  MAX_DATABASE_ERROR_BYTES,
  DATABASE_FAILURES,
  classifyDatabaseFailure,
  readDatabaseFailure,
  databaseOperationError,
  databaseFailureCode,
};
