"use strict";

const {
  CUSTOMER_SAFE_RESPONSES_PATH,
  loadCustomerSafeResponses,
  validateCustomerSafeResponses,
} = require("../src/lib/customer-safe-responses");

function checkCustomerSafeResponses({ filePath = CUSTOMER_SAFE_RESPONSES_PATH } = {}) {
  try {
    const manifest = loadCustomerSafeResponses(filePath);
    const validation = validateCustomerSafeResponses(manifest);
    const pendingApprovalCount = manifest.responses.filter((response) =>
      response.approval.status === "pending").length;
    const releaseEligibleCount = manifest.responses.filter((response) =>
      response.releaseEligible === true).length;
    return {
      ok: validation.valid,
      schemaValid: validation.valid,
      manifestVersion: manifest.manifestVersion,
      responseCount: manifest.responses.length,
      pendingApprovalCount,
      releaseEligibleCount,
      founderApprovalRecorded: manifest.responses.some((response) =>
        response.approval.status !== "pending" || response.approval.approvedBy !== null ||
        response.approval.approvedAt !== null || response.approval.approvedCommit !== null),
      errors: validation.errors,
    };
  } catch (error) {
    return {
      ok: false,
      schemaValid: false,
      manifestVersion: null,
      responseCount: 0,
      pendingApprovalCount: 0,
      releaseEligibleCount: 0,
      founderApprovalRecorded: false,
      errors: error.validation?.errors || ["Customer safe-response manifest could not be loaded."],
    };
  }
}

if (require.main === module) {
  const result = checkCustomerSafeResponses();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { checkCustomerSafeResponses };
