"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  admitPassportAction,
  createAdmissionController,
  createInMemoryCapacityStore,
  redactTracePayload,
} = require("../src/lib/admission-control");
const { loadPassportRegister } = require("../src/lib/software-passports");

const PASSING_FACTS = Object.freeze({
  goalRelevant: true,
  permissionGranted: true,
  dataPermitted: true,
  compatible: true,
  failureSafe: true,
  verificationPossible: true,
  allowanceStatus: "verified_available",
});

function action(overrides = {}) {
  return {
    actionKey: "test-action",
    actionType: "synthetic_check",
    workload: "experiment",
    potentiallyBillable: true,
    requirementsVerified: true,
    facts: { ...PASSING_FACTS },
    requirements: { action: [{ pool: "requests", units: 1 }], verification: [{ pool: "requests", units: 1 }] },
    ...overrides,
  };
}

function trusted(overrides = {}) {
  return {
    trustSource: "fixed_internal_cli",
    actor: "engineer",
    dataClass: "synthetic",
    workload: "engineering",
    workflow: "local_agent_lab",
    goalRelevant: true,
    ...overrides,
  };
}

test("disabled admission preserves behavior without touching capacity or audit", async () => {
  let touched = false;
  const controller = createAdmissionController({
    enabled: false,
    capacityStore: { reserveBundle() { touched = true; } },
    audit() { touched = true; },
  });
  const lease = await controller.acquire({});
  assert.equal(lease.allowed, true);
  assert.equal(lease.mode, "disabled");
  assert.equal(touched, false);
});

test("disabled passport admission bypasses passport and trusted-context validation", async () => {
  const lease = await admitPassportAction({}, { enabled: false, register: { invalid: true } });
  assert.equal(lease.allowed, true);
  assert.equal(lease.mode, "disabled");
  assert.equal(lease.code, "ADMISSION_DISABLED");
});

test("each deterministic safety check fails closed before reservation", async () => {
  const fields = [
    ["goalRelevant", "GOAL_IRRELEVANT"],
    ["permissionGranted", "PERMISSION_DENIED"],
    ["dataPermitted", "DATA_NOT_PERMITTED"],
    ["compatible", "INCOMPATIBLE"],
    ["failureSafe", "FAILURE_UNSAFE"],
    ["verificationPossible", "VERIFICATION_UNAVAILABLE"],
  ];
  for (const [field, code] of fields) {
    const store = createInMemoryCapacityStore({ requests: 2 });
    const controller = createAdmissionController({ enabled: true, capacityStore: store });
    const lease = await controller.acquire(action({ facts: { ...PASSING_FACTS, [field]: false } }));
    assert.equal(lease.allowed, false, field);
    assert.equal(lease.code, code, field);
    assert.equal(store.snapshot().remaining.requests, 2, field);
  }
});

test("unknown allowance blocks a new billable experiment and explicitly degrades frontline", async () => {
  const store = createInMemoryCapacityStore({ requests: 2 });
  const controller = createAdmissionController({ enabled: true, capacityStore: store });
  const experiment = await controller.acquire(action({ facts: { ...PASSING_FACTS, allowanceStatus: "unknown" } }));
  assert.equal(experiment.code, "ALLOWANCE_UNKNOWN");
  assert.equal(experiment.allowed, false);
  const frontline = await controller.acquire(action({
    actionKey: "frontline-action",
    workload: "frontline",
    facts: { ...PASSING_FACTS, allowanceStatus: "unknown" },
  }));
  assert.equal(frontline.code, "CONTINUITY_DEGRADED");
  assert.equal(frontline.mode, "continuity");
  assert.equal(store.snapshot().remaining.requests, 2);
});

test("an alert remains distinct from a hard limit and hard-limit frontline enters continuity mode", async () => {
  const store = createInMemoryCapacityStore({ requests: 4 });
  const controller = createAdmissionController({ enabled: true, capacityStore: store });
  const alert = await controller.acquire(action({
    actionKey: "alert-threshold",
    facts: { ...PASSING_FACTS, alertThresholdReached: true },
  }));
  assert.equal(alert.allowed, true);
  assert.equal(alert.code, "ALLOWED_WITH_ALERT");
  const durableAlertStore = {
    durable: true,
    async reserveBundle() {
      return { ok: true, reservationId: "durable-alert", alertRequired: true };
    },
    async markDispatched() { return { ok: true }; },
    async settle() { return { ok: true }; },
  };
  const durableAlert = await createAdmissionController({
    enabled: true, capacityStore: durableAlertStore,
  }).acquire(action({ actionKey: "durable-alert-threshold" }));
  assert.equal(durableAlert.allowed, true);
  assert.equal(durableAlert.code, "ALLOWED_WITH_ALERT");
  const stopped = await controller.acquire(action({
    actionKey: "hard-limit",
    workload: "frontline",
    facts: { ...PASSING_FACTS, allowanceStatus: "verified_exhausted" },
  }));
  assert.equal(stopped.allowed, false);
  assert.equal(stopped.mode, "continuity");
  assert.equal(stopped.code, "CONTINUITY_HARD_LIMIT");
});

test("durable last-budget races map frontline and operator work to continuity", async () => {
  for (const workload of ["frontline", "operator"]) {
    for (const reserveCode of [
      "ALLOWANCE_EXHAUSTED", "ALLOWANCE_INSUFFICIENT",
      "ALLOWANCE_UNKNOWN", "ALLOWANCE_SNAPSHOT_EXPIRED", "POOL_NOT_FOUND",
      "ALLOWANCE_LEASE_CROSSES_RESET", "CAPACITY_UNAVAILABLE",
      "CAPACITY_STORE_UNAVAILABLE",
    ]) {
      const store = {
        durable: true,
        async reserveBundle() { return { ok: false, code: reserveCode }; },
      };
      const lease = await createAdmissionController({
        enabled: true,
        capacityStore: store,
      }).acquire(action({ actionKey: `${workload}-${reserveCode}`, workload }));
      assert.equal(lease.allowed, false);
      assert.equal(lease.mode, "continuity");
      assert.equal(
        lease.code,
        [
          "ALLOWANCE_UNKNOWN", "ALLOWANCE_SNAPSHOT_EXPIRED", "POOL_NOT_FOUND",
          "ALLOWANCE_LEASE_CROSSES_RESET", "CAPACITY_UNAVAILABLE",
          "CAPACITY_STORE_UNAVAILABLE",
        ].includes(reserveCode)
          ? "CONTINUITY_DEGRADED" : "CONTINUITY_HARD_LIMIT"
      );
    }
  }
});

test("a durable store exception is sanitized and degrades continuity without escaping", async () => {
  const store = {
    durable: true,
    async reserveBundle() { throw new Error("private database detail"); },
  };
  const frontline = await createAdmissionController({
    enabled: true, capacityStore: store,
  }).acquire(action({ actionKey: "store-failure-frontline", workload: "frontline" }));
  assert.equal(frontline.code, "CONTINUITY_DEGRADED");
  assert.equal(frontline.mode, "continuity");
  const experiment = await createAdmissionController({
    enabled: true, capacityStore: store,
  }).acquire(action({ actionKey: "store-failure-experiment" }));
  assert.equal(experiment.code, "CAPACITY_STORE_UNAVAILABLE");
  assert.equal(experiment.mode, "enforced");
});

test("action and verification capacity are reserved together", async () => {
  const store = createInMemoryCapacityStore({ requests: 1 });
  const controller = createAdmissionController({ enabled: true, capacityStore: store });
  const lease = await controller.acquire(action());
  assert.equal(lease.allowed, false);
  assert.equal(lease.code, "CAPACITY_UNAVAILABLE");
  assert.equal(store.snapshot().remaining.requests, 1);
});

test("two simultaneous requests cannot both consume the final shared allowance", async () => {
  const store = createInMemoryCapacityStore({ requests: 6 });
  const one = createAdmissionController({ enabled: true, capacityStore: store });
  const two = createAdmissionController({ enabled: true, capacityStore: store });
  const request = (key) => action({
    actionKey: key,
    requirements: { action: [{ pool: "requests", units: 4 }], verification: [{ pool: "requests", units: 2 }] },
  });
  const results = await Promise.all([one.acquire(request("agent-one")), two.acquire(request("agent-two"))]);
  assert.equal(results.filter((item) => item.allowed).length, 1);
  assert.equal(results.filter((item) => item.code === "CAPACITY_UNAVAILABLE").length, 1);
  assert.equal(store.snapshot().remaining.requests, 0);
});

test("reservation keys prevent duplicate execution and changed requests conflict", async () => {
  const store = createInMemoryCapacityStore({ requests: 4 });
  const controller = createAdmissionController({ enabled: true, capacityStore: store });
  const first = await controller.acquire(action());
  const repeated = await controller.acquire(action());
  assert.equal(first.allowed, true);
  assert.equal(repeated.allowed, false);
  assert.equal(repeated.code, "IDEMPOTENT_REPLAY");
  assert.equal(repeated.reservationId, first.reservationId);
  assert.equal(store.snapshot().remaining.requests, 2);
  const changed = await controller.acquire(action({ actionType: "different_synthetic_check" }));
  assert.equal(changed.allowed, false);
  assert.equal(changed.code, "IDEMPOTENCY_CONFLICT");
});

test("pre-dispatch cancellation releases capacity while uncertain dispatched work stays reserved", async () => {
  const store = createInMemoryCapacityStore({ requests: 4 });
  const controller = createAdmissionController({ enabled: true, capacityStore: store });
  const before = await controller.acquire(action({ actionKey: "before" }));
  assert.equal((await before.settle({ outcome: "cancelled_before_dispatch" })).state, "released");
  assert.equal(store.snapshot().remaining.requests, 4);
  const retried = await controller.acquire(action({ actionKey: "before" }));
  assert.equal(retried.allowed, true, "a pre-dispatch cancellation may be safely reserved again");
  assert.notEqual(retried.reservationId, before.reservationId);
  await retried.settle({ outcome: "cancelled_before_dispatch" });
  const after = await controller.acquire(action({ actionKey: "after" }));
  await after.markDispatched();
  assert.equal((await after.settle({ outcome: "transport_uncertain" })).state, "reconcile");
  assert.equal(store.snapshot().remaining.requests, 2);
});

test("irreversible work requires founder approval, idempotency, and recovery evidence", async () => {
  const store = createInMemoryCapacityStore({ requests: 2 });
  const controller = createAdmissionController({ enabled: true, capacityStore: store });
  const denied = await controller.acquire(action({ irreversible: true }));
  assert.equal(denied.code, "FAILURE_UNSAFE");
  const allowed = await controller.acquire(action({
    actionKey: "approved-irreversible",
    irreversible: true,
    facts: { ...PASSING_FACTS, founderApproved: true, idempotencyProtected: true, recoveryReady: true },
  }));
  assert.equal(allowed.allowed, true);
});

test("passports allow local synthetic Ollama work and block unknown OpenRouter allowance", async () => {
  const register = loadPassportRegister();
  const local = await admitPassportAction({
    serviceId: "ollama", actionKey: "local-test", operation: "run_local_synthetic_model",
    workflow: "local_agent_lab", workload: "engineering",
  }, {
    register,
    capacityStore: createInMemoryCapacityStore(),
    trustedContext: {
      trustSource: "fixed_internal_cli", actor: "engineer", dataClass: "synthetic",
      workload: "engineering", workflow: "local_agent_lab", goalRelevant: true,
    },
  });
  assert.equal(local.allowed, true);

  const remote = await admitPassportAction({
    serviceId: "openrouter_public_test", actionKey: "remote-test", operation: "run_public_synthetic_probe",
    workflow: "public_model_probe", workload: "experiment", potentiallyBillable: false,
  }, {
    register,
    capacityStore: createInMemoryCapacityStore(),
    trustedContext: {
      trustSource: "fixed_internal_cli", actor: "engineer", dataClass: "synthetic",
      workload: "experiment", workflow: "public_model_probe", goalRelevant: true,
    },
  });
  assert.equal(remote.allowed, false);
  assert.equal(remote.code, "ALLOWANCE_UNKNOWN");
});

test("passport admission requires server-authenticated context and keeps goal relevance separate", async () => {
  const register = loadPassportRegister();
  const proposed = {
    serviceId: "ollama", actionKey: "trusted-context", operation: "run_local_synthetic_model",
  };
  const missing = await admitPassportAction(proposed, { register, capacityStore: createInMemoryCapacityStore() });
  assert.equal(missing.code, "TRUSTED_CONTEXT_REQUIRED");

  const irrelevant = await admitPassportAction(proposed, {
    register,
    capacityStore: createInMemoryCapacityStore(),
    trustedContext: trusted({ goalRelevant: false }),
  });
  assert.equal(irrelevant.code, "GOAL_IRRELEVANT");
});

test("not_applicable evidence cannot satisfy behavior-tested admission", async () => {
  const register = loadPassportRegister();
  register.services.find((service) => service.id === "ollama").executionContract.evidenceStatus = "not_applicable";
  const lease = await admitPassportAction({
    serviceId: "ollama", actionKey: "not-applicable", operation: "run_local_synthetic_model",
  }, { register, capacityStore: createInMemoryCapacityStore(), trustedContext: trusted() });
  assert.equal(lease.allowed, false);
  assert.equal(lease.code, "INCOMPATIBLE");
});

test("frontline and operator work both require exact workflow acceptance", async () => {
  const register = loadPassportRegister();
  for (const workload of ["frontline", "operator"]) {
    const lease = await admitPassportAction({
      serviceId: "ollama", actionKey: `accepted-${workload}`, operation: "run_local_synthetic_model",
    }, {
      register,
      capacityStore: createInMemoryCapacityStore(),
      trustedContext: trusted({ workload, workflow: "unaccepted_workflow" }),
    });
    assert.equal(lease.allowed, false, workload);
    assert.equal(lease.code, "INCOMPATIBLE", workload);
  }
});

test("passport-owned consequential classification cannot be bypassed by action fields", async () => {
  const register = loadPassportRegister();
  const passport = register.services.find((service) => service.id === "ollama");
  passport.admission.consequentialOperations = ["run_local_synthetic_model"];
  const lease = await admitPassportAction({
    serviceId: "ollama", actionKey: "consequential", operation: "run_local_synthetic_model",
    irreversible: false,
  }, {
    register,
    capacityStore: createInMemoryCapacityStore(),
    trustedContext: trusted({ founderApproved: true, idempotencyProtected: false, recoveryReady: true }),
  });
  assert.equal(lease.allowed, false);
  assert.equal(lease.code, "FAILURE_UNSAFE");
});

test("verified external allowance requires a durable shared capacity store", async () => {
  const register = loadPassportRegister();
  const passport = register.services.find((service) => service.id === "openrouter_public_test");
  passport.admission.allowance.status = "verified_available";
  passport.admission.allowance.remaining = 2;
  const lease = await admitPassportAction({
    serviceId: "openrouter_public_test", actionKey: "durable-required", operation: "run_public_synthetic_probe",
  }, {
    register,
    capacityStore: createInMemoryCapacityStore({ openrouter_account: 2 }),
    trustedContext: trusted({ workload: "experiment", workflow: "public_model_probe" }),
  });
  assert.equal(lease.allowed, false);
  assert.equal(lease.code, "DURABLE_RESERVATION_REQUIRED");
});

test("admission decisions and audits identify the exact passport revision", async () => {
  const register = loadPassportRegister();
  const audits = [];
  const lease = await admitPassportAction({
    serviceId: "ollama", actionKey: "version-bound", operation: "run_local_synthetic_model",
  }, {
    register,
    capacityStore: createInMemoryCapacityStore(),
    trustedContext: trusted(),
    audit: async (entry) => audits.push(entry),
  });
  assert.equal(lease.policyContext.registerVersion, register.registerVersion);
  assert.equal(lease.policyContext.serviceId, "ollama");
  assert.match(lease.policyContext.passportDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(audits[0].policyContext, lease.policyContext);
});

test("trace redaction removes credentials, signed URLs, activation codes, and LINE identifiers", () => {
  const redacted = redactTracePayload({
    authorization: "Bearer private-value",
    nested: {
      api_key: "private-value",
      signed_url: "https://example.com/upload?t=private-value",
      activation_code: "NH-EXAMPLE",
      line_user_id: "U-private",
      safe: "fictional order 42",
      text: "Use sk-private-example-value-123456789 only in this test",
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    },
  });
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.nested.api_key, "[REDACTED]");
  assert.equal(redacted.nested.signed_url, "[REDACTED]");
  assert.equal(redacted.nested.activation_code, "[REDACTED]");
  assert.equal(redacted.nested.line_user_id, "[REDACTED]");
  assert.equal(redacted.nested.safe, "fictional order 42");
  assert.doesNotMatch(redacted.nested.text, /sk-private/);
  assert.deepEqual(redacted.nested.usage, { input_tokens: 12, output_tokens: 4, total_tokens: 16 });
});
