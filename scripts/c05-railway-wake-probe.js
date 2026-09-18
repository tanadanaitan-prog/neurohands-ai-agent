"use strict";

const { performance } = require("node:perf_hooks");
const { version: PACKAGE_VERSION } = require("../package.json");

const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const TRANSIENT_WAKE_STATUSES = new Set([502, 503, 504]);
const MAX_RESPONSE_BYTES = 64 * 1024;

class WakeProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = "WakeProbeError";
    this.code = code;
  }
}

function targetOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new WakeProbeError("INVALID_BASE_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new WakeProbeError("INVALID_BASE_URL");
  }
  return url.origin;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WakeProbeError(code);
  }
  return value;
}

async function responseJson(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new WakeProbeError("RESPONSE_TOO_LARGE");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new WakeProbeError("RESPONSE_TOO_LARGE");
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new WakeProbeError("INVALID_JSON_RESPONSE");
  }
}

function attemptEvidence({ status = null, elapsedMs, errorCode = null }) {
  return Object.freeze({
    status,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    ...(errorCode ? { errorCode } : {}),
  });
}

async function requestOnce({ fetchImpl, url, timeoutMs }) {
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = performance.now() - started;
    if (response.status !== 200) {
      return { evidence: attemptEvidence({ status: response.status, elapsedMs }), body: null };
    }
    return {
      evidence: attemptEvidence({ status: response.status, elapsedMs }),
      body: await responseJson(response),
    };
  } catch (error) {
    const code = error instanceof WakeProbeError
      ? error.code
      : error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "REQUEST_TIMEOUT"
        : "REQUEST_FAILED";
    return {
      evidence: attemptEvidence({ elapsedMs: performance.now() - started, errorCode: code }),
      body: null,
    };
  }
}

async function boundedWakeRequest({ fetchImpl, url, timeoutMs, retryDelayMs, wait }) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await requestOnce({ fetchImpl, url, timeoutMs });
    attempts.push(result.evidence);
    if (result.evidence.status === 200) return { attempts, body: result.body };
    const mayRetry = attempt === 0 && (
      result.evidence.errorCode === "REQUEST_TIMEOUT" ||
      result.evidence.errorCode === "REQUEST_FAILED" ||
      TRANSIENT_WAKE_STATUSES.has(result.evidence.status)
    );
    if (!mayRetry) return { attempts, body: null };
    if (retryDelayMs > 0) await wait(retryDelayMs);
  }
  return { attempts, body: null };
}

/**
 * Executes only read-only health requests against an inactive Railway test
 * service. It does not call LINE, a model provider, or a customer endpoint.
 */
async function probeInactiveRailwayWake({
  baseUrl,
  expectedCommit,
  expectedVersion = PACKAGE_VERSION,
  timeoutMs = 15_000,
  retryDelayMs = 1_000,
  fetchImpl = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const origin = targetOrigin(baseUrl);
  if (typeof expectedCommit !== "string" || !FULL_COMMIT_SHA.test(expectedCommit)) {
    throw new WakeProbeError("INVALID_EXPECTED_COMMIT");
  }
  if (typeof expectedVersion !== "string" || !expectedVersion.trim() || expectedVersion.length > 64) {
    throw new WakeProbeError("INVALID_EXPECTED_VERSION");
  }
  if (typeof fetchImpl !== "function" || typeof wait !== "function") {
    throw new WakeProbeError("INVALID_PROBE_ADAPTER");
  }
  boundedInteger(timeoutMs, 1_000, 60_000, "INVALID_TIMEOUT");
  boundedInteger(retryDelayMs, 0, 5_000, "INVALID_RETRY_DELAY");

  const started = performance.now();
  const version = await boundedWakeRequest({
    fetchImpl,
    url: `${origin}/version`,
    timeoutMs,
    retryDelayMs,
    wait,
  });
  if (version.attempts.at(-1)?.status !== 200 || !version.body) {
    throw new WakeProbeError("VERSION_UNAVAILABLE_AFTER_WAKE");
  }
  if (version.body.version !== expectedVersion) {
    throw new WakeProbeError("APPLICATION_VERSION_MISMATCH");
  }
  if (version.body.commit !== expectedCommit) {
    throw new WakeProbeError("REVISION_MISMATCH");
  }

  const readiness = await boundedWakeRequest({
    fetchImpl,
    url: `${origin}/ready`,
    timeoutMs,
    retryDelayMs,
    wait,
  });
  if (readiness.attempts.at(-1)?.status !== 200 || readiness.body?.ready !== true) {
    throw new WakeProbeError("READINESS_UNCONFIRMED_AFTER_WAKE");
  }

  return Object.freeze({
    schemaVersion: "1.0.0",
    controlId: "C05",
    scope: "inactive_railway_test_only",
    result: "infrastructure_probe_passed_release_control_incomplete",
    targetOrigin: origin,
    expectedCommit,
    observedCommit: version.body.commit,
    applicationVersion: version.body.version,
    totalElapsedMs: Math.max(0, Math.round(performance.now() - started)),
    wake: Object.freeze({ endpoint: "/version", attempts: Object.freeze(version.attempts) }),
    readiness: Object.freeze({ endpoint: "/ready", attempts: Object.freeze(readiness.attempts) }),
    evidence: Object.freeze({
      reviewedRevisionMatched: true,
      readinessConfirmed: true,
      customerResponseTested: false,
      lineDeliveryTested: false,
      ramMeasured: false,
      cpuMeasured: false,
    }),
  });
}

function cliArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!["--base-url", "--expected-commit", "--timeout-ms", "--retry-delay-ms"].includes(key) ||
        index + 1 >= values.length) {
      throw new WakeProbeError("INVALID_ARGUMENTS");
    }
    if (Object.hasOwn(options, key)) throw new WakeProbeError("INVALID_ARGUMENTS");
    options[key] = values[index += 1];
  }
  if (!options["--base-url"] || !options["--expected-commit"]) {
    throw new WakeProbeError("INVALID_ARGUMENTS");
  }
  return {
    baseUrl: options["--base-url"],
    expectedCommit: options["--expected-commit"],
    ...(options["--timeout-ms"] ? { timeoutMs: Number(options["--timeout-ms"]) } : {}),
    ...(options["--retry-delay-ms"] ? { retryDelayMs: Number(options["--retry-delay-ms"]) } : {}),
  };
}

async function main() {
  try {
    const result = await probeInactiveRailwayWake(cliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof WakeProbeError ? error.code : "PROBE_FAILED";
    process.stderr.write(`${JSON.stringify({ schemaVersion: "1.0.0", controlId: "C05", result: "failed", code })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { WakeProbeError, cliArguments, probeInactiveRailwayWake };
