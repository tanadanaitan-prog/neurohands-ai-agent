"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DATABASE_FAILURES } = require("./database-failures");

const CUSTOMER_SAFE_RESPONSES_PATH = path.resolve(__dirname, "../../config/customer-safe-responses.v1.json");
const C06_DATABASE_DEGRADED_ID = "c06_database_degraded";
const C06_DATABASE_DEGRADED_NO_SIDE_EFFECT_ID = "c06_database_degraded_no_side_effect";
const RESPONSE_FIELDS = Object.freeze([
  "id", "controlId", "responseVersion", "locale", "failureCodes", "message",
  "messageSha256", "approval", "releaseEligible",
]);
const APPROVAL_FIELDS = Object.freeze(["status", "approvedBy", "approvedAt", "approvedCommit"]);
const EXPECTED_FAILURE_CODES = Object.freeze(Object.values(DATABASE_FAILURES));

// This independent pin makes a customer-text change require an explicit code
// review as well as a manifest edit. A future text revision must use a new
// responseVersion and add its digest here; it cannot silently replace v1.0.0.
const KNOWN_RESPONSE_VERSIONS = Object.freeze({
  [C06_DATABASE_DEGRADED_ID]: Object.freeze({
    controlId: "C06",
    versions: Object.freeze({
      "1.0.0": "ec6181b60778bddb7ff3deba111d802cc4957661380011ae6f514747a328f469",
    }),
  }),
  [C06_DATABASE_DEGRADED_NO_SIDE_EFFECT_ID]: Object.freeze({
    controlId: "C06",
    versions: Object.freeze({
      "1.0.0": "b247e4f59597302f5ef5e9605546483e824e6ca4a7e94b6bea8c58d7d3880b74",
    }),
  }),
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sameValues(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function unexpectedFields(value, allowed) {
  return plainObject(value) ? Object.keys(value).filter((key) => !allowed.includes(key)) : [];
}

function validateCustomerSafeResponses(manifest) {
  const errors = [];
  if (!plainObject(manifest)) {
    return { valid: false, errors: ["customer safe-response manifest must be an object"] };
  }
  const manifestFields = ["schemaVersion", "manifestVersion", "reviewedOn", "scope", "responses"];
  const unexpectedManifestFields = unexpectedFields(manifest, manifestFields);
  if (unexpectedManifestFields.length) errors.push(`manifest has unexpected fields: ${unexpectedManifestFields.join(", ")}`);
  if (manifest.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(manifest.manifestVersion || "")) {
    errors.push("manifestVersion must use YYYY-MM-DD.N");
  }
  if (!isDate(manifest.reviewedOn)) errors.push("reviewedOn must be YYYY-MM-DD");
  if (manifest.scope !== "customer_safe_responses") errors.push("scope must be customer_safe_responses");
  if (!Array.isArray(manifest.responses)) {
    errors.push("responses must be an array");
    return { valid: false, errors };
  }

  const seen = new Set();
  for (const [index, response] of manifest.responses.entries()) {
    const prefix = `responses[${index}]`;
    if (!plainObject(response)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const unexpectedResponseFields = unexpectedFields(response, RESPONSE_FIELDS);
    if (unexpectedResponseFields.length) {
      errors.push(`${prefix} has unexpected fields: ${unexpectedResponseFields.join(", ")}`);
    }
    if (!Object.hasOwn(KNOWN_RESPONSE_VERSIONS, response.id)) errors.push(`${prefix}.id is not a known response`);
    else if (seen.has(response.id)) errors.push(`${prefix}.id is duplicated`);
    else seen.add(response.id);

    const known = KNOWN_RESPONSE_VERSIONS[response.id];
    if (known && response.controlId !== known.controlId) errors.push(`${prefix}.controlId is invalid`);
    if (typeof response.responseVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(response.responseVersion)) {
      errors.push(`${prefix}.responseVersion must use semantic versioning`);
    }
    if (response.locale !== "en") errors.push(`${prefix}.locale must be en`);
    if (!sameValues(response.failureCodes, EXPECTED_FAILURE_CODES)) {
      errors.push(`${prefix}.failureCodes must contain the fixed database failure codes in canonical order`);
    }
    if (typeof response.message !== "string" || response.message !== response.message.trim() ||
        response.message.length < 20 || response.message.length > 1000 || /\r|\n/.test(response.message)) {
      errors.push(`${prefix}.message must be a single trimmed customer-safe line between 20 and 1000 characters`);
    }
    if (/\$\{|\{\{|%s/i.test(response.message || "")) {
      errors.push(`${prefix}.message must be static and cannot contain interpolation placeholders`);
    }
    const actualDigest = typeof response.message === "string" ? sha256(response.message) : null;
    if (!/^[a-f0-9]{64}$/.test(response.messageSha256 || "") || response.messageSha256 !== actualDigest) {
      errors.push(`${prefix}.messageSha256 does not match the exact UTF-8 message`);
    }
    const pinnedDigest = known?.versions?.[response.responseVersion];
    if (!pinnedDigest) errors.push(`${prefix}.responseVersion is not independently pinned in application code`);
    else if (response.messageSha256 !== pinnedDigest) {
      errors.push(`${prefix} text does not match the code-pinned response version`);
    }

    if (!plainObject(response.approval)) errors.push(`${prefix}.approval is required`);
    else {
      const unexpectedApprovalFields = unexpectedFields(response.approval, APPROVAL_FIELDS);
      if (unexpectedApprovalFields.length) {
        errors.push(`${prefix}.approval has unexpected fields: ${unexpectedApprovalFields.join(", ")}`);
      }
      if (response.approval.status !== "pending") {
        errors.push(`${prefix}.approval.status must remain pending until a separately verified founder decision is implemented`);
      }
      for (const field of ["approvedBy", "approvedAt", "approvedCommit"]) {
        if (response.approval[field] !== null) errors.push(`${prefix}.approval.${field} must be null while approval is pending`);
      }
    }
    if (response.releaseEligible !== false) {
      errors.push(`${prefix}.releaseEligible must be false while founder approval is pending`);
    }
  }

  for (const id of Object.keys(KNOWN_RESPONSE_VERSIONS)) {
    if (!seen.has(id)) errors.push(`${id} is missing`);
  }
  if (manifest.responses.length !== Object.keys(KNOWN_RESPONSE_VERSIONS).length) {
    errors.push(`responses must contain exactly ${Object.keys(KNOWN_RESPONSE_VERSIONS).length} entry`);
  }
  return { valid: errors.length === 0, errors };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function loadCustomerSafeResponses(filePath = CUSTOMER_SAFE_RESPONSES_PATH) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    const error = new Error("Customer safe-response manifest could not be loaded");
    error.code = "INVALID_CUSTOMER_SAFE_RESPONSES";
    throw error;
  }
  const validation = validateCustomerSafeResponses(manifest);
  if (!validation.valid) {
    const error = new Error(`Customer safe-response manifest is invalid: ${validation.errors.join("; ")}`);
    error.code = "INVALID_CUSTOMER_SAFE_RESPONSES";
    error.validation = validation;
    throw error;
  }
  return deepFreeze(manifest);
}

function getCustomerSafeResponse(id, manifest = loadCustomerSafeResponses()) {
  const response = manifest.responses.find((item) => item.id === id);
  if (!response) {
    const error = new Error("Configured customer safe response is missing");
    error.code = "INVALID_CUSTOMER_SAFE_RESPONSES";
    throw error;
  }
  return response;
}

module.exports = {
  C06_DATABASE_DEGRADED_ID,
  C06_DATABASE_DEGRADED_NO_SIDE_EFFECT_ID,
  CUSTOMER_SAFE_RESPONSES_PATH,
  EXPECTED_FAILURE_CODES,
  KNOWN_RESPONSE_VERSIONS,
  getCustomerSafeResponse,
  loadCustomerSafeResponses,
  sha256,
  validateCustomerSafeResponses,
};
