"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dispatchAdmittedModel, RETURNED_OUTCOMES } = require("../src/lib/model-dispatch-lifecycle");

function harness({
  allowed = true,
  mode = "enforced",
  code = allowed ? "ALLOWED" : "INCOMPATIBLE",
  reservationId = allowed && mode === "enforced" ? "reservation-1" : null,
  dispatchResult = { ok: true, code: "DISPATCH_RECORDED", state: "dispatched" },
  settlementResults = [{ ok: true, code: "SETTLED", state: "consumed" }],
} = {}) {
  const calls = [];
  let settlementIndex = 0;
  const lease = {
    allowed, mode, code, reservationId,
    async markDispatched() {
      calls.push(["markDispatched"]);
      if (dispatchResult instanceof Error) throw dispatchResult;
      return dispatchResult;
    },
    async settle(input) {
      calls.push(["settle", input]);
      const result = settlementResults[Math.min(settlementIndex++, settlementResults.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const admission = {
    async acquire(...args) {
      calls.push(["acquire", ...args]);
      return lease;
    },
  };
  return { admission, calls, lease };
}

const request = Object.freeze({
  actionId: "model.gemini.frontline",
  actionKey: "run-42.gemini.1",
  authority: "trusted-runtime",
  runId: "run-42",
  requestFingerprint: "a".repeat(64),
});

test("denial forwards exact trusted context and performs no dispatch or transport", async () => {
  const denied = harness({ allowed: false });
  let networkCalls = 0;
  const result = await dispatchAdmittedModel({
    admission: denied.admission, ...request,
    execute: async () => { networkCalls += 1; return { type: "completed" }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCOMPATIBLE");
  assert.equal(networkCalls, 0);
  assert.deepEqual(denied.calls, [["acquire", request.actionId, {
    actionKey: request.actionKey,
    authority: request.authority,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
  }]]);
});

test("fresh dispatch precedes transport and verified settlement exposes the value", async () => {
  const state = harness();
  const result = await dispatchAdmittedModel({
    admission: state.admission, ...request,
    execute: async () => {
      state.calls.push(["network"]);
      return { type: "completed", value: { answer: "17" } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "MODEL_COMPLETED");
  assert.deepEqual(result.value, { answer: "17" });
  assert.deepEqual(state.calls.map(([name]) => name), ["acquire", "markDispatched", "network", "settle"]);
  assert.deepEqual(state.calls.at(-1)[1], { outcome: "completed" });
});

test("admission replay performs zero dispatch and zero transport", async () => {
  const state = harness({ allowed: false, code: "IDEMPOTENT_REPLAY", reservationId: "reservation-1" });
  let networkCalls = 0;
  const result = await dispatchAdmittedModel({
    admission: state.admission, ...request,
    execute: async () => { networkCalls += 1; return { type: "completed" }; },
  });
  assert.equal(result.code, "IDEMPOTENT_REPLAY");
  assert.equal(networkCalls, 0);
  assert.deepEqual(state.calls.map(([name]) => name), ["acquire"]);
});

test("dispatch replay performs zero transport and records reconciliation", async () => {
  for (const dispatchResult of [
    { ok: true, idempotent: true, code: "IDEMPOTENT_REPLAY", private: "must-not-leak" },
    { ok: false, code: "ALREADY_DISPATCHED" },
  ]) {
    const state = harness({
      dispatchResult,
      settlementResults: [{ ok: true, code: "TRANSPORT_UNCERTAIN", state: "reconciliation_required", private: "hidden" }],
    });
    let networkCalls = 0;
    const result = await dispatchAdmittedModel({
      admission: state.admission, ...request,
      execute: async () => { networkCalls += 1; return { type: "completed" }; },
    });
    assert.equal(result.code, "MODEL_DISPATCH_REPLAY");
    assert.equal(networkCalls, 0);
    assert.deepEqual(state.calls.at(-1), ["settle", { outcome: "transport_uncertain" }]);
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(result).includes("hidden"), false);
  }
});

test("dispatch rejection cancels before transport", async () => {
  for (const dispatchResult of [
    { ok: false, code: "STORE_UNAVAILABLE" },
    new Error("private detail"),
    null,
  ]) {
    const state = harness({ dispatchResult, settlementResults: [{ ok: true, code: "CANCELLED", state: "released" }] });
    let networkCalls = 0;
    const result = await dispatchAdmittedModel({
      admission: state.admission, ...request,
      execute: async () => { networkCalls += 1; return { type: "completed" }; },
    });
    assert.equal(result.code, "DISPATCH_NOT_READY");
    assert.equal(networkCalls, 0);
    assert.deepEqual(state.calls.at(-1), ["settle", { outcome: "cancelled_before_dispatch" }]);
  }
});

test("already-dispatched cancellation moves to reconciliation without transport", async () => {
  const state = harness({
    dispatchResult: new Error("lost dispatch response"),
    settlementResults: [
      { ok: false, code: "ALREADY_DISPATCHED", state: "dispatched" },
      { ok: true, code: "TRANSPORT_UNCERTAIN", state: "reconciliation_required" },
    ],
  });
  let networkCalls = 0;
  const result = await dispatchAdmittedModel({
    admission: state.admission, ...request,
    execute: async () => { networkCalls += 1; return { type: "completed" }; },
  });
  assert.equal(result.code, "DISPATCH_STATE_RECONCILED");
  assert.equal(networkCalls, 0);
  assert.deepEqual(state.calls.filter(([name]) => name === "settle").map(([, value]) => value.outcome),
    ["cancelled_before_dispatch", "transport_uncertain"]);
});

test("enforced leases require a reservation and lifecycle methods", async () => {
  for (const mutate of [
    (lease) => { lease.reservationId = null; },
    (lease) => { delete lease.markDispatched; },
    (lease) => { delete lease.settle; },
  ]) {
    const state = harness();
    mutate(state.lease);
    let networkCalls = 0;
    const result = await dispatchAdmittedModel({
      admission: state.admission, ...request,
      execute: async () => { networkCalls += 1; return { type: "completed" }; },
    });
    assert.equal(result.code, "ADMISSION_LIFECYCLE_REQUIRED");
    assert.equal(networkCalls, 0);
  }
});

test("transport uncertainty is recorded for thrown and returned failures", async () => {
  const cases = [
    async () => { throw new TypeError("socket closed"); },
    async () => { const error = new Error("late"); error.name = "TimeoutError"; throw error; },
    async () => ({ type: "transport_error" }),
    async () => ({ type: "timeout" }),
  ];
  for (const execute of cases) {
    const state = harness({ settlementResults: [{ ok: true, code: "TRANSPORT_UNCERTAIN", state: "reconciliation_required" }] });
    const result = await dispatchAdmittedModel({ admission: state.admission, ...request, execute });
    assert.equal(result.ok, false);
    assert.deepEqual(state.calls.at(-1), ["settle", { outcome: "transport_uncertain" }]);
  }
});

test("HTTP, parse, unusable and malformed results consume a failed dispatched attempt", async () => {
  for (const returned of [
    { type: "http_error", status: 429 },
    { type: "parse_error" },
    { type: "unusable" },
    null,
    { type: "success" },
  ]) {
    const state = harness();
    const result = await dispatchAdmittedModel({
      admission: state.admission, ...request, execute: async () => returned,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(state.calls.at(-1), ["settle", { outcome: "failed_after_dispatch" }]);
  }
});

test("transport cannot control units and settlement failure exposes no model value", async () => {
  const privateValue = { answer: "private-unsettled-answer" };
  const state = harness({ settlementResults: [{ ok: false, code: "LEDGER_UNAVAILABLE", private: privateValue }] });
  const result = await dispatchAdmittedModel({
    admission: state.admission, ...request,
    execute: async () => ({
      type: "completed",
      value: privateValue,
      actualRequirements: [{ pool: "gemini_project", units: 0 }],
      private: "hidden",
    }),
  });
  assert.equal(result.code, "LIFECYCLE_SETTLEMENT_FAILED");
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(JSON.stringify(result).includes("private-unsettled-answer"), false);
  assert.equal(JSON.stringify(result).includes("actualRequirements"), false);
  assert.deepEqual(state.calls.at(-1), ["settle", { outcome: "completed" }]);
});

test("disabled mode executes once without fake reservation transitions", async () => {
  const state = harness({ mode: "disabled", code: "ADMISSION_DISABLED", reservationId: null });
  const value = { answer: "legacy-compatible" };
  const result = await dispatchAdmittedModel({
    admission: state.admission, ...request,
    execute: async () => ({ type: "completed", value }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, value);
  assert.equal(result.decision.mode, "disabled");
  assert.deepEqual(state.calls.map(([name]) => name), ["acquire"]);
});

test("contract validates dependencies, fingerprint and result vocabulary", async () => {
  assert.deepEqual([...RETURNED_OUTCOMES], [
    "completed", "http_error", "parse_error", "unusable", "transport_error", "timeout",
  ]);
  await assert.rejects(dispatchAdmittedModel({ execute: async () => ({ type: "completed" }) }), TypeError);
  await assert.rejects(dispatchAdmittedModel({ admission: { acquire: async () => null } }), TypeError);
  await assert.rejects(dispatchAdmittedModel({
    admission: { acquire: async () => null }, execute: async () => ({ type: "completed" }),
    requestFingerprint: "not-a-digest",
  }), TypeError);
});
