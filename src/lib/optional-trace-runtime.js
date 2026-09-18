"use strict";

const OPTIONAL_TRACE_POLICY = "agent-run-receipt-only-v1";
const OPTIONAL_TRACE_HANDLE_SCHEMA = "neurohands-agent-run-audit-handle-v1";
const DEFAULT_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 5_000;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/;
const RUN_STATUSES = new Set(["blocked", "completed", "error"]);

const mandatoryAuditReceipts = new WeakMap();
const approvedRuntimes = new WeakMap();
const approvedHandles = new WeakMap();

function fixedResult(status, code, attempts = 0, settlement = "cancelled_before_dispatch") {
  return Object.freeze({ status, code, attempts, settlement });
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS);
}

function safeRunId(value) {
  const candidate = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : value;
  return typeof candidate === "string" && RECEIPT_ID.test(candidate) ? candidate : null;
}

function issueMandatoryAgentRunAuditReceipt(runId, status) {
  const safeId = safeRunId(runId);
  if (!safeId || !RUN_STATUSES.has(status)) return null;
  const receipt = Object.freeze({ persisted: true, runId: safeId, status });
  mandatoryAuditReceipts.set(receipt, Object.freeze({ runId: safeId, status }));
  return receipt;
}

function createApprovedOptionalTraceRuntime({
  enabled = false,
  approvedPolicy,
  dispatch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onOutcome,
} = {}) {
  if (enabled !== true || approvedPolicy !== OPTIONAL_TRACE_POLICY || typeof dispatch !== "function") return null;
  const runtime = Object.freeze({ enabled: true, policy: OPTIONAL_TRACE_POLICY });
  approvedRuntimes.set(runtime, {
    dispatch,
    timeoutMs: boundedTimeout(timeoutMs),
    onOutcome: typeof onOutcome === "function" ? onOutcome : null,
    scheduledReceipts: new WeakSet(),
    state: "ready",
  });
  return runtime;
}

function readApprovedOptionalTraceHandle(handle) {
  const payload = handle && typeof handle === "object" ? approvedHandles.get(handle) : null;
  return payload ? Object.freeze({ ...payload }) : null;
}

function safeOutcome(config, result) {
  if (!config.onOutcome) return;
  try {
    void Promise.resolve(config.onOutcome(result)).catch(() => {});
  } catch {
    // Optional diagnostics cannot create a customer-path failure.
  }
}

function settleDispatchReceipt(receipt) {
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt) &&
      receipt.accepted === true && typeof receipt.receiptId === "string" && RECEIPT_ID.test(receipt.receiptId)) {
    return fixedResult("exported", "TRACE_EXPORTED", 1, "completed");
  }
  if (receipt?.rejected === true) return fixedResult("rejected", "TRACE_EXPORT_REJECTED", 1, "failed_after_dispatch");
  return fixedResult("uncertain", "TRACE_EXPORT_UNCERTAIN", 1, "transport_uncertain");
}

function dispatchOnce(config, handle) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fixedResult("timeout", "TRACE_EXPORT_TIMEOUT", 1, "transport_uncertain"));
    }, config.timeoutMs);
    timer.unref?.();
  });
  const attempt = Promise.resolve()
    .then(() => config.dispatch(handle, { signal: controller.signal }))
    .then(settleDispatchReceipt)
    .catch(() => fixedResult("uncertain", "TRACE_EXPORT_UNCERTAIN", 1, "transport_uncertain"));
  void Promise.race([attempt, timeout]).then((result) => {
    clearTimeout(timer);
    if (result.status !== "exported") controller.abort();
    // A failed or indeterminate optional transport is unavailable until a new
    // approved runtime is installed. This caps ignored-abort work at one
    // attempt instead of allowing diagnostics to consume frontline resources.
    config.state = result.status === "exported" ? "ready" : "suspended";
    safeOutcome(config, result);
  }).catch(() => {
    clearTimeout(timer);
    controller.abort();
    config.state = "suspended";
  });
}

function scheduleOptionalTraceAfterAudit({ runtime = null, auditReceipt = null } = {}) {
  const config = runtime && typeof runtime === "object" ? approvedRuntimes.get(runtime) : null;
  if (!config) return fixedResult("disabled", "TRACE_RUNTIME_DISABLED");
  const audit = auditReceipt && typeof auditReceipt === "object"
    ? mandatoryAuditReceipts.get(auditReceipt)
    : null;
  if (!audit) return fixedResult("skipped", "TRACE_SKIPPED_AUDIT_UNCONFIRMED");
  if (config.scheduledReceipts.has(auditReceipt)) return fixedResult("skipped", "TRACE_ALREADY_SCHEDULED");
  if (config.state === "suspended") return fixedResult("skipped", "TRACE_RUNTIME_SUSPENDED");
  if (config.state === "in_flight") {
    const busy = fixedResult("skipped", "TRACE_RUNTIME_BUSY");
    safeOutcome(config, busy);
    return busy;
  }
  config.scheduledReceipts.add(auditReceipt);
  config.state = "in_flight";

  const handle = Object.freeze({ schema: OPTIONAL_TRACE_HANDLE_SCHEMA });
  approvedHandles.set(handle, Object.freeze({
    schema: OPTIONAL_TRACE_HANDLE_SCHEMA,
    run_id: audit.runId,
    status: audit.status,
  }));
  try {
    setImmediate(() => dispatchOnce(config, handle));
  } catch {
    config.state = "suspended";
    const failed = fixedResult("skipped", "TRACE_RUNTIME_SUSPENDED");
    safeOutcome(config, failed);
    return failed;
  }
  return fixedResult("scheduled", "TRACE_EXPORT_SCHEDULED", 0, "scheduled_after_audit");
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  OPTIONAL_TRACE_HANDLE_SCHEMA,
  OPTIONAL_TRACE_POLICY,
  createApprovedOptionalTraceRuntime,
  issueMandatoryAgentRunAuditReceipt,
  readApprovedOptionalTraceHandle,
  scheduleOptionalTraceAfterAudit,
};
