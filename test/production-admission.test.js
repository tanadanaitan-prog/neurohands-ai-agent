"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProductionAdmission, parseFlag } = require("../src/lib/production-admission");
const { loadPassportRegister } = require("../src/lib/software-passports");

function durableStore() {
  const calls = [];
  return {
    durable: true,
    calls,
    async checkReady() { calls.push(["ready"]); return true; },
    async reserveBundle(input) { calls.push(["reserve", input]); return { ok: true, reservationId: "reservation-1" }; },
    async markDispatched(input) { calls.push(["dispatch", input]); return { ok: true }; },
    async settle(input) { calls.push(["settle", input]); return { ok: true, state: "consumed" }; },
  };
}

const runtimeScope = Object.freeze({
  principalId: "runtime-line",
  clientAccountId: "client-1",
  department: "sales",
  resource: "agent-response",
});

function dependencies(overrides = {}) {
  const audits = [];
  return {
    capacityStore: durableStore(),
    audit: async (entry) => { audits.push(entry); },
    principalResolver: async ({ authority }) => authority === "trusted-runtime"
      ? { role: "runtime", scope: runtimeScope }
      : null,
    audits,
    ...overrides,
  };
}

test("disabled production admission does not load passports, use capacity, resolve authority, or audit", async () => {
  for (const flag of [undefined, "", false, "false"]) {
    let touched = false;
    const gate = createProductionAdmission({
      flag,
      capacityStore: { get durable() { touched = true; return true; } },
      registerLoader() { touched = true; },
      principalResolver() { touched = true; },
      audit() { touched = true; },
    });
    const lease = await gate.acquire("invented.action", { authority: "untrusted" });
    assert.equal(gate.enabled, false);
    assert.equal(gate.ready, true);
    assert.equal(lease.allowed, true);
    assert.equal(lease.code, "ADMISSION_DISABLED");
    assert.equal(touched, false);
  }
});

test("the enable flag accepts only exact true or false values", () => {
  assert.equal(parseFlag("true"), true);
  assert.equal(parseFlag("false"), false);
  for (const value of ["TRUE", "1", 1, "yes", " true "]) {
    assert.throws(() => parseFlag(value), { code: "INVALID_SOFTWARE_ADMISSION_FLAG" });
  }
});

test("enabled production admission refuses incomplete dependencies before loading passports", async () => {
  for (const partial of [
    { capacityStore: null, audit: async () => {}, principalResolver: async () => null },
    { capacityStore: { durable: false }, audit: async () => {}, principalResolver: async () => null },
    { capacityStore: { durable: true }, audit: async () => {}, principalResolver: async () => null },
    { capacityStore: durableStore(), audit: null, principalResolver: async () => null },
    { capacityStore: durableStore(), audit: async () => {}, principalResolver: null },
  ]) {
    let loaded = false;
    const gate = createProductionAdmission({ flag: "true", ...partial, registerLoader() { loaded = true; } });
    const lease = await gate.acquire("model.gemini.frontline");
    assert.equal(gate.enabled, true);
    assert.equal(gate.ready, false);
    assert.equal(lease.allowed, false);
    assert.equal(lease.code, "ADMISSION_DEPENDENCIES_REQUIRED");
    assert.equal(loaded, false);
  }
});

test("closed policy, server resolver and tenant scope control an admitted action", async () => {
  const register = loadPassportRegister();
  const gemini = register.services.find((service) => service.id === "gemini");
  gemini.admission.acceptedWorkflows = ["line_agent_response"];
  gemini.admission.evidenceStatus = "accepted_for_workflow";
  gemini.admission.allowance = { status: "verified_available", poolId: "gemini_project", remaining: 2, unit: "request" };
  gemini.admission.operationRequirements.generate_agent_response = {
    action: [{ pool: "gemini_project", units: 1 }],
    verification: [{ pool: "gemini_project", units: 1 }],
  };
  const deps = dependencies();
  const gate = createProductionAdmission({ flag: "true", ...deps, registerLoader: () => register });

  assert.equal((await gate.acquire("invented.action", {})).code, "POLICY_ACTION_UNKNOWN");
  assert.equal((await gate.acquire("toString", {})).code, "POLICY_ACTION_UNKNOWN");
  assert.equal((await gate.acquire("model.gemini.frontline", {
    actionKey: "run-1.gemini.1",
    authority: { verifiedByServer: true, role: "runtime", scope: runtimeScope },
  })).code, "TRUSTED_PRINCIPAL_REQUIRED");
  assert.equal((await gate.acquire("model.gemini.frontline", {
    actionKey: "contains spaces", authority: "trusted-runtime",
  })).code, "STABLE_ACTION_KEY_REQUIRED");

  const lease = await gate.acquire("model.gemini.frontline", {
    actionKey: "run-1.gemini.1",
    authority: "trusted-runtime",
    runId: 1,
    actor: "founder", workload: "experiment", dataClass: "public", workflow: "bypass",
  });
  assert.equal(lease.allowed, true);
  assert.equal(lease.policyContext.serviceId, "gemini");
  const reservation = deps.capacityStore.calls.find(([name]) => name === "reserve")[1];
  assert.deepEqual(reservation.requirements, [{ pool: "gemini_project", units: 2 }]);
  assert.equal(reservation.actorId, "runtime-line");
  assert.equal((await lease.markDispatched()).ok, true);
  assert.equal(deps.capacityStore.calls.find(([name]) => name === "dispatch")[1].actorId, "runtime-line");
  assert.equal(deps.audits.some((entry) => entry.outcome === "POLICY_ACTION_UNKNOWN"), true);
});

test("missing tenant scope and an unaccepted production workflow stay blocked", async () => {
  const missingScope = dependencies({
    principalResolver: async () => ({ role: "runtime", scope: { principalId: "runtime-line" } }),
  });
  const scopeGate = createProductionAdmission({ flag: "true", ...missingScope });
  const scopeDecision = await scopeGate.acquire("model.gemini.frontline", {
    actionKey: "run-2.gemini.scope", authority: "trusted-runtime",
  });
  assert.equal(scopeDecision.code, "TRUSTED_SCOPE_REQUIRED");

  const deps = dependencies();
  const gate = createProductionAdmission({ flag: "true", ...deps, registerLoader: loadPassportRegister });
  const lease = await gate.acquire("model.gemini.frontline", {
    actionKey: "run-2.gemini.1", authority: "trusted-runtime", runId: 2,
  });
  assert.equal(lease.allowed, false);
  assert.equal(lease.code, "INCOMPATIBLE");
});

test("an unavailable durable store degrades frontline and operator without permitting dispatch", async () => {
  const unavailable = dependencies({
    capacityStore: { ...durableStore(), async checkReady() { return false; } },
    principalResolver: async ({ expectedRole }) => expectedRole === "runtime"
      ? { role: "runtime", scope: runtimeScope }
      : { role: "founder", scope: { principalId: "founder-opaque", resource: "operator-response" } },
  });
  const gate = createProductionAdmission({ flag: "true", ...unavailable });
  for (const [actionId, authority] of [
    ["model.gemini.frontline", "trusted-runtime"],
    ["model.gemini.operator", "trusted-founder"],
  ]) {
    const denied = await gate.acquire(actionId, {
      actionKey: `run-3.${actionId}`, authority, runId: 3,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "CONTINUITY_DEGRADED");
    assert.equal(denied.mode, "continuity");
    assert.equal(denied.reasonCode, "DURABLE_CAPACITY_STORE_UNAVAILABLE");
  }
});

test("a failed early-denial audit remains closed", async () => {
  const failedAudit = dependencies({ audit: async () => { throw new Error("audit unavailable"); } });
  const failedGate = createProductionAdmission({ flag: "true", ...failedAudit });
  const failed = await failedGate.acquire("unknown.action", {});
  assert.equal(failed.allowed, false);
  assert.equal(failed.code, "ADMISSION_AUDIT_FAILED");
  assert.equal(failed.reasonCode, "POLICY_ACTION_UNKNOWN");
});
