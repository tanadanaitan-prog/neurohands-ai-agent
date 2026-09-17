"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupabaseCapacityStore, stableUuid } = require("../src/lib/supabase-capacity-store");

test("the Supabase adapter preserves bundle, authority and lifecycle evidence", async () => {
  const calls = [];
  const rpc = async (name, parameters) => {
    calls.push([name, parameters]);
    if (name === "nh_allowance_store_ready") return { data: true, error: null };
    if (name === "nh_reserve_allowance_bundle") {
      return { data: { allowed: true, code: "ALLOWED_WITH_ALERT", reservation_id: "reservation-1", alert_required: true }, error: null };
    }
    if (name === "nh_mark_allowance_dispatched") return { data: { allowed: true, code: "DISPATCH_RECORDED", state: "dispatched" }, error: null };
    if (name === "nh_settle_allowance_reservation") return { data: { allowed: true, code: "SETTLEMENT_RECORDED", state: "settled" }, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  };
  const store = createSupabaseCapacityStore({ rpc });
  assert.equal(store.durable, true);
  assert.equal(await store.checkReady(), true);

  const action = [{ pool: "gemini_project", units: 1 }];
  const verification = [{ pool: "gemini_project", units: 1 }, { pool: "line_oa", units: 1 }];
  const reserved = await store.reserveBundle({
    reservationKey: "run-1",
    requestDigest: "a".repeat(64),
    workload: "frontline",
    actorId: "runtime-opaque-1",
    operation: "generate_agent_response",
    actionRequirements: action,
    verificationRequirements: verification,
    expiresAt: "2026-09-18T10:00:00.000Z",
  });
  assert.deepEqual(reserved, {
    ok: true, reservationId: "reservation-1", idempotent: false,
    code: "ALLOWED_WITH_ALERT", alertRequired: true,
  });
  assert.deepEqual(calls[1], ["nh_reserve_allowance_bundle", {
    p_idempotency_key: "run-1",
    p_request_digest: "a".repeat(64),
    p_workload: "frontline",
    p_actor_id: "runtime-opaque-1",
    p_operation: "generate_agent_response",
    p_action_requirements: action,
    p_verification_requirements: verification,
    p_expires_at: "2026-09-18T10:00:00.000Z",
  }]);

  assert.equal((await store.markDispatched({ reservationId: "reservation-1", actorId: "runtime-opaque-1" })).ok, true);
  assert.equal((await store.settle({
    reservationId: "reservation-1",
    actorId: "runtime-opaque-1",
    outcome: "completed",
    actualRequirements: [{ pool: "gemini_project", units: 2 }, { pool: "line_oa", units: 1 }],
  })).ok, true);
  assert.equal(calls[2][1].p_dispatch_key, stableUuid("reservation-1:dispatch"));
  assert.equal(calls[3][1].p_settlement_key, stableUuid("reservation-1:completed"));
});

test("cancellation, uncertain transport, invalid outcomes and RPC failures fail safely", async () => {
  const calls = [];
  const store = createSupabaseCapacityStore({ rpc: async (name, parameters) => {
    calls.push([name, parameters]);
    return { data: { allowed: name === "nh_cancel_allowance_reservation", code: "RECORDED", state: "recorded" }, error: null };
  } });

  assert.equal((await store.settle({
    reservationId: "reservation-2", actorId: "runtime-opaque-2", outcome: "cancelled_before_dispatch",
  })).ok, true);
  assert.equal((await store.settle({
    reservationId: "reservation-2", actorId: "runtime-opaque-2", outcome: "transport_uncertain",
  })).ok, false);
  assert.equal((await store.settle({
    reservationId: "reservation-2", actorId: "runtime-opaque-2", outcome: "invented",
  })).code, "INVALID_SETTLEMENT_OUTCOME");
  assert.deepEqual(calls.map(([name]) => name), [
    "nh_cancel_allowance_reservation", "nh_mark_allowance_reconciliation_required",
  ]);

  assert.throws(() => createSupabaseCapacityStore(), /server-only Supabase RPC/);
  const failing = createSupabaseCapacityStore({ rpc: async () => ({ data: null, error: { message: "private detail" } }) });
  await assert.rejects(failing.checkReady(), { code: "CAPACITY_RPC_FAILED" });
  await assert.rejects(store.markDispatched({ reservationId: "reservation-2", actorId: "raw id with spaces" }),
    { code: "CAPACITY_ACTOR_REQUIRED" });
});

test("lost lifecycle responses can be retried without reporting a false failure", async () => {
  const calls = [];
  const store = createSupabaseCapacityStore({ rpc: async (name) => {
    calls.push(name);
    return { data: { allowed: false, code: "IDEMPOTENT_REPLAY", state: "already-recorded" }, error: null };
  } });
  const actorId = "runtime-opaque-retry";
  const dispatch = await store.markDispatched({ reservationId: "reservation-retry", actorId });
  const cancel = await store.settle({ reservationId: "reservation-retry", actorId, outcome: "cancelled_before_dispatch" });
  const uncertain = await store.settle({ reservationId: "reservation-retry", actorId, outcome: "transport_uncertain" });
  const completed = await store.settle({
    reservationId: "reservation-retry", actorId, outcome: "completed",
    actualRequirements: [{ pool: "gemini_project", units: 2 }],
  });
  for (const result of [dispatch, cancel, uncertain, completed]) {
    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);
    assert.equal(result.code, "IDEMPOTENT_REPLAY");
  }
  assert.deepEqual(calls, [
    "nh_mark_allowance_dispatched",
    "nh_cancel_allowance_reservation",
    "nh_mark_allowance_reconciliation_required",
    "nh_settle_allowance_reservation",
  ]);
});
