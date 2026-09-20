"use strict";

const { createHash } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_STATES = new Set(["claimed", "delivered", "failed", "uncertain", "conflict"]);
const FINISH_STATES = new Set(["delivered", "failed", "uncertain"]);

function digest(namespace, value) {
  return createHash("sha256").update(`${namespace}\0${String(value)}`).digest("hex");
}

function rpcError() {
  const error = new Error("The durable allowance continuity store is unavailable");
  error.code = "ALLOWANCE_CONTINUITY_RPC_FAILED";
  return error;
}

function abortError() {
  const error = new Error("The durable allowance continuity request was aborted");
  error.name = "AbortError";
  error.code = "ALLOWANCE_CONTINUITY_ABORTED";
  return error;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function publicClaim(value) {
  try {
    const state = CLAIM_STATES.has(value?.state) ? value.state : "conflict";
    const fingerprint = typeof value?.fingerprint === "string" && SHA256.test(value.fingerprint)
      ? value.fingerprint
      : null;
    const claimId = typeof value?.claim_id === "string" && UUID.test(value.claim_id)
      ? value.claim_id
      : null;
    const newClaim = state === "claimed" && value?.new_claim === true && claimId !== null && fingerprint !== null;
    return Object.freeze({ state, newClaim, claimId, fingerprint });
  } catch {
    return Object.freeze({ state: "conflict", newClaim: false, claimId: null, fingerprint: null });
  }
}

function publicFinish(value) {
  try {
    const state = CLAIM_STATES.has(value?.state) ? value.state : "conflict";
    return Object.freeze({ recorded: value?.recorded === true, state });
  } catch {
    return Object.freeze({ recorded: false, state: "conflict" });
  }
}

function publicContinuity(value) {
  try {
    return Object.freeze({
      recorded: value?.recorded === true,
      conflict: value?.conflict === true,
      idempotent: value?.idempotent === true,
    });
  } catch {
    return Object.freeze({ recorded: false, conflict: true, idempotent: false });
  }
}

function createSupabaseAllowanceContinuityStore({ rpc } = {}) {
  if (typeof rpc !== "function") throw new TypeError("A server-only Supabase RPC function is required");

  async function call(name, parameters, signal) {
    if (signal?.aborted) throw abortError();
    let response;
    try {
      response = await rpc(name, parameters, { signal });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw rpcError();
    }
    if (signal?.aborted) throw abortError();
    if (!response || response.error || !Object.hasOwn(response, "data")) throw rpcError();
    return firstRow(response.data);
  }

  return Object.freeze({
    durable: true,

    async claimAlert({
      alertKey,
      fingerprint,
      kind,
      actionKey,
      destination,
      allowance,
      policyVersion,
      approvalRef,
      signal,
    } = {}) {
      const result = await call("nh_claim_allowance_alert", {
        p_alert_key: alertKey,
        p_fingerprint: fingerprint,
        p_kind: kind,
        p_action_key: actionKey,
        p_destination_digest: digest("founder-destination", destination),
        p_allowance: allowance,
        p_policy_version: policyVersion,
        p_approval_ref: approvalRef,
      }, signal);
      return publicClaim(result);
    },

    async finishAlert({ claimId, fingerprint, state, failureCode = null, receiptId = null, signal } = {}) {
      if (!FINISH_STATES.has(state)) return Object.freeze({ recorded: false, state: "conflict" });
      const result = await call("nh_finish_allowance_alert", {
        p_claim_id: claimId,
        p_fingerprint: fingerprint,
        p_state: state,
        p_failure_code: state === "delivered" ? null : failureCode,
        p_receipt_digest: state === "delivered" ? digest("founder-receipt", receiptId) : null,
      }, signal);
      return publicFinish(result);
    },

    async recordContinuity({
      eventKey,
      fingerprint,
      actionKey,
      reasonCode,
      completed,
      allowance,
      responseCode,
      responseDigest,
      policyVersion,
      approvalRef,
      signal,
    } = {}) {
      const result = await call("nh_record_allowance_continuity_event", {
        p_event_key: eventKey,
        p_fingerprint: fingerprint,
        p_action_key: actionKey,
        p_reason_code: reasonCode,
        p_completed: completed,
        p_allowance: allowance,
        p_response_code: responseCode,
        p_response_digest: responseDigest,
        p_policy_version: policyVersion,
        p_approval_ref: approvalRef,
      }, signal);
      return publicContinuity(result);
    },
  });
}

module.exports = {
  createSupabaseAllowanceContinuityStore,
};
