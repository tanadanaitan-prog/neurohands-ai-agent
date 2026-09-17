"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { loadPassportRegister } = require("./software-passports");

const WORKLOADS = new Set(["frontline", "operator", "optional", "experiment", "engineering"]);
const BEHAVIOR_READY = new Set(["behavior_tested", "accepted_for_workflow"]);
const TRUST_SOURCES = new Set(["server_authenticated", "fixed_internal_cli"]);
const CHECKS = Object.freeze([
  ["goalRelevant", "GOAL_IRRELEVANT"],
  ["permissionGranted", "PERMISSION_DENIED"],
  ["dataPermitted", "DATA_NOT_PERMITTED"],
  ["compatible", "INCOMPATIBLE"],
  ["failureSafe", "FAILURE_UNSAFE"],
  ["verificationPossible", "VERIFICATION_UNAVAILABLE"],
]);

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

function safeRequirements(requirements) {
  if (!Array.isArray(requirements)) return null;
  const combined = new Map();
  for (const item of requirements) {
    if (!item || typeof item.pool !== "string" || !/^[a-z][a-z0-9_.-]+$/.test(item.pool) ||
        !Number.isSafeInteger(item.units) || item.units < 0) return null;
    combined.set(item.pool, (combined.get(item.pool) || 0) + item.units);
  }
  return [...combined].sort(([a], [b]) => a.localeCompare(b)).map(([pool, units]) => ({ pool, units }));
}

function createInMemoryCapacityStore(initialPools = {}) {
  const remaining = new Map();
  for (const [pool, units] of Object.entries(initialPools)) {
    if (!Number.isSafeInteger(units) || units < 0) throw new TypeError(`Invalid capacity for ${pool}`);
    remaining.set(pool, units);
  }
  const reservations = new Map();
  const keys = new Map();

  return Object.freeze({
    durable: false,
    async reserveBundle({ reservationKey, requirements, expiresAt, requestDigest }) {
      const priorId = keys.get(reservationKey);
      if (priorId) {
        const prior = reservations.get(priorId);
        return prior.requestDigest === requestDigest
          ? { ok: true, reservationId: priorId, idempotent: true, state: prior.state }
          : { ok: false, code: "IDEMPOTENCY_CONFLICT" };
      }
      for (const requirement of requirements) {
        if (!remaining.has(requirement.pool) || remaining.get(requirement.pool) < requirement.units) {
          return { ok: false, code: "CAPACITY_UNAVAILABLE", pool: requirement.pool };
        }
      }
      const reservationId = randomUUID();
      for (const requirement of requirements) remaining.set(requirement.pool, remaining.get(requirement.pool) - requirement.units);
      reservations.set(reservationId, {
        reservationKey, requestDigest, requirements, expiresAt, dispatched: false, state: "reserved",
      });
      keys.set(reservationKey, reservationId);
      return { ok: true, reservationId, idempotent: false };
    },
    async markDispatched({ reservationId }) {
      const reservation = reservations.get(reservationId);
      if (!reservation || reservation.state !== "reserved") return { ok: false, code: "RESERVATION_NOT_ACTIVE" };
      reservation.dispatched = true;
      return { ok: true };
    },
    async settle({ reservationId, outcome }) {
      const reservation = reservations.get(reservationId);
      if (!reservation || reservation.state !== "reserved") return { ok: false, code: "RESERVATION_NOT_ACTIVE" };
      if (outcome === "cancelled_before_dispatch" && !reservation.dispatched) {
        for (const requirement of reservation.requirements) {
          remaining.set(requirement.pool, remaining.get(requirement.pool) + requirement.units);
        }
        reservation.state = "released";
        keys.delete(reservation.reservationKey);
      } else reservation.state = outcome === "transport_uncertain" ? "reconcile" : "consumed";
      return { ok: true, state: reservation.state };
    },
    snapshot() {
      return {
        remaining: Object.fromEntries([...remaining].sort(([a], [b]) => a.localeCompare(b))),
        reservations: [...reservations.entries()].map(([reservationId, value]) => ({ reservationId, ...value })),
      };
    },
  });
}

function decision({
  allowed = false, mode = "enforced", code, checks = [], reservationId = null,
  store = null, policyContext = null, actorId = null, reservedRequirements = null,
}) {
  return Object.freeze({
    allowed, mode, code, checks: Object.freeze(checks), reservationId,
    policyContext: policyContext ? Object.freeze({ ...policyContext }) : null,
    async markDispatched() {
      if (!reservationId || !store) return { ok: allowed };
      return store.markDispatched({ reservationId, actorId });
    },
    async settle({ outcome = "completed", actualRequirements = null } = {}) {
      if (!reservationId || !store) return { ok: allowed };
      return store.settle({
        reservationId,
        outcome,
        actorId,
        actualRequirements: actualRequirements || reservedRequirements,
      });
    },
  });
}

function createAdmissionController({
  enabled = false,
  capacityStore = null,
  audit = async () => {},
  now = () => new Date(),
  idFactory = randomUUID,
  frontlineUnknownPolicy = "degrade_and_alert",
} = {}) {
  if (enabled && !capacityStore) throw new TypeError("An enabled admission controller requires a capacity store");
  return Object.freeze({
    async acquire(input = {}) {
      const policyContext = input.policyContext && typeof input.policyContext === "object"
        ? { ...input.policyContext }
        : null;
      if (!enabled) return decision({
        allowed: true, mode: "disabled", code: "ADMISSION_DISABLED", policyContext,
      });
      const workload = WORKLOADS.has(input.workload) ? input.workload : null;
      const facts = input.facts || {};
      const checks = [];
      const finish = async (spec, extraAudit = {}) => {
        const result = decision({ ...spec, policyContext });
        await audit({
          actionKey: input.actionKey || null,
          outcome: result.code,
          policyContext,
          checks: spec.checks || checks,
          ...extraAudit,
        });
        return result;
      };
      if (!workload) checks.push({ name: "workload", pass: false, code: "INVALID_WORKLOAD" });
      for (const [name, code] of CHECKS) checks.push({ name, pass: facts[name] === true, code: facts[name] === true ? "PASS" : code });
      if (input.irreversible) {
        const safe = facts.founderApproved === true && facts.idempotencyProtected === true && facts.recoveryReady === true;
        checks.push({ name: "irreversibleSafety", pass: safe, code: safe ? "PASS" : "FAILURE_UNSAFE" });
      }
      const failed = checks.find((item) => !item.pass);
      if (failed) return finish({ code: failed.code, checks });
      const allowanceStatus = facts.allowanceStatus;
      if (allowanceStatus === "verified_exhausted") {
        const continuity = workload === "frontline" || workload === "operator";
        return finish({
          code: continuity ? "CONTINUITY_HARD_LIMIT" : "ALLOWANCE_EXHAUSTED",
          mode: continuity ? "continuity" : "enforced",
          checks,
        });
      }
      if (input.potentiallyBillable && allowanceStatus === "unknown") {
        const continuity = workload === "frontline" || workload === "operator";
        return finish({
          code: continuity ? "CONTINUITY_DEGRADED" : "ALLOWANCE_UNKNOWN",
          mode: continuity ? "continuity" : "enforced",
          checks,
        }, { policy: continuity ? frontlineUnknownPolicy : null });
      }
      if (input.potentiallyBillable && !["verified_available", "not_metered"].includes(allowanceStatus)) {
        return finish({ code: "ALLOWANCE_UNVERIFIED", checks });
      }
      if (input.requirementsVerified !== true) {
        return finish({ code: "REQUIREMENTS_UNVERIFIED", checks });
      }
      if (input.requiresDurableStore === true && capacityStore.durable !== true) {
        return finish({ code: "DURABLE_RESERVATION_REQUIRED", checks });
      }
      const actionRequirements = safeRequirements(input.requirements?.action || []);
      const verificationRequirements = safeRequirements(input.requirements?.verification || []);
      if (!actionRequirements || !verificationRequirements) {
        return finish({ code: "INVALID_REQUIREMENTS", checks });
      }
      const requirements = safeRequirements([...actionRequirements, ...verificationRequirements]);
      const actionKey = typeof input.actionKey === "string" && input.actionKey.trim() ? input.actionKey.trim() : idFactory();
      const requestDigest = digest({
        actionKey, actionType: input.actionType || null, actor: input.actor || null,
        actorId: input.actorId || null,
        workload, subject: input.subject || null,
        facts, requirements, irreversible: input.irreversible === true, policyContext,
      });
      let reserved;
      try {
        reserved = await capacityStore.reserveBundle({
          reservationKey: actionKey,
          requirements,
          actionRequirements,
          verificationRequirements,
          actor: input.actor || null,
          actorId: input.actorId || input.actor || null,
          workload,
          operation: input.actionType || null,
          expiresAt: new Date(now().getTime() + 5 * 60 * 1000).toISOString(),
          requestDigest,
        });
      } catch {
        reserved = { ok: false, code: "CAPACITY_STORE_UNAVAILABLE" };
      }
      if (!reserved.ok) {
        const reserveCode = reserved.code || "CAPACITY_UNAVAILABLE";
        const continuity = workload === "frontline" || workload === "operator";
        if (continuity && ["ALLOWANCE_EXHAUSTED", "ALLOWANCE_INSUFFICIENT"].includes(reserveCode)) {
          return finish({ code: "CONTINUITY_HARD_LIMIT", mode: "continuity", checks }, {
            capacityCode: reserveCode,
          });
        }
        if (continuity && [
          "ALLOWANCE_UNKNOWN", "ALLOWANCE_SNAPSHOT_EXPIRED", "POOL_NOT_FOUND",
          "ALLOWANCE_LEASE_CROSSES_RESET", "CAPACITY_UNAVAILABLE",
          "CAPACITY_STORE_UNAVAILABLE",
        ].includes(reserveCode)) {
          return finish({ code: "CONTINUITY_DEGRADED", mode: "continuity", checks }, {
            capacityCode: reserveCode,
            policy: frontlineUnknownPolicy,
          });
        }
        return finish({ code: reserveCode, checks });
      }
      if (reserved.idempotent) {
        return finish({ code: "IDEMPOTENT_REPLAY", checks, reservationId: reserved.reservationId },
          { reservationId: reserved.reservationId });
      }
      const result = decision({
        allowed: true,
        code: facts.alertThresholdReached === true || reserved.alertRequired === true
          ? "ALLOWED_WITH_ALERT" : "ALLOWED",
        checks,
        reservationId: reserved.reservationId,
        store: capacityStore,
        policyContext,
        actorId: input.actorId || input.actor || null,
        reservedRequirements: requirements,
      });
      await audit({ actionKey, outcome: result.code, reservationId: result.reservationId, policyContext, checks });
      return result;
    },
  });
}

async function admitPassportAction(action, options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) return decision({ allowed: true, mode: "disabled", code: "ADMISSION_DISABLED" });
  const register = options.register || loadPassportRegister();
  const capacityStore = options.capacityStore || createInMemoryCapacityStore();
  const { audit, trustedContext } = options;
  const service = register.services.find((item) => item.id === action?.serviceId);
  const policyContext = {
    registerVersion: register.registerVersion || null,
    serviceId: action?.serviceId || null,
    passportDigest: service ? digest(service) : null,
  };
  if (!service) return decision({ code: "PASSPORT_MISSING", policyContext });
  if (!trustedContext || !TRUST_SOURCES.has(trustedContext.trustSource) || typeof trustedContext.actor !== "string" ||
      typeof trustedContext.dataClass !== "string" || !WORKLOADS.has(trustedContext.workload) ||
      typeof trustedContext.workflow !== "string" || typeof trustedContext.goalRelevant !== "boolean") {
    const result = decision({ code: "TRUSTED_CONTEXT_REQUIRED", policyContext });
    if (audit) await audit({ actionKey: action?.actionKey || null, outcome: result.code, policyContext, checks: [] });
    return result;
  }
  const admission = service.admission;
  const actorAllowed = admission.allowedActors.includes(trustedContext.actor);
  const operationAllowed = admission.supportedOperations.includes(action.operation);
  const dataAllowed = admission.allowedDataClasses.includes(trustedContext.dataClass);
  const workflowAccepted = admission.acceptedWorkflows.includes(trustedContext.workflow);
  const compatibilityReady = BEHAVIOR_READY.has(service.executionContract.evidenceStatus);
  const failureSafe = BEHAVIOR_READY.has(service.recoveryChange.evidenceStatus);
  const verificationPossible = BEHAVIOR_READY.has(admission.verificationEvidenceStatus);
  const irreversible = admission.consequentialOperations.includes(action.operation);
  const requirements = admission.operationRequirements[action.operation] ?? null;
  const controller = createAdmissionController({ enabled, capacityStore, audit });
  return controller.acquire({
    actionKey: action.actionKey,
    actionType: action.operation,
    actor: trustedContext.actor,
    actorId: trustedContext.actorId || trustedContext.actor,
    workload: trustedContext.workload,
    subject: action.subject || null,
    policyContext,
    potentiallyBillable: admission.externalMeter === "metered_or_unknown",
    irreversible,
    requirementsVerified: requirements !== null,
    requiresDurableStore: admission.externalMeter === "metered_or_unknown" &&
      admission.allowance.status === "verified_available",
    facts: {
      goalRelevant: trustedContext.goalRelevant === true,
      permissionGranted: actorAllowed && operationAllowed && (trustedContext.founderApproved === true || !irreversible),
      dataPermitted: dataAllowed,
      compatible: compatibilityReady &&
        (workflowAccepted || !["frontline", "operator"].includes(trustedContext.workload)),
      allowanceStatus: admission.allowance.status,
      failureSafe,
      verificationPossible,
      founderApproved: trustedContext.founderApproved === true,
      idempotencyProtected: trustedContext.idempotencyProtected === true,
      recoveryReady: trustedContext.recoveryReady === true,
    },
    requirements,
  });
}

function redactTracePayload(value) {
  const sensitiveKey = /(?:api[_-]?key|authorization|password|secret|token|signed[_-]?url|activation[_-]?code|line[_-]?(?:id|user))/i;
  const sensitiveValue = /(?:\blsv2_[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]+|\bsb_secret_[A-Za-z0-9_-]+|Bearer\s+\S+|https?:\/\/\S+[?&](?:t|token|signature|key)=\S+)/gi;
  if (Array.isArray(value)) return value.map(redactTracePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redactTracePayload(child)]));
  }
  if (typeof value === "string") return value.replace(sensitiveValue, "[REDACTED]");
  return value;
}

module.exports = {
  admitPassportAction,
  createAdmissionController,
  createInMemoryCapacityStore,
  redactTracePayload,
};
