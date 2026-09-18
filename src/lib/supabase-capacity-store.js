"use strict";

const { createHash } = require("node:crypto");

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

function stableUuid(seed) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateActor(actorId) {
  if (typeof actorId !== "string" || !ACTOR.test(actorId)) {
    const error = new Error("A stable opaque admission actor is required");
    error.code = "CAPACITY_ACTOR_REQUIRED";
    throw error;
  }
  return actorId;
}

function createSupabaseCapacityStore({ rpc } = {}) {
  if (typeof rpc !== "function") throw new TypeError("A server-only Supabase RPC function is required");

  async function call(name, parameters) {
    let response;
    try {
      response = await rpc(name, parameters);
    } catch {
      const error = new Error("The durable capacity service is unavailable");
      error.code = "CAPACITY_RPC_FAILED";
      throw error;
    }
    if (!response || response.error || !("data" in response)) {
      const error = new Error("The durable capacity service rejected the request");
      error.code = "CAPACITY_RPC_FAILED";
      throw error;
    }
    return response.data;
  }

  return Object.freeze({
    durable: true,

    async checkReady() {
      return await call("nh_allowance_store_ready", {}) === true;
    },

    async reserveBundle({
      reservationKey,
      requestDigest,
      workload,
      actorId,
      actor,
      operation,
      actionRequirements,
      verificationRequirements,
      expiresAt,
    } = {}) {
      const result = await call("nh_reserve_allowance_bundle", {
        p_idempotency_key: reservationKey,
        p_request_digest: requestDigest,
        p_workload: workload,
        p_actor_id: validateActor(actorId || actor),
        p_operation: operation,
        p_action_requirements: actionRequirements,
        p_verification_requirements: verificationRequirements,
        p_expires_at: expiresAt,
      });
      return result?.allowed === true
        ? {
            ok: true,
            reservationId: result.reservation_id,
            idempotent: result.code === "IDEMPOTENT_REPLAY" || result.replayed === true,
            code: result.code,
            alertRequired: result.alert_required === true,
          }
        : { ok: false, code: result?.code || "CAPACITY_UNAVAILABLE", pool: result?.pool || null };
    },

    async markDispatched({ reservationId, actorId } = {}) {
      const result = await call("nh_mark_allowance_dispatched", {
        p_reservation_id: reservationId,
        p_dispatch_key: stableUuid(`${reservationId}:dispatch`),
        p_actor_id: validateActor(actorId),
      });
      const idempotent = result?.code === "IDEMPOTENT_REPLAY";
      return {
        ok: result?.allowed === true || idempotent,
        idempotent,
        code: result?.code || "DISPATCH_REJECTED",
        state: result?.state || null,
      };
    },

    async settle({ reservationId, outcome, actorId, actualRequirements } = {}) {
      const suffix = `${reservationId}:${outcome}`;
      let result;
      if (outcome === "cancelled_before_dispatch") {
        result = await call("nh_cancel_allowance_reservation", {
          p_reservation_id: reservationId,
          p_cancellation_key: stableUuid(suffix),
          p_actor_id: validateActor(actorId),
        });
      } else if (outcome === "transport_uncertain") {
        result = await call("nh_mark_allowance_reconciliation_required", {
          p_reservation_id: reservationId,
          p_reconciliation_key: stableUuid(suffix),
          p_actor_id: validateActor(actorId),
        });
      } else if (["completed", "failed_after_dispatch"].includes(outcome)) {
        result = await call("nh_settle_allowance_reservation", {
          p_reservation_id: reservationId,
          p_settlement_key: stableUuid(suffix),
          p_outcome: outcome,
          p_actual_requirements: actualRequirements,
          p_actor_id: validateActor(actorId),
        });
      } else {
        return { ok: false, code: "INVALID_SETTLEMENT_OUTCOME", state: null };
      }
      const idempotent = result?.code === "IDEMPOTENT_REPLAY";
      const reconciliationRecorded = outcome === "transport_uncertain" &&
        result?.code === "TRANSPORT_UNCERTAIN" && result?.state === "reconciliation_required";
      return {
        ok: result?.allowed === true || idempotent || reconciliationRecorded,
        idempotent,
        code: result?.code || "SETTLEMENT_REJECTED",
        state: result?.state || null,
      };
    },
  });
}

module.exports = { createSupabaseCapacityStore, stableUuid };
