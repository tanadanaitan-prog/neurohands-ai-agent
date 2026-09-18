"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OPTIONAL_TRACE_POLICY,
  createApprovedOptionalTraceRuntime,
  issueMandatoryAgentRunAuditReceipt,
  scheduleOptionalTraceAfterAudit,
} = require("../src/lib/optional-trace-runtime");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function nextOutcome(outcomes) {
  return new Promise((resolve) => { outcomes.push(resolve); });
}

test("only one optional trace can be in flight and success reopens the runtime", async () => {
  const dispatchGate = deferred();
  const outcomeWaiters = [];
  let dispatches = 0;
  const runtime = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    dispatch: async () => {
      dispatches += 1;
      if (dispatches === 1) return dispatchGate.promise;
      return { accepted: true, receiptId: `receipt-${dispatches}` };
    },
    onOutcome: (outcome) => outcomeWaiters.shift()?.(outcome),
  });

  const firstOutcome = nextOutcome(outcomeWaiters);
  assert.equal(scheduleOptionalTraceAfterAudit({
    runtime,
    auditReceipt: issueMandatoryAgentRunAuditReceipt("run-1", "completed"),
  }).code, "TRACE_EXPORT_SCHEDULED");

  assert.deepEqual(scheduleOptionalTraceAfterAudit({
    runtime,
    auditReceipt: issueMandatoryAgentRunAuditReceipt("run-2", "completed"),
  }), {
    status: "skipped",
    code: "TRACE_RUNTIME_BUSY",
    attempts: 0,
    settlement: "cancelled_before_dispatch",
  });
  assert.equal((await firstOutcome).code, "TRACE_RUNTIME_BUSY");
  assert.equal(dispatches, 0, "the queued first dispatch has not started yet");

  const exported = nextOutcome(outcomeWaiters);
  dispatchGate.resolve({ accepted: true, receiptId: "receipt-1" });
  assert.equal((await exported).code, "TRACE_EXPORTED");
  assert.equal(dispatches, 1);

  const reopened = nextOutcome(outcomeWaiters);
  assert.equal(scheduleOptionalTraceAfterAudit({
    runtime,
    auditReceipt: issueMandatoryAgentRunAuditReceipt("run-3", "completed"),
  }).code, "TRACE_EXPORT_SCHEDULED");
  assert.equal((await reopened).code, "TRACE_EXPORTED");
  assert.equal(dispatches, 2);
});

test("a timed-out optional transport suspends later exports without retrying", async () => {
  const outcomeWaiters = [];
  let dispatches = 0;
  const runtime = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    timeoutMs: 5,
    dispatch: async () => {
      dispatches += 1;
      return new Promise(() => {});
    },
    onOutcome: (outcome) => outcomeWaiters.shift()?.(outcome),
  });

  const timedOut = nextOutcome(outcomeWaiters);
  assert.equal(scheduleOptionalTraceAfterAudit({
    runtime,
    auditReceipt: issueMandatoryAgentRunAuditReceipt("run-timeout", "completed"),
  }).code, "TRACE_EXPORT_SCHEDULED");
  assert.deepEqual(await timedOut, {
    status: "timeout",
    code: "TRACE_EXPORT_TIMEOUT",
    attempts: 1,
    settlement: "transport_uncertain",
  });

  assert.deepEqual(scheduleOptionalTraceAfterAudit({
    runtime,
    auditReceipt: issueMandatoryAgentRunAuditReceipt("run-after-timeout", "completed"),
  }), {
    status: "skipped",
    code: "TRACE_RUNTIME_SUSPENDED",
    attempts: 0,
    settlement: "cancelled_before_dispatch",
  });
  assert.equal(dispatches, 1, "the suspended optional runtime must not retry");
});
