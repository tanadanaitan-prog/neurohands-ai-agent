"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PASSPORT_PATH = path.resolve(__dirname, "../../config/software-passports.v1.json");
const EVIDENCE_STATUSES = Object.freeze([
  "unresolved",
  "published_rule",
  "account_verified_setting",
  "behavior_tested",
  "accepted_for_workflow",
  "not_applicable",
]);
const PLATFORMS = new Set(["frontline", "standby", "engineering_recovery"]);
const ALLOWANCE_STATUSES = new Set(["unknown", "not_metered", "verified_available", "verified_exhausted"]);
const ACCOUNT_EVIDENCE_STATUSES = new Set([
  "account_verified_setting", "behavior_tested", "accepted_for_workflow",
]);
const REQUIRED_SECTIONS = Object.freeze([
  "ownership", "planBilling", "capacity", "executionContract", "dataConditions",
  "permissions", "termsLicensing", "recoveryChange", "admission",
]);
const MATERIAL_DEPENDENCIES = Object.freeze([
  "railway", "github", "supabase", "line", "gemini", "langsmith", "ollama",
  "codex", "openai_api", "openrouter_public_test",
]);
const SECRET_KEYS = new Set([
  "apikey", "accesstoken", "channelsecret", "clientsecret", "credential", "password",
  "privatekey", "servicekey", "token", "secret",
]);
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\blsv2_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsb_secret_[A-Za-z0-9_-]{12,}/,
  /\bAIza[A-Za-z0-9_-]{20,}/,
  /\bgsk_[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[?&](?:t|token|key|signature)=[^\s&]{12,}/i,
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function scanForSecrets(value, currentPath = "register", findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${currentPath}[${index}]`, findings));
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${currentPath}.${key}`;
      if (SECRET_KEYS.has(normalizeKey(key)) && child !== null && child !== "") findings.push(`${childPath} must not contain a credential`);
      scanForSecrets(child, childPath, findings);
    }
    return findings;
  }
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      findings.push(`${currentPath} resembles a secret or signed URL`);
    }
    try {
      const candidate = new URL(value);
      if (["http:", "https:"].includes(candidate.protocol) && (candidate.username || candidate.password)) {
        findings.push(`${currentPath} contains URL credentials`);
      }
    } catch { /* Ordinary strings are not URLs. */ }
  }
  return findings;
}

function validateEvidence(evidence, serviceId, errors) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push(`${serviceId}.evidence must contain at least one dated source`);
    return;
  }
  const ids = new Set();
  evidence.forEach((item, index) => {
    const prefix = `${serviceId}.evidence[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]+$/.test(item.id)) errors.push(`${prefix}.id is invalid`);
    else if (ids.has(item.id)) errors.push(`${prefix}.id is duplicated`);
    else ids.add(item.id);
    if (!EVIDENCE_STATUSES.includes(item.status)) errors.push(`${prefix}.status is invalid`);
    if (typeof item.claim !== "string" || item.claim.trim().length < 8) errors.push(`${prefix}.claim is required`);
    if (!isDate(item.checkedOn)) errors.push(`${prefix}.checkedOn must be YYYY-MM-DD`);
    if (!item.source || typeof item.source !== "object") errors.push(`${prefix}.source is required`);
    else if (item.source.type === "url") {
      try {
        const url = new URL(item.source.value);
        if (url.protocol !== "https:") errors.push(`${prefix}.source URL must use HTTPS`);
      } catch { errors.push(`${prefix}.source URL is invalid`); }
    } else if (item.source.type === "repository") {
      if (typeof item.source.value !== "string" || item.source.value.startsWith("/") || item.source.value.includes("..")) {
        errors.push(`${prefix}.source repository path is invalid`);
      } else if (!fs.existsSync(path.resolve(__dirname, "../..", item.source.value))) {
        errors.push(`${prefix}.source repository path does not exist`);
      }
    } else errors.push(`${prefix}.source.type must be url or repository`);
  });
}

function validatePassportRegister(register) {
  const errors = [];
  const warnings = [];
  if (!register || typeof register !== "object" || Array.isArray(register)) {
    return { valid: false, errors: ["register must be an object"], warnings };
  }
  if (register.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
  if (typeof register.registerVersion !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(register.registerVersion)) {
    errors.push("registerVersion must use YYYY-MM-DD.N");
  }
  if (!isDate(register.reviewedOn)) errors.push("reviewedOn must be YYYY-MM-DD");
  if (!register.policy || register.policy.newSpendingUsd !== 0) errors.push("policy.newSpendingUsd must be 0");
  if (!Array.isArray(register.services)) errors.push("services must be an array");
  else {
    const ids = new Set();
    for (const service of register.services) {
      const id = service?.id || "unknown-service";
      if (!service || typeof service !== "object" || Array.isArray(service)) {
        errors.push("each service must be an object");
        continue;
      }
      if (!/^[a-z][a-z0-9_]+$/.test(id)) errors.push(`${id}.id is invalid`);
      if (ids.has(id)) errors.push(`${id}.id is duplicated`);
      ids.add(id);
      if (typeof service.name !== "string" || !service.name.trim()) errors.push(`${id}.name is required`);
      if (typeof service.purpose !== "string" || service.purpose.trim().length < 8) errors.push(`${id}.purpose is required`);
      if (!Array.isArray(service.platforms) || !service.platforms.length || service.platforms.some((item) => !PLATFORMS.has(item))) {
        errors.push(`${id}.platforms is invalid`);
      }
      for (const section of REQUIRED_SECTIONS) {
        if (!service[section] || typeof service[section] !== "object" || Array.isArray(service[section])) {
          errors.push(`${id}.${section} is required`);
        } else if (!EVIDENCE_STATUSES.includes(service[section].evidenceStatus)) {
          errors.push(`${id}.${section}.evidenceStatus is invalid`);
        }
      }
      const admission = service.admission || {};
      for (const field of ["allowedActors", "allowedDataClasses", "supportedOperations", "consequentialOperations", "acceptedWorkflows"]) {
        if (!Array.isArray(admission[field])) errors.push(`${id}.admission.${field} must be an array`);
        else if (admission[field].some((value) => typeof value !== "string" || !value.trim())) {
          errors.push(`${id}.admission.${field} must contain only non-empty strings`);
        }
      }
      if (Array.isArray(admission.consequentialOperations) && Array.isArray(admission.supportedOperations) &&
          admission.consequentialOperations.some((operation) => !admission.supportedOperations.includes(operation))) {
        errors.push(`${id}.admission.consequentialOperations must be a subset of supportedOperations`);
      }
      if (!["metered_or_unknown", "local_unmetered"].includes(admission.externalMeter)) {
        errors.push(`${id}.admission.externalMeter is invalid`);
      }
      if (!admission.allowance || typeof admission.allowance !== "object" || Array.isArray(admission.allowance)) {
        errors.push(`${id}.admission.allowance is required`);
      }
      if (!ALLOWANCE_STATUSES.has(admission.allowance?.status)) errors.push(`${id}.admission.allowance.status is invalid`);
      if (typeof admission.allowance?.poolId !== "string" || !/^[a-z][a-z0-9_.-]+$/.test(admission.allowance.poolId)) {
        errors.push(`${id}.admission.allowance.poolId is invalid`);
      }
      if (!EVIDENCE_STATUSES.includes(admission.verificationEvidenceStatus)) {
        errors.push(`${id}.admission.verificationEvidenceStatus is invalid`);
      }
      if (!admission.operationRequirements || typeof admission.operationRequirements !== "object" || Array.isArray(admission.operationRequirements)) {
        errors.push(`${id}.admission.operationRequirements is required`);
      } else if (Array.isArray(admission.supportedOperations)) {
        for (const operation of Object.keys(admission.operationRequirements)) {
          if (!admission.supportedOperations.includes(operation)) {
            errors.push(`${id}.admission.operationRequirements.${operation} is not a supported operation`);
          }
        }
        for (const operation of admission.supportedOperations) {
          if (!Object.hasOwn(admission.operationRequirements, operation)) {
            errors.push(`${id}.admission.operationRequirements.${operation} is required (use null until verified)`);
            continue;
          }
          const bundle = admission.operationRequirements[operation];
          if (bundle === null) continue;
          if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
              !Array.isArray(bundle.action) || !Array.isArray(bundle.verification)) {
            errors.push(`${id}.admission.operationRequirements.${operation} must be null or an action/verification bundle`);
            continue;
          }
          const entries = [...bundle.action, ...bundle.verification];
          if (entries.some((entry) => !entry || typeof entry !== "object" ||
              entry.pool !== admission.allowance?.poolId || !Number.isSafeInteger(entry.units) || entry.units <= 0)) {
            errors.push(`${id}.admission.operationRequirements.${operation} has an invalid pool or unit count`);
          }
          if (admission.externalMeter === "metered_or_unknown" && entries.length === 0) {
            errors.push(`${id}.admission.operationRequirements.${operation} cannot be empty for an externally metered operation`);
          }
        }
      }
      if (admission.externalMeter === "local_unmetered" && admission.allowance?.status !== "not_metered") {
        errors.push(`${id}.admission local_unmetered services require not_metered allowance status`);
      }
      if (admission.externalMeter === "metered_or_unknown" && admission.allowance?.status === "not_metered") {
        errors.push(`${id}.admission metered_or_unknown services cannot use not_metered allowance status`);
      }
      if (admission.allowance?.remaining !== null && (!Number.isSafeInteger(admission.allowance?.remaining) || admission.allowance.remaining < 0)) {
        errors.push(`${id}.admission.allowance.remaining must be null or a non-negative integer`);
      }
      if (admission.allowance?.status === "unknown" && admission.allowance?.remaining !== null) {
        errors.push(`${id}.admission.allowance cannot claim remaining capacity while status is unknown`);
      }
      if (admission.allowance?.status === "verified_available" && !Number.isSafeInteger(admission.allowance?.remaining)) {
        errors.push(`${id}.admission.allowance verified availability requires an integer remaining value`);
      }
      if (Array.isArray(admission.acceptedWorkflows) && admission.acceptedWorkflows.length > 0 &&
          admission.evidenceStatus !== "accepted_for_workflow") {
        errors.push(`${id}.admission accepted workflows require accepted_for_workflow evidence`);
      }
      const privatePlanFields = [
        "actualPlan", "actualTier", "remainingCredit", "remainingMinutes", "remainingRequests",
        "remainingTokens", "messagesRemaining", "tracesRemaining", "availableCredit", "resetAt",
        "hardStopConfigured", "paymentMethodPresent", "overageEnabled", "billingLinked",
        "additionalMessagesEnabled", "monthlyMessageLimit",
      ];
      if (privatePlanFields.some((field) => service.planBilling?.[field] !== undefined && service.planBilling[field] !== null) &&
          !ACCOUNT_EVIDENCE_STATUSES.has(service.planBilling.evidenceStatus)) {
        errors.push(`${id}.planBilling account values require account_verified_setting evidence or stronger`);
      }
      if (service.capacity?.accountVerifiedLimits !== undefined && service.capacity.accountVerifiedLimits !== null &&
          !ACCOUNT_EVIDENCE_STATUSES.has(service.capacity.evidenceStatus)) {
        errors.push(`${id}.capacity account limits require account_verified_setting evidence or stronger`);
      }
      validateEvidence(service.evidence, id, errors);
    }
    for (const dependency of MATERIAL_DEPENDENCIES) {
      if (!ids.has(dependency)) errors.push(`material dependency ${dependency} has no passport`);
    }
  }
  errors.push(...scanForSecrets(register));
  for (const service of register.services || []) {
    if (service.admission?.allowance?.status === "unknown") warnings.push(`${service.id}: account allowance is unresolved`);
    if (service.ownership?.accountOwner === null) warnings.push(`${service.id}: account owner requires personal verification`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function loadPassportRegister(filePath = PASSPORT_PATH) {
  const register = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const validation = validatePassportRegister(register);
  if (!validation.valid) {
    const error = new Error(`Software Passport register is invalid: ${validation.errors.join("; ")}`);
    error.code = "INVALID_SOFTWARE_PASSPORTS";
    error.validation = validation;
    throw error;
  }
  return register;
}

module.exports = {
  ALLOWANCE_STATUSES,
  EVIDENCE_STATUSES,
  MATERIAL_DEPENDENCIES,
  PASSPORT_PATH,
  loadPassportRegister,
  scanForSecrets,
  validatePassportRegister,
};
