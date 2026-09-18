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

function publicAlert(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const states = new Set([
    "disabled", "not_required", "invalid_alert_context", "invalid_allowance_evidence",
    "claim_failed", "already_delivered", "prior_failure", "in_progress", "uncertain",
    "idempotency_conflict", "delivery_failed", "delivery_unconfirmed",
    "failure_recording_failed", "delivery_recording_uncertain", "continuity_record_unconfirmed",
    "claim_timeout", "delivery_timeout", "scheduled", "delivered",
  ]);
  return Object.freeze({
    state: states.has(value.state) ? value.state : "invalid_alert_result",
    delivered: value.delivered === true,
    attempted: value.attempted === true,
    newlyDelivered: value.newlyDelivered === true,
    failureRecorded: value.failureRecorded === true,
  });
}

function publicContinuity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({
    handled: value.handled === true,
    completed: false,
    ...(typeof value.response === "string" && value.response.trim()
      ? { response: value.response.slice(0, 4900) }
      : {}),
    reasonRecorded: value.reasonRecorded === true,
    ...(value.alert ? { alert: publicAlert(value.alert) } : {}),
  });
}

async function invokeControl(runtime, method, input) {
  if (!runtime || runtime.enabled !== true || typeof runtime[method] !== "function") return null;
  try { return await runtime[method](input); }
  catch { return null; }
}

async function safelySettle(lease, outcome) {
  try {
    return transitionResult(await lease.settle({ outcome }), "INVALID_SETTLEMENT_RESULT");
  } catch {
    return Object.freeze({ ok: false, code: "SETTLEMENT_UNAVAILABLE" });
  }
}

function lifecycleResult({
  ok, code, phase, decision, outcome = null, dispatch = null, settlement = null,
  value, alert = null, continuity = null,
}) {
  return Object.freeze({
    ok,
    code,
    phase,
    decision: publicDecision(decision),
    outcome,
    dispatch,
    settlement,
    ...(alert ? { alert: publicAlert(alert) } : {}),
    ...(continuity ? { continuity: publicContinuity(continuity) } : {}),
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
  continuityRuntime = null,
  continuityContext = null,
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
    const decision = publicDecision(lease);
    const continuity = decision.code === "CONTINUITY_HARD_LIMIT"
      ? await invokeControl(continuityRuntime, "handleHardLimit", {
          ...(continuityContext && typeof continuityContext === "object" ? continuityContext : {}),
          decision,
          actionKey,
        })
      : null;
    return lifecycleResult({
      ok: false,
      code: decision.code,
      phase: "admission",
      decision: lease,
      continuity,
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
  let alert = null;
  if (completed && lease.code === "ALLOWED_WITH_ALERT" && continuityRuntime?.enabled === true &&
      typeof continuityRuntime.afterCompleted === "function") {
    alert = Object.freeze({ state: "scheduled" });
    // Founder delivery is optional follow-up work. It must never hold an
    // already-settled customer result; the runtime owns its bounded adapters,
    // durable claim and reconciliation state.
    void invokeControl(continuityRuntime, "afterCompleted", {
      ...(continuityContext && typeof continuityContext === "object" ? continuityContext : {}),
      decision: publicDecision(lease),
      actionKey,
    });
  }
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
    alert,
    ...(completed ? { value: outcome.value } : {}),
  });
}

module.exports = { RETURNED_OUTCOMES, dispatchAdmittedModel };
