"use strict";

const { loadPassportRegister, PASSPORT_PATH, validatePassportRegister } = require("../src/lib/software-passports");

function checkSoftwarePassports() {
  let register;
  try {
    register = loadPassportRegister(PASSPORT_PATH);
  } catch (error) {
    return {
      schemaValid: false,
      coverageComplete: false,
      coverageStatus: "invalid",
      workflowAccepted: false,
      errors: error.validation?.errors || ["Software Passport register could not be loaded."],
      warnings: error.validation?.warnings || [],
    };
  }
  const validation = validatePassportRegister(register);
  const accepted = register.services.filter((service) => service.admission.acceptedWorkflows.length > 0);
  return {
    schemaValid: validation.valid,
    coverageComplete: false,
    coverageStatus: "partial",
    workflowAccepted: accepted.length > 0,
    registerVersion: register.registerVersion,
    serviceCount: register.services.length,
    acceptedServiceCount: accepted.length,
    unresolvedAllowanceCount: register.services.filter((service) => service.admission.allowance.status === "unknown").length,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

if (require.main === module) {
  const result = checkSoftwarePassports();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.schemaValid ? 0 : 1;
}

module.exports = { checkSoftwarePassports };
