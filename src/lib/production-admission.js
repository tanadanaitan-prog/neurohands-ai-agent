"use strict";

const { admitPassportAction } = require("./admission-control");
const { loadPassportRegister } = require("./software-passports");

const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const REQUEST_FINGERPRINT = /^[a-f0-9]{64}$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const ACTION_CATALOG = deepFreeze({
  "model.gemini.frontline": {
    serviceId: "gemini", operation: "generate_agent_response", actor: "runtime",
    dataClass: "customer_private", workload: "frontline", workflow: "line_agent_response",
    scopeFields: ["principalId", "clientAccountId", "department", "resource"],
  },
  "model.gemini.operator": {
    serviceId: "gemini", operation: "generate_agent_response", actor: "founder",
    dataClass: "customer_private", workload: "operator", workflow: "jarvis_operator",
    scopeFields: ["principalId", "resource"],
  },
  "model.gemini.concierge": {
    serviceId: "gemini", operation: "generate_agent_response", actor: "runtime",
    dataClass: "public", workload: "frontline", workflow: "public_concierge",
    scopeFields: ["principalId", "resource"],
  },
  "model.openai.frontline": {
    serviceId: "openai_api", operation: "generate_agent_response", actor: "runtime",
    dataClass: "customer_private", workload: "frontline", workflow: "line_agent_response",
    scopeFields: ["principalId", "clientAccountId", "department", "resource"],
  },
  "model.openai.operator": {
    serviceId: "openai_api", operation: "generate_agent_response", actor: "founder",
    dataClass: "customer_private", workload: "operator", workflow: "jarvis_operator",
    scopeFields: ["principalId", "resource"],
  },
  "model.openai.concierge": {
    serviceId: "openai_api", operation: "generate_agent_response", actor: "runtime",
    dataClass: "public", workload: "frontline", workflow: "public_concierge",
    scopeFields: ["principalId", "resource"],
  },
  "data.supabase.read.frontline": {
    serviceId: "supabase", operation: "read_scoped_record", actor: "runtime",
    dataClass: "customer_private", workload: "frontline", workflow: "line_agent_response",
    scopeFields: ["principalId", "clientAccountId", "department", "resource"],
  },
  "data.supabase.read.operator": {
    serviceId: "supabase", operation: "read_scoped_record", actor: "founder",
    dataClass: "operational_metadata", workload: "operator", workflow: "jarvis_operator",
    scopeFields: ["principalId", "resource"],
  },
  "data.supabase.write.frontline": {
    serviceId: "supabase", operation: "write_scoped_record", actor: "runtime",
    dataClass: "customer_private", workload: "frontline", workflow: "line_agent_response",
    scopeFields: ["principalId", "clientAccountId", "department", "resource"],
  },
  "data.supabase.write.operator": {
    serviceId: "supabase", operation: "write_scoped_record", actor: "founder",
    dataClass: "operational_metadata", workload: "operator", workflow: "jarvis_operator",
    scopeFields: ["principalId", "resource"],
  },
  "data.supabase.store_upload": {
    serviceId: "supabase", operation: "store_private_document", actor: "runtime",
    dataClass: "customer_private", workload: "frontline", workflow: "secure_document_upload",
    scopeFields: ["principalId", "clientAccountId", "department", "resource"],
  },
  "line.reply.frontline": {
    serviceId: "line", operation: "reply_message", actor: "runtime",
    dataClass: "customer_private", workload: "frontline", workflow: "line_agent_response",
    scopeFields: ["principalId", "clientAccountId", "department", "resource"],
  },
  "line.reply.operator": {
    serviceId: "line", operation: "reply_message", actor: "founder",
    dataClass: "operational_metadata", workload: "operator", workflow: "jarvis_operator",
    scopeFields: ["principalId", "resource"],
  },
  "line.push.operator": {
    serviceId: "line", operation: "push_message", actor: "founder",
    dataClass: "operational_metadata", workload: "operator", workflow: "jarvis_operator",
    scopeFields: ["principalId", "resource"],
  },
});

function parseFlag(value) {
  if (value === undefined || value === null || value === "" || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  const error = new Error("SOFTWARE_ADMISSION_ENABLED must be true or false");
  error.code = "INVALID_SOFTWARE_ADMISSION_FLAG";
  throw error;
}

function fixedDecision({ allowed = false, mode = "enforced", code, reasonCode = null }) {
  return Object.freeze({
    allowed,
    mode,
    code,
    reasonCode,
    checks: Object.freeze([]),
    reservationId: null,
    policyContext: null,
    async markDispatched() { return { ok: allowed }; },
    async settle() { return { ok: allowed }; },
  });
}

function createProductionAdmission({
  flag = process.env.SOFTWARE_ADMISSION_ENABLED,
  capacityStore = null,
  registerLoader = loadPassportRegister,
  audit,
  principalResolver,
} = {}) {
  const enabled = parseFlag(flag);
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      ready: true,
      statusCode: "ADMISSION_DISABLED",
      async acquire() {
        return fixedDecision({ allowed: true, mode: "disabled", code: "ADMISSION_DISABLED" });
      },
    });
  }

  const storeReady = capacityStore?.durable === true &&
    ["reserveBundle", "markDispatched", "settle", "checkReady"].every((method) =>
      typeof capacityStore?.[method] === "function");
  const dependenciesReady = storeReady && typeof audit === "function" &&
    typeof principalResolver === "function";
  if (!dependenciesReady) {
    return Object.freeze({
      enabled: true,
      ready: false,
      statusCode: "ADMISSION_DEPENDENCIES_REQUIRED",
      async acquire() {
        return fixedDecision({ code: "ADMISSION_DEPENDENCIES_REQUIRED" });
      },
    });
  }

  const register = registerLoader();
  const deny = async (code, context = {}, { mode = "enforced", reasonCode = null } = {}) => {
    try {
      await audit({ event: "production_admission_denied", outcome: code, reasonCode, ...context });
      return fixedDecision({ code, mode, reasonCode });
    } catch {
      return fixedDecision({ code: "ADMISSION_AUDIT_FAILED", reasonCode: code });
    }
  };
  return Object.freeze({
    enabled: true,
    ready: true,
    statusCode: "ADMISSION_READY",
    async acquire(actionId, {
      actionKey,
      authority,
      runId = null,
      requestFingerprint,
    } = {}) {
      if (!Object.hasOwn(ACTION_CATALOG, actionId)) {
        return deny("POLICY_ACTION_UNKNOWN", { actionId: typeof actionId === "string" ? actionId : null });
      }
      const policy = ACTION_CATALOG[actionId];
      let principal;
      try {
        principal = await principalResolver({ actionId, authority, expectedRole: policy.actor });
      } catch {
        return deny("TRUSTED_PRINCIPAL_REQUIRED", { actionId });
      }
      if (!principal || principal.role !== policy.actor || !principal.scope ||
          typeof principal.scope !== "object" || Array.isArray(principal.scope)) {
        return deny("TRUSTED_PRINCIPAL_REQUIRED", { actionId });
      }
      const scope = {};
      for (const field of policy.scopeFields) {
        const value = principal.scope[field];
        if (!["string", "number"].includes(typeof value) || String(value).trim() === "" ||
            String(value).length > 192) {
          return deny("TRUSTED_SCOPE_REQUIRED", { actionId });
        }
        scope[field] = String(value);
      }
      if (typeof actionKey !== "string" || !ACTION_KEY.test(actionKey)) {
        return deny("STABLE_ACTION_KEY_REQUIRED", { actionId });
      }
      if (runId !== null && !["string", "number"].includes(typeof runId)) {
        return deny("TRUSTED_RUN_ID_REQUIRED", { actionId, actionKey });
      }
      if (typeof requestFingerprint !== "string" || !REQUEST_FINGERPRINT.test(requestFingerprint)) {
        return deny("REQUEST_FINGERPRINT_REQUIRED", { actionId, actionKey });
      }
      try {
        if (await capacityStore.checkReady() !== true) {
          const continuity = policy.workload === "frontline" || policy.workload === "operator";
          return deny(
            continuity ? "CONTINUITY_DEGRADED" : "DURABLE_CAPACITY_STORE_UNAVAILABLE",
            { actionId, actionKey },
            continuity ? { mode: "continuity", reasonCode: "DURABLE_CAPACITY_STORE_UNAVAILABLE" } : {}
          );
        }
      } catch {
        const continuity = policy.workload === "frontline" || policy.workload === "operator";
        return deny(
          continuity ? "CONTINUITY_DEGRADED" : "DURABLE_CAPACITY_STORE_UNAVAILABLE",
          { actionId, actionKey },
          continuity ? { mode: "continuity", reasonCode: "DURABLE_CAPACITY_STORE_UNAVAILABLE" } : {}
        );
      }
      const subject = {
        scope,
        requestFingerprint,
        ...(runId === null ? {} : { runId: String(runId).slice(0, 128) }),
      };
      return admitPassportAction({
        serviceId: policy.serviceId,
        actionKey,
        operation: policy.operation,
        subject,
      }, {
        register,
        capacityStore,
        audit,
        trustedContext: {
          trustSource: "server_authenticated",
          actor: policy.actor,
          actorId: scope.principalId,
          dataClass: policy.dataClass,
          workload: policy.workload,
          workflow: policy.workflow,
          goalRelevant: true,
          // Consequential approvals require a separate verified approval adapter.
          founderApproved: false,
          idempotencyProtected: false,
          recoveryReady: false,
        },
      });
    },
  });
}

module.exports = { ACTION_CATALOG, createProductionAdmission, parseFlag };
