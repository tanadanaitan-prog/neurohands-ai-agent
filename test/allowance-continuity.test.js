"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  POLICY_VERSION,
  alertMessage,
  createAllowanceContinuityRuntime,
  staticResponseDigest,
} = require("../src/lib/allowance-continuity");
const { dispatchAdmittedModel } = require("../src/lib/model-dispatch-lifecycle");

const THRESHOLD_ALLOWANCE = Object.freeze({
  poolId: "gemini_project",
  remaining: 7,
  unit: "requests",
  verifiedAt: "2026-09-18T08:00:00.000Z",
  evidenceRef: "snapshot-20260918-a",
  resetAt: "2026-09-19T00:00:00.000Z",
});
const EXHAUSTED_ALLOWANCE = Object.freeze({
  ...THRESHOLD_ALLOWANCE,
  remaining: 0,
  evidenceRef: "snapshot-20260918-b",
});
const STATIC_RESPONSE = "This service has reached its verified usage limit. Your request was not completed. Please try again after service is restored.";

function durableStore({ failDeliveredFinish = false, failClaims = false } = {}) {
  const alerts = new Map();
  const events = new Map();
  const calls = [];
  return {
    durable: true,
    calls,
    alerts,
    events,
    async claimAlert(input) {
      calls.push(["claimAlert", input]);
      if (failClaims) throw new Error("private store detail");
      const prior = alerts.get(input.alertKey);
      if (prior) {
        return prior.fingerprint === input.fingerprint
          ? { claimId: prior.claimId, fingerprint: prior.fingerprint, state: prior.state, newClaim: false }
          : { state: "conflict", newClaim: false };
      }
      const claim = {
        claimId: `claim.${alerts.size + 1}`,
        fingerprint: input.fingerprint,
        state: "claimed",
      };
      alerts.set(input.alertKey, claim);
      return { ...claim, newClaim: true };
    },
    async finishAlert(input) {
      calls.push(["finishAlert", input]);
      const claim = [...alerts.values()].find((item) => item.claimId === input.claimId);
      if (!claim || claim.fingerprint !== input.fingerprint) return { recorded: false };
      if (input.state === "delivered" && failDeliveredFinish) throw new Error("private completion detail");
      claim.state = input.state;
      claim.receiptId = input.receiptId || null;
      claim.failureCode = input.failureCode || null;
      return { recorded: true, state: claim.state };
    },
    async recordContinuity(input) {
      calls.push(["recordContinuity", input]);
      const prior = events.get(input.eventKey);
      if (prior) {
        return prior.fingerprint === input.fingerprint
          ? { recorded: true, idempotent: true }
          : { recorded: false, conflict: true };
      }
      events.set(input.eventKey, input);
      return { recorded: true, idempotent: false };
    },
  };
}

function notifier({ outcome = "delivered" } = {}) {
  const calls = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      if (outcome === "throw") throw new Error("private LINE failure");
      if (outcome === "unconfirmed") return { delivered: false };
      return { delivered: true, receiptId: `receipt-${calls.length}` };
    },
  };
}

function runtime(options = {}) {
  const store = options.store || durableStore();
  const delivery = options.notifier || notifier();
  return {
    store,
    delivery,
    control: createAllowanceContinuityRuntime({
      enabled: true,
      store,
      notifier: delivery,
      founderDestination: "founder-opaque",
      staticResponse: STATIC_RESPONSE,
      approval: {
        approved: true,
        policyVersion: POLICY_VERSION,
        staticResponseDigest: staticResponseDigest(STATIC_RESPONSE),
        approvalRef: "synthetic-local-approval",
      },
      adapterTimeoutMs: options.adapterTimeoutMs,
    }),
  };
}

function admittedLease({
  allowed = true,
  code = "ALLOWED_WITH_ALERT",
  mode = "enforced",
  settlement = { ok: true, code: "SETTLED", state: "consumed" },
} = {}) {
  return {
    allowed,
    code,
    mode,
    reservationId: allowed ? "reservation-1" : null,
    async markDispatched() { return { ok: true, code: "DISPATCH_RECORDED", state: "dispatched" }; },
    async settle() { return settlement; },
  };
}

const MODEL_REQUEST = Object.freeze({
  actionId: "model.gemini.frontline",
  actionKey: "run-42.gemini.1",
  authority: "trusted-runtime",
  runId: "run-42",
  requestFingerprint: "a".repeat(64),
});

test("disabled continuity preserves legacy behavior without adapters", async () => {
  const control = createAllowanceContinuityRuntime({ enabled: false });
  assert.equal(control.enabled, false);
  assert.deepEqual(await control.afterCompleted(), {
    state: "disabled", delivered: false, attempted: false, newlyDelivered: false, failureRecorded: false,
  });
  assert.deepEqual(await control.handleHardLimit(), { handled: false, completed: false });
});

test("enabled continuity requires durable storage, one notifier, private destination and approved text", () => {
  const store = durableStore();
  const delivery = notifier();
  assert.throws(() => createAllowanceContinuityRuntime({ enabled: true }), /durable/);
  assert.throws(() => createAllowanceContinuityRuntime({ enabled: true, store }), /notifier/);
  assert.throws(() => createAllowanceContinuityRuntime({ enabled: true, store, notifier: delivery }), /destination/);
  assert.throws(() => createAllowanceContinuityRuntime({
    enabled: true, store, notifier: delivery, founderDestination: "founder-opaque",
  }), /approved static/);
  assert.throws(() => createAllowanceContinuityRuntime({
    enabled: true, store, notifier: delivery, founderDestination: "founder-opaque",
    staticResponse: STATIC_RESPONSE,
  }), /approval evidence/);
  assert.throws(() => createAllowanceContinuityRuntime({
    enabled: true, store, notifier: delivery, founderDestination: "founder-opaque",
    staticResponse: STATIC_RESPONSE,
    approval: {
      approved: true,
      policyVersion: POLICY_VERSION,
      staticResponseDigest: "0".repeat(64),
      approvalRef: "wrong-text",
    },
  }), /approval evidence/);
});

test("C03: successful accepted work sends one idempotent threshold alert with required evidence", async () => {
  const state = runtime();
  let modelCalls = 0;
  const result = await dispatchAdmittedModel({
    admission: { acquire: async () => admittedLease() },
    ...MODEL_REQUEST,
    continuityRuntime: state.control,
    continuityContext: {
      alertKey: "threshold.gemini.snapshot-a",
      allowance: THRESHOLD_ALLOWANCE,
    },
    execute: async () => {
      modelCalls += 1;
      return { type: "completed", value: { answer: "verified" } };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { answer: "verified" });
  assert.equal(modelCalls, 1);
  assert.deepEqual(result.alert, {
    state: "scheduled", delivered: false, attempted: false, newlyDelivered: false, failureRecorded: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.delivery.calls.length, 1);
  const message = state.delivery.calls[0].message;
  assert.match(message, /gemini_project/);
  assert.match(message, /7 requests remaining/);
  assert.match(message, /2026-09-19T00:00:00\.000Z/);
  assert.match(message, /snapshot-20260918-a/);
  assert.match(message, /Spending has not been stopped/);

  const repeated = await state.control.afterCompleted({
    decision: { allowed: true, code: "ALLOWED_WITH_ALERT" },
    actionKey: MODEL_REQUEST.actionKey,
    alertKey: "threshold.gemini.snapshot-a",
    allowance: THRESHOLD_ALLOWANCE,
  });
  assert.equal(repeated.state, "already_delivered");
  assert.equal(repeated.delivered, true);
  assert.equal(repeated.newlyDelivered, false);
  assert.equal(state.delivery.calls.length, 1, "A durable replay must not notify again");
});

test("C03: failed founder delivery is recorded once without a delivery claim or retry loop", async () => {
  const state = runtime({ notifier: notifier({ outcome: "throw" }) });
  const input = {
    decision: { allowed: true, code: "ALLOWED_WITH_ALERT" },
    actionKey: "threshold-action",
    alertKey: "threshold.gemini.failure",
    allowance: THRESHOLD_ALLOWANCE,
  };
  const first = await state.control.afterCompleted(input);
  assert.deepEqual(first, {
    state: "delivery_failed", delivered: false, attempted: true, newlyDelivered: false, failureRecorded: true,
  });
  assert.equal(state.store.alerts.get(input.alertKey).state, "failed");
  assert.equal(state.delivery.calls.length, 1);

  const second = await state.control.afterCompleted(input);
  assert.equal(second.state, "prior_failure");
  assert.equal(second.delivered, false);
  assert.equal(second.attempted, false);
  assert.equal(state.delivery.calls.length, 1, "The runtime must not retry a failed alert automatically");
});

test("C03: an alert failure does not undo the already settled customer action", async () => {
  const state = runtime({ notifier: notifier({ outcome: "throw" }) });
  const result = await dispatchAdmittedModel({
    admission: { acquire: async () => admittedLease() },
    ...MODEL_REQUEST,
    continuityRuntime: state.control,
    continuityContext: {
      alertKey: "threshold.gemini.action-stays-complete",
      allowance: THRESHOLD_ALLOWANCE,
    },
    execute: async () => ({ type: "completed", value: { answer: "settled" } }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { answer: "settled" });
  assert.equal(result.alert.state, "scheduled");
  assert.equal(result.alert.delivered, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.store.alerts.get("threshold.gemini.action-stays-complete").state, "failed");
  assert.equal(state.delivery.calls.length, 1);
});

test("C03: a stalled founder notifier never delays the settled customer result", async () => {
  const calls = [];
  const state = runtime({
    adapterTimeoutMs: 5,
    notifier: {
      async send(input) { calls.push(input); return new Promise(() => {}); },
    },
  });
  const completion = await Promise.race([
    dispatchAdmittedModel({
      admission: { acquire: async () => admittedLease() },
      ...MODEL_REQUEST,
      continuityRuntime: state.control,
      continuityContext: {
        alertKey: "threshold.gemini.stalled-notifier",
        allowance: THRESHOLD_ALLOWANCE,
      },
      execute: async () => ({ type: "completed", value: { answer: "settled" } }),
    }),
    new Promise((resolve) => setTimeout(() => resolve("customer-result-blocked"), 50)),
  ]);
  assert.notEqual(completion, "customer-result-blocked");
  assert.equal(completion.ok, true);
  assert.deepEqual(completion.value, { answer: "settled" });
  assert.equal(completion.alert.state, "scheduled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.equal(state.store.alerts.get("threshold.gemini.stalled-notifier").state, "uncertain");
});

test("C03: a late notifier completion remains uncertain and is never retried", async () => {
  let sends = 0;
  const state = runtime({
    adapterTimeoutMs: 5,
    notifier: {
      async send() {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { delivered: true, receiptId: "late-receipt" };
      },
    },
  });
  const input = {
    decision: { allowed: true, code: "ALLOWED_WITH_ALERT" },
    actionKey: "late-alert-action",
    alertKey: "threshold.gemini.late-notifier",
    allowance: THRESHOLD_ALLOWANCE,
  };
  const first = await state.control.afterCompleted(input);
  assert.equal(first.state, "delivery_timeout");
  assert.equal(first.delivered, false);
  assert.equal(first.attempted, true);
  assert.equal(state.store.alerts.get(input.alertKey).state, "uncertain");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const replay = await state.control.afterCompleted(input);
  assert.equal(replay.state, "uncertain");
  assert.equal(replay.delivered, false);
  assert.equal(sends, 1, "An uncertain late delivery must never be retried automatically");
});

test("C03: concurrent threshold completions share one durable alert claim", async () => {
  const state = runtime();
  const makeInput = (actionKey) => ({
    decision: { allowed: true, code: "ALLOWED_WITH_ALERT" },
    actionKey,
    alertKey: "threshold.gemini.concurrent",
    allowance: THRESHOLD_ALLOWANCE,
  });
  const [first, second] = await Promise.all([
    state.control.afterCompleted(makeInput("accepted-action-a")),
    state.control.afterCompleted(makeInput("accepted-action-b")),
  ]);
  assert.equal(state.delivery.calls.length, 1);
  assert.deepEqual(new Set([first.state, second.state]), new Set(["delivered", "in_progress"]));
  const replay = await state.control.afterCompleted(makeInput("accepted-action-c"));
  assert.equal(replay.state, "already_delivered");
  assert.equal(state.delivery.calls.length, 1);
});

test("C03: an unconfirmed receipt and a lost completion record never become false delivery claims", async () => {
  const unconfirmed = runtime({ notifier: notifier({ outcome: "unconfirmed" }) });
  const base = {
    decision: { allowed: true, code: "ALLOWED_WITH_ALERT" },
    actionKey: "threshold-action-2",
    alertKey: "threshold.gemini.unconfirmed",
    allowance: THRESHOLD_ALLOWANCE,
  };
  const missingReceipt = await unconfirmed.control.afterCompleted(base);
  assert.equal(missingReceipt.state, "delivery_unconfirmed");
  assert.equal(missingReceipt.delivered, false);
  assert.equal(missingReceipt.failureRecorded, true);
  assert.equal((await unconfirmed.control.afterCompleted(base)).state, "prior_failure");
  assert.equal(unconfirmed.delivery.calls.length, 1);

  const uncertainStore = durableStore({ failDeliveredFinish: true });
  const uncertain = runtime({ store: uncertainStore });
  const lostRecord = await uncertain.control.afterCompleted({ ...base, alertKey: "threshold.gemini.uncertain" });
  assert.equal(lostRecord.state, "delivery_recording_uncertain");
  assert.equal(lostRecord.delivered, false);
  assert.equal(lostRecord.attempted, true);
  const replay = await uncertain.control.afterCompleted({ ...base, alertKey: "threshold.gemini.uncertain" });
  assert.equal(replay.state, "in_progress");
  assert.equal(uncertain.delivery.calls.length, 1, "An uncertain delivery must remain reconciliation-only");
});

test("C03: threshold alert waits for verified settlement", async () => {
  const state = runtime();
  const result = await dispatchAdmittedModel({
    admission: { acquire: async () => admittedLease({ settlement: { ok: false, code: "LEDGER_UNAVAILABLE" } }) },
    ...MODEL_REQUEST,
    continuityRuntime: state.control,
    continuityContext: { alertKey: "threshold.no-settlement", allowance: THRESHOLD_ALLOWANCE },
    execute: async () => ({ type: "completed", value: { mustNotEscape: true } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LIFECYCLE_SETTLEMENT_FAILED");
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(Object.hasOwn(result, "alert"), false);
  assert.equal(state.delivery.calls.length, 0);
});

test("C04: optional exhausted work stops before transport without fallback or provider change", async () => {
  const state = runtime();
  let networkCalls = 0;
  const result = await dispatchAdmittedModel({
    admission: { acquire: async () => admittedLease({ allowed: false, code: "ALLOWANCE_EXHAUSTED" }) },
    ...MODEL_REQUEST,
    continuityRuntime: state.control,
    continuityContext: {
      eventKey: "optional.hard.event",
      alertKey: "optional.hard.alert",
      allowance: EXHAUSTED_ALLOWANCE,
    },
    execute: async () => {
      networkCalls += 1;
      return { type: "completed" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ALLOWANCE_EXHAUSTED");
  assert.equal(networkCalls, 0);
  assert.equal(state.delivery.calls.length, 0);
  assert.equal(Object.hasOwn(result, "continuity"), false);
});

test("C04: exhausted Frontline records a static response, alerts once and never dispatches", async () => {
  const state = runtime();
  let networkCalls = 0;
  const invoke = () => dispatchAdmittedModel({
    admission: {
      acquire: async () => admittedLease({ allowed: false, code: "CONTINUITY_HARD_LIMIT", mode: "continuity" }),
    },
    ...MODEL_REQUEST,
    continuityRuntime: state.control,
    continuityContext: {
      eventKey: "frontline.hard.event",
      alertKey: "frontline.hard.alert",
      allowance: EXHAUSTED_ALLOWANCE,
    },
    execute: async () => {
      networkCalls += 1;
      return { type: "completed", value: "must-not-run" };
    },
  });

  const first = await invoke();
  assert.equal(first.ok, false);
  assert.equal(first.code, "CONTINUITY_HARD_LIMIT");
  assert.equal(first.phase, "admission");
  assert.equal(first.continuity.handled, true);
  assert.equal(first.continuity.completed, false);
  assert.equal(first.continuity.reasonRecorded, true);
  assert.equal(first.continuity.response, STATIC_RESPONSE);
  assert.equal(first.continuity.alert.state, "delivered");
  assert.equal(networkCalls, 0, "No model or network transport may start after a hard limit");
  assert.equal(state.delivery.calls.length, 1);
  assert.match(state.delivery.calls[0].message, /requested work was not completed/i);
  assert.equal(state.store.events.get("frontline.hard.event").completed, false);
  assert.equal(state.store.events.get("frontline.hard.event").policyVersion, POLICY_VERSION);
  assert.equal(state.store.events.get("frontline.hard.event").responseDigest,
    staticResponseDigest(STATIC_RESPONSE));

  const repeated = await invoke();
  assert.equal(repeated.continuity.reasonRecorded, true);
  assert.equal(repeated.continuity.alert.state, "already_delivered");
  assert.equal(networkCalls, 0);
  assert.equal(state.delivery.calls.length, 1, "A replay must not send a second hard-limit alert");
});

test("C04: storage failure still denies transport and cannot invent an alert delivery", async () => {
  const state = runtime({ store: durableStore({ failClaims: true }) });
  state.store.recordContinuity = async () => { throw new Error("private audit failure"); };
  let networkCalls = 0;
  const result = await dispatchAdmittedModel({
    admission: {
      acquire: async () => admittedLease({ allowed: false, code: "CONTINUITY_HARD_LIMIT", mode: "continuity" }),
    },
    ...MODEL_REQUEST,
    continuityRuntime: state.control,
    continuityContext: {
      eventKey: "frontline.failed-store.event",
      alertKey: "frontline.failed-store.alert",
      allowance: EXHAUSTED_ALLOWANCE,
    },
    execute: async () => { networkCalls += 1; return { type: "completed" }; },
  });
  assert.equal(result.continuity.response, STATIC_RESPONSE);
  assert.equal(result.continuity.completed, false);
  assert.equal(result.continuity.reasonRecorded, false);
  assert.equal(result.continuity.alert.state, "continuity_record_unconfirmed");
  assert.equal(result.continuity.alert.delivered, false);
  assert.equal(networkCalls, 0);
  assert.equal(state.delivery.calls.length, 0);
});

test("C04: a stalled continuity store returns the approved static response within its deadline", async () => {
  const store = durableStore();
  store.recordContinuity = async () => new Promise(() => {});
  const state = runtime({ store, adapterTimeoutMs: 5 });
  let networkCalls = 0;
  const result = await Promise.race([
    dispatchAdmittedModel({
      admission: {
        acquire: async () => admittedLease({ allowed: false, code: "CONTINUITY_HARD_LIMIT", mode: "continuity" }),
      },
      ...MODEL_REQUEST,
      continuityRuntime: state.control,
      continuityContext: {
        eventKey: "frontline.stalled-store.event",
        alertKey: "frontline.stalled-store.alert",
        allowance: EXHAUSTED_ALLOWANCE,
      },
      execute: async () => { networkCalls += 1; return { type: "completed" }; },
    }),
    new Promise((resolve) => setTimeout(() => resolve("continuity-blocked"), 50)),
  ]);
  assert.notEqual(result, "continuity-blocked");
  assert.equal(result.continuity.response, STATIC_RESPONSE);
  assert.equal(result.continuity.completed, false);
  assert.equal(result.continuity.reasonRecorded, false);
  assert.equal(result.continuity.alert.state, "continuity_record_unconfirmed");
  assert.equal(networkCalls, 0);
});

test("alert wording rejects unverified hard-limit facts", async () => {
  assert.match(alertMessage("threshold", THRESHOLD_ALLOWANCE), /Spending has not been stopped/);
  const state = runtime();
  const result = await state.control.handleHardLimit({
    decision: { allowed: false, code: "CONTINUITY_HARD_LIMIT", mode: "continuity" },
    actionKey: "hard-invalid-action",
    eventKey: "hard-invalid-event",
    alertKey: "hard-invalid-alert",
    allowance: { ...EXHAUSTED_ALLOWANCE, remaining: 1 },
  });
  assert.equal(result.handled, true);
  assert.equal(result.completed, false);
  assert.equal(result.reasonRecorded, false);
  assert.equal(result.alert.state, "invalid_allowance_evidence");
  assert.equal(state.delivery.calls.length, 0);
});
