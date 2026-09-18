"use strict";

const RETURNED_OUTCOMES = Object.freeze([
  "completed",
  "http_error",
  "parse_error",
  "unusable",
  "transport_error",
  "timeout",
]);
const RETURNED_OUTCOME_SET = new Set(RETURNED_OUTCOMES);
const TRANSPORT_UNCERTAIN = new Set(["transport_error", "timeout"]);
const SHA256 = /^[a-f0-9]{64}$/;

function isCallable(value, name) {
  return value && typeof value[name] === "function";
}

function normalizeOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !RETURNED_OUTCOME_SET.has(value.type)) {
    return { public: Object.freeze({ type: "invalid_result" }), value: undefined };
  }
  const publicOutcome = {
    type: value.type,
    ...(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
      ? { status: value.status }
      : {}),
  };
  return {
    public: Object.freeze(publicOutcome),
    value: Object.hasOwn(value, "value") ? value.value : undefined,
  };
}

function thrownOutcome(error) {
  return {
    public: Object.freeze({
      type: ["AbortError", "TimeoutError"].includes(error?.name) ? "timeout" : "transport_error",
    }),
    value: undefined,
  };
}

function publicDecision(decision) {
  return Object.freeze({
    allowed: decision?.allowed === true,
    mode: typeof decision?.mode === "string" ? decision.mode : "enforced",
    code: typeof decision?.code === "string" ? decision.code : "ADMISSION_DENIED",
    reservationId: typeof decision?.reservationId === "string" && decision.reservationId
      ? decision.reservationId
      : null,
  });
}

function transitionResult(value, fallbackCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ ok: false, code: fallbackCode });
  }
  return Object.freeze({
    ok: value.ok === true,
    code: typeof value.code === "string" ? value.code : fallbackCode,
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(value.idempotent === true ? { idempotent: true } : {}),
  });
}

async function safelySettle(lease, outcome) {
  try {
    return transitionResult(await lease.settle({ outcome }), "INVALID_SETTLEMENT_RESULT");
  } catch {
    return Object.freeze({ ok: false, code: "SETTLEMENT_UNAVAILABLE" });
  }
}

function lifecycleResult({ ok, code, phase, decision, outcome = null, dispatch = null, settlement = null, value }) {
  return Object.freeze({
    ok,
    code,
    phase,
    decision: publicDecision(decision),
    outcome,
    dispatch,
    settlement,
    ...(ok === true ? { value } : {}),
  });
}

async function reconcileWithoutTransport(lease, decision, dispatch, code = "MODEL_DISPATCH_REPLAY") {
  const settlement = await safelySettle(lease, "transport_uncertain");
  return lifecycleResult({
    ok: false,
    code: settlement.ok === true ? code : "REPLAY_RECONCILIATION_FAILED",
    phase: "dispatch_readiness",
    decision,
    dispatch,
    settlement,
  });
}

async function cancelWithoutTransport(lease, decision, dispatch) {
  const settlement = await safelySettle(lease, "cancelled_before_dispatch");
  if (settlement.code === "ALREADY_DISPATCHED" || settlement.state === "dispatched") {
    return reconcileWithoutTransport(lease, decision, dispatch, "DISPATCH_STATE_RECONCILED");
  }
  return lifecycleResult({
    ok: false,
    code: settlement.ok === true ? "DISPATCH_NOT_READY" : "DISPATCH_CANCELLATION_FAILED",
    phase: "dispatch_readiness",
    decision,
    dispatch,
    settlement,
  });
}

/**
 * Runs one admitted model request through its complete allowance lifecycle.
 *
 * Only an explicit completed result can return a value, and only after
 * settlement succeeds. Transport code cannot change gate-owned requirements.
 */
async function dispatchAdmittedModel({
  admission,
  actionId,
  actionKey,
  authority,
  runId = null,
  requestFingerprint,
  execute,
} = {}) {
  if (!isCallable(admission, "acquire")) throw new TypeError("A production admission gate is required");
  if (typeof execute !== "function") throw new TypeError("A model transport function is required");
  if (typeof requestFingerprint !== "string" || !SHA256.test(requestFingerprint)) {
    throw new TypeError("A SHA-256 model request fingerprint is required");
  }

  let lease;
  try {
    lease = await admission.acquire(actionId, {
      actionKey,
      authority,
      runId,
      requestFingerprint,
    });
  } catch {
    return lifecycleResult({ ok: false, code: "ADMISSION_ACQUIRE_FAILED", phase: "admission", decision: null });
  }

  if (!lease || lease.allowed !== true) {
    return lifecycleResult({
      ok: false,
      code: typeof lease?.code === "string" ? lease.code : "ADMISSION_DENIED",
      phase: "admission",
      decision: lease,
    });
  }

  if (lease.mode === "disabled" && lease.code === "ADMISSION_DISABLED") {
    let outcome;
    try { outcome = normalizeOutcome(await execute()); }
    catch (error) { outcome = thrownOutcome(error); }
    const completed = outcome.public.type === "completed";
    return lifecycleResult({
      ok: completed,
      code: completed ? "MODEL_COMPLETED" : outcome.public.type === "invalid_result"
        ? "MODEL_RESULT_INVALID" : `MODEL_${outcome.public.type.toUpperCase()}`,
      phase: "transport",
      decision: lease,
      outcome: outcome.public,
      ...(completed ? { value: outcome.value } : {}),
    });
  }

  if (typeof lease.reservationId !== "string" || !lease.reservationId ||
      !isCallable(lease, "markDispatched") || !isCallable(lease, "settle")) {
    return lifecycleResult({
      ok: false,
      code: "ADMISSION_LIFECYCLE_REQUIRED",
      phase: "dispatch_readiness",
      decision: lease,
    });
  }

  let dispatch;
  try {
    dispatch = transitionResult(await lease.markDispatched(), "INVALID_DISPATCH_RESULT");
  } catch {
    dispatch = Object.freeze({ ok: false, code: "DISPATCH_READINESS_UNAVAILABLE" });
  }

  if (dispatch.idempotent === true || dispatch.code === "IDEMPOTENT_REPLAY" ||
      dispatch.code === "ALREADY_DISPATCHED") {
    return reconcileWithoutTransport(lease, lease, dispatch);
  }
  if (dispatch.ok !== true || dispatch.code !== "DISPATCH_RECORDED") {
    return cancelWithoutTransport(lease, lease, dispatch);
  }

  let outcome;
  try { outcome = normalizeOutcome(await execute()); }
  catch (error) { outcome = thrownOutcome(error); }

  const settlementOutcome = outcome.public.type === "completed"
    ? "completed"
    : TRANSPORT_UNCERTAIN.has(outcome.public.type)
      ? "transport_uncertain"
      : "failed_after_dispatch";
  const settlement = await safelySettle(lease, settlementOutcome);
  const completed = outcome.public.type === "completed" && settlement.ok === true;
  return lifecycleResult({
    ok: completed,
    code: settlement.ok !== true
      ? "LIFECYCLE_SETTLEMENT_FAILED"
      : completed
        ? "MODEL_COMPLETED"
        : outcome.public.type === "invalid_result"
          ? "MODEL_RESULT_INVALID"
          : `MODEL_${outcome.public.type.toUpperCase()}`,
    phase: "settlement",
    decision: lease,
    outcome: outcome.public,
    dispatch,
    settlement,
    ...(completed ? { value: outcome.value } : {}),
  });
}

module.exports = { RETURNED_OUTCOMES, dispatchAdmittedModel };
