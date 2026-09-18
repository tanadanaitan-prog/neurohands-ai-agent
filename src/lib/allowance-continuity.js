"use strict";

const { createHash } = require("node:crypto");

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const ALERT_KINDS = new Set(["threshold", "hard_limit"]);
const POLICY_VERSION = "allowance-continuity.v1";
const DEFAULT_ADAPTER_TIMEOUT_MS = 1_000;
const MAX_ADAPTER_TIMEOUT_MS = 5_000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function staticResponseDigest(value) {
  return typeof value === "string" ? digest({ text: value.trim() }) : null;
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function validDate(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function normalizeAllowance(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.poolId !== "string" || !KEY.test(value.poolId) ||
      !Number.isSafeInteger(value.remaining) || value.remaining < 0 ||
      typeof value.unit !== "string" || !/^[A-Za-z][A-Za-z0-9 _.-]{0,31}$/.test(value.unit) ||
      !validDate(value.verifiedAt) ||
      typeof value.evidenceRef !== "string" || !KEY.test(value.evidenceRef) ||
      (value.resetAt !== null && value.resetAt !== undefined && !validDate(value.resetAt)) ||
      (value.resetEvidenceRef !== null && value.resetEvidenceRef !== undefined &&
        (typeof value.resetEvidenceRef !== "string" || !KEY.test(value.resetEvidenceRef))) ||
      (!value.resetAt && !value.resetEvidenceRef)) {
    throw new TypeError("Verified allowance and reset evidence are required");
  }
  if (kind === "hard_limit" && value.remaining !== 0) {
    throw new TypeError("A hard-limit alert requires verified zero remaining allowance");
  }
  return immutable({
    poolId: value.poolId,
    remaining: value.remaining,
    unit: value.unit,
    verifiedAt: new Date(value.verifiedAt).toISOString(),
    evidenceRef: value.evidenceRef,
    resetAt: value.resetAt ? new Date(value.resetAt).toISOString() : null,
    resetEvidenceRef: value.resetEvidenceRef || null,
  });
}

function alertMessage(kind, allowance) {
  const reset = allowance.resetAt
    ? `reset at ${allowance.resetAt}`
    : `reset evidence ${allowance.resetEvidenceRef}`;
  if (kind === "threshold") {
    return `Neurohands allowance alert: ${allowance.poolId} has ${allowance.remaining} ${allowance.unit} remaining, verified at ${allowance.verifiedAt} (${allowance.evidenceRef}); ${reset}. Spending has not been stopped.`;
  }
  return `Neurohands hard limit: ${allowance.poolId} has 0 ${allowance.unit} remaining, verified at ${allowance.verifiedAt} (${allowance.evidenceRef}); ${reset}. The requested work was not completed and Frontline is using its static continuity response.`;
}

function alertResult(state, {
  delivered = false,
  attempted = false,
  newlyDelivered = false,
  failureRecorded = false,
} = {}) {
  return immutable({ state, delivered, attempted, newlyDelivered, failureRecorded });
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ADAPTER_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_ADAPTER_TIMEOUT_MS);
}

async function callAdapter(invoke, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(Object.freeze({ state: "timeout", value: null }));
    }, timeoutMs);
  });
  const attempt = Promise.resolve()
    .then(() => invoke(controller.signal))
    .then((value) => Object.freeze({ state: "resolved", value }))
    .catch(() => Object.freeze({ state: "rejected", value: null }));
  const result = await Promise.race([attempt, deadline]);
  clearTimeout(timer);
  if (result.state !== "resolved") controller.abort();
  return result;
}

function disabledRuntime() {
  return Object.freeze({
    enabled: false,
    async afterCompleted() { return alertResult("disabled"); },
    async handleHardLimit() { return immutable({ handled: false, completed: false }); },
  });
}

/**
 * Creates the alert/continuity boundary around an already-authoritative
 * admission decision. An enabled runtime requires a durable, atomic alert
 * claim store. The notifier is called at most once for a newly claimed key;
 * this module never retries delivery.
 */
function createAllowanceContinuityRuntime({
  enabled = false,
  store = null,
  notifier = null,
  founderDestination = null,
  staticResponse = null,
  approval = null,
  adapterTimeoutMs = DEFAULT_ADAPTER_TIMEOUT_MS,
} = {}) {
  if (!enabled) return disabledRuntime();
  const storeReady = store?.durable === true &&
    ["claimAlert", "finishAlert", "recordContinuity"].every((name) => typeof store?.[name] === "function");
  if (!storeReady) throw new TypeError("An enabled continuity runtime requires a durable alert and event store");
  if (typeof notifier?.send !== "function") throw new TypeError("An enabled continuity runtime requires a founder notifier");
  if (typeof founderDestination !== "string" || !founderDestination.trim() || founderDestination.length > 192) {
    throw new TypeError("An enabled continuity runtime requires a private founder destination");
  }
  if (typeof staticResponse !== "string" || !staticResponse.trim() || staticResponse.length > 4900) {
    throw new TypeError("An enabled continuity runtime requires an approved static continuity response");
  }
  const responseText = staticResponse.trim();
  const responseDigest = staticResponseDigest(responseText);
  if (!approval || approval.approved !== true || approval.policyVersion !== POLICY_VERSION ||
      approval.staticResponseDigest !== responseDigest || typeof approval.approvalRef !== "string" ||
      !KEY.test(approval.approvalRef)) {
    throw new TypeError("An enabled continuity runtime requires exact policy and response approval evidence");
  }
  const approvalRef = approval.approvalRef;
  const destination = founderDestination.trim();
  const operationTimeout = boundedTimeout(adapterTimeoutMs);

  async function finishClaim(claim, state, failureCode) {
    try {
      const outcome = await callAdapter((signal) => store.finishAlert({
        claimId: claim.claimId,
        fingerprint: claim.fingerprint,
        state,
        failureCode,
        signal,
      }), operationTimeout);
      const finished = outcome.state === "resolved" ? outcome.value : null;
      return finished?.recorded === true;
    } catch {
      return false;
    }
  }

  const finishFailure = (claim, failureCode) => finishClaim(claim, "failed", failureCode);

  async function notify({ kind, alertKey, actionKey, allowance: rawAllowance }) {
    if (!ALERT_KINDS.has(kind) || typeof alertKey !== "string" || !KEY.test(alertKey) ||
        typeof actionKey !== "string" || !KEY.test(actionKey)) {
      return alertResult("invalid_alert_context");
    }
    let allowance;
    try { allowance = normalizeAllowance(rawAllowance, kind); }
    catch { return alertResult("invalid_allowance_evidence"); }
    const message = alertMessage(kind, allowance);
    // The stable alert key identifies one threshold/hard-limit episode. The
    // triggering action is retained in the durable claim but is deliberately
    // outside the fingerprint so concurrent accepted actions cannot turn one
    // episode into conflicting alert identities.
    const fingerprint = digest({
      policyVersion: POLICY_VERSION,
      approvalRef,
      kind,
      alertKey,
      destination,
      allowance,
      message,
    });
    let claim;
    try {
      const outcome = await callAdapter((signal) => store.claimAlert({
        alertKey,
        fingerprint,
        kind,
        actionKey,
        destination,
        allowance,
        policyVersion: POLICY_VERSION,
        approvalRef,
        signal,
      }), operationTimeout);
      if (outcome.state === "timeout") return alertResult("claim_timeout");
      claim = outcome.state === "resolved" ? outcome.value : null;
    } catch {
      return alertResult("claim_failed");
    }
    if (!claim || typeof claim !== "object") return alertResult("claim_failed");
    if (claim.state === "delivered" && claim.fingerprint === fingerprint) {
      return alertResult("already_delivered", { delivered: true });
    }
    if (claim.state === "failed" && claim.fingerprint === fingerprint) {
      return alertResult("prior_failure", { failureRecorded: true });
    }
    if (["claimed", "in_progress", "uncertain"].includes(claim.state) && claim.fingerprint === fingerprint &&
        claim.newClaim !== true) {
      return alertResult(claim.state === "claimed" ? "in_progress" : claim.state);
    }
    if (claim.state !== "claimed" || claim.newClaim !== true || claim.fingerprint !== fingerprint ||
        typeof claim.claimId !== "string" || !KEY.test(claim.claimId)) {
      return alertResult(claim.state === "conflict" ? "idempotency_conflict" : "claim_failed");
    }

    let receipt;
    try {
      // Exactly one transport attempt is permitted for a new durable claim.
      const outcome = await callAdapter((signal) => notifier.send({ destination, message, alertKey, kind, signal }), operationTimeout);
      if (outcome.state === "timeout") {
        const uncertaintyRecorded = await finishClaim({ ...claim, fingerprint }, "uncertain", "delivery_timeout");
        return alertResult(uncertaintyRecorded ? "delivery_timeout" : "delivery_recording_uncertain", {
          attempted: true,
        });
      }
      if (outcome.state !== "resolved") throw new Error("Founder delivery failed");
      receipt = outcome.value;
    } catch {
      const failureRecorded = await finishFailure({ ...claim, fingerprint }, "transport_failed");
      return alertResult(failureRecorded ? "delivery_failed" : "failure_recording_failed", {
        attempted: true,
        failureRecorded,
      });
    }
    if (receipt?.delivered !== true || typeof receipt.receiptId !== "string" || !RECEIPT.test(receipt.receiptId)) {
      const failureRecorded = await finishFailure({ ...claim, fingerprint }, "delivery_unconfirmed");
      return alertResult(failureRecorded ? "delivery_unconfirmed" : "failure_recording_failed", {
        attempted: true,
        failureRecorded,
      });
    }
    try {
      const outcome = await callAdapter((signal) => store.finishAlert({
        claimId: claim.claimId,
        fingerprint,
        state: "delivered",
        receiptId: receipt.receiptId,
        signal,
      }), operationTimeout);
      const finished = outcome.state === "resolved" ? outcome.value : null;
      if (finished?.recorded === true && finished?.state === "delivered") {
        return alertResult("delivered", { delivered: true, attempted: true, newlyDelivered: true });
      }
    } catch {
      // A transport receipt without durable completion remains uncertain. The
      // original claim prevents an automatic retry and no delivery is claimed.
    }
    return alertResult("delivery_recording_uncertain", { attempted: true });
  }

  return Object.freeze({
    enabled: true,

    async afterCompleted({ decision, alertKey, actionKey, allowance } = {}) {
      if (decision?.allowed !== true || decision?.code !== "ALLOWED_WITH_ALERT") {
        return alertResult("not_required");
      }
      return notify({ kind: "threshold", alertKey, actionKey, allowance });
    },

    async handleHardLimit({ decision, eventKey, alertKey, actionKey, allowance } = {}) {
      if (decision?.allowed === true || decision?.code !== "CONTINUITY_HARD_LIMIT" ||
          decision?.mode !== "continuity" || typeof eventKey !== "string" || !KEY.test(eventKey) ||
          typeof actionKey !== "string" || !KEY.test(actionKey)) {
        return immutable({ handled: false, completed: false });
      }
      let normalized;
      try { normalized = normalizeAllowance(allowance, "hard_limit"); }
      catch {
        return immutable({
          handled: true,
          completed: false,
          response: responseText,
          reasonRecorded: false,
          alert: alertResult("invalid_allowance_evidence"),
        });
      }
      const eventFingerprint = digest({
        eventKey,
        actionKey,
        reasonCode: "CONTINUITY_HARD_LIMIT",
        allowance: normalized,
        response: responseText,
        policyVersion: POLICY_VERSION,
        approvalRef,
      });
      let recorded = false;
      try {
        const outcome = await callAdapter((signal) => store.recordContinuity({
          eventKey,
          fingerprint: eventFingerprint,
          actionKey,
          reasonCode: "CONTINUITY_HARD_LIMIT",
          completed: false,
          allowance: normalized,
          responseCode: "STATIC_CONTINUITY_RESPONSE",
          responseDigest,
          policyVersion: POLICY_VERSION,
          approvalRef,
          signal,
        }), operationTimeout);
        const result = outcome.state === "resolved" ? outcome.value : null;
        recorded = result?.recorded === true && result?.conflict !== true;
      } catch {
        recorded = false;
      }
      const alert = recorded
        ? await notify({
            kind: "hard_limit",
            alertKey,
            actionKey,
            allowance: normalized,
          })
        : alertResult("continuity_record_unconfirmed");
      return immutable({
        handled: true,
        completed: false,
        response: responseText,
        reasonRecorded: recorded,
        alert,
      });
    },
  });
}

module.exports = {
  POLICY_VERSION,
  alertMessage,
  createAllowanceContinuityRuntime,
  normalizeAllowance,
  staticResponseDigest,
};
