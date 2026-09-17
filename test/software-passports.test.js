"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
  MATERIAL_DEPENDENCIES,
  PASSPORT_PATH,
  loadPassportRegister,
  scanForSecrets,
  validatePassportRegister,
} = require("../src/lib/software-passports");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("versioned Software Passport register is structurally valid and covers every material dependency", () => {
  const register = loadPassportRegister();
  const result = validatePassportRegister(register);
  assert.equal(result.valid, true);
  assert.equal(register.schemaVersion, "1.0.0");
  assert.match(register.registerVersion, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.deepEqual(MATERIAL_DEPENDENCIES.filter((id) => !register.services.some((service) => service.id === id)), []);
  assert.equal(result.warnings.length > 0, true, "unresolved private settings must remain visible");
  assert.equal(readFileSync(PASSPORT_PATH, "utf8").includes("@gmail.com"), false);
});

test("personal, balance, reset, and billing fields stay null when account verification is missing", () => {
  const register = loadPassportRegister();
  for (const id of ["railway", "github", "line", "gemini", "langsmith", "codex", "openai_api", "openrouter_public_test"]) {
    const service = register.services.find((item) => item.id === id);
    assert.equal(service.ownership.accountOwner, null, id);
  }
  assert.equal(register.services.find((item) => item.id === "railway").planBilling.actualPlan, null);
  assert.equal(register.services.find((item) => item.id === "gemini").planBilling.actualTier, null);
  assert.equal(register.services.find((item) => item.id === "langsmith").planBilling.tracesRemaining, null);
  assert.equal(register.services.find((item) => item.id === "codex").planBilling.remainingUsage, null);
});

test("missing dependency, duplicate IDs, invalid status, and embedded credentials fail validation", () => {
  const original = loadPassportRegister();
  const missing = clone(original);
  missing.services = missing.services.filter((service) => service.id !== "line");
  assert.match(validatePassportRegister(missing).errors.join("\n"), /material dependency line/);

  const duplicate = clone(original);
  duplicate.services.push(clone(duplicate.services[0]));
  assert.match(validatePassportRegister(duplicate).errors.join("\n"), /duplicated/);

  const invalid = clone(original);
  invalid.services[0].capacity.evidenceStatus = "probably_true";
  assert.match(validatePassportRegister(invalid).errors.join("\n"), /evidenceStatus is invalid/);

  const leaked = clone(original);
  leaked.services[0].planBilling.apiKey = "sk-private-example-value-123456789";
  const errors = validatePassportRegister(leaked).errors.join("\n");
  assert.match(errors, /credential|secret/);
  assert.equal(scanForSecrets({ url: "https://example.com/upload?t=signed-private-token-value" }).length, 1);

  const guessedBalance = clone(original);
  guessedBalance.services.find((service) => service.id === "railway").planBilling.remainingCredit = 1;
  assert.match(validatePassportRegister(guessedBalance).errors.join("\n"), /account values require account_verified_setting/);

  const unknownCapacity = clone(original);
  unknownCapacity.services.find((service) => service.id === "line").admission.allowance.remaining = 100;
  assert.match(validatePassportRegister(unknownCapacity).errors.join("\n"), /cannot claim remaining capacity while status is unknown/);

  for (const field of ["consequentialOperations", "operationRequirements", "verificationEvidenceStatus"]) {
    const incomplete = clone(original);
    delete incomplete.services[0].admission[field];
    assert.match(validatePassportRegister(incomplete).errors.join("\n"), new RegExp(field));
  }
  const missingPool = clone(original);
  delete missingPool.services[0].admission.allowance.poolId;
  assert.match(validatePassportRegister(missingPool).errors.join("\n"), /poolId/);

  const inconsistentMeter = clone(original);
  inconsistentMeter.services.find((service) => service.id === "ollama").admission.allowance.status = "unknown";
  assert.match(validatePassportRegister(inconsistentMeter).errors.join("\n"), /local_unmetered.*not_metered/);

  const unverifiedRequirements = clone(original);
  delete unverifiedRequirements.services.find((service) => service.id === "ollama")
    .admission.operationRequirements.run_local_synthetic_model;
  assert.match(validatePassportRegister(unverifiedRequirements).errors.join("\n"), /operationRequirements\.run_local_synthetic_model/);

  const unsupportedConsequence = clone(original);
  unsupportedConsequence.services[0].admission.consequentialOperations.push("invented_operation");
  assert.match(validatePassportRegister(unsupportedConsequence).errors.join("\n"), /subset of supportedOperations/);
});

test("secret scanning covers provider keys, JWTs, and URL credentials", () => {
  const examples = [
    "AIza12345678901234567890123456789012345",
    "gsk_123456789012345678901234567890",
    "ghp_123456789012345678901234567890123456",
    "github_pat_123456789012345678901234567890",
    "eyJ1234567890.abcdefghijklmno.zyxwvutsrqpon",
    "https://private-user:private-password@example.com/path",
  ];
  for (const [index, value] of examples.entries()) {
    assert.ok(scanForSecrets({ value }).length > 0, `secret example ${index} must be rejected`);
  }
});

test("not_applicable is not treated as stronger account evidence", () => {
  const register = loadPassportRegister();
  const railway = register.services.find((service) => service.id === "railway");
  railway.planBilling.actualPlan = "Unverified example";
  railway.planBilling.evidenceStatus = "not_applicable";
  assert.match(validatePassportRegister(register).errors.join("\n"), /account values require account_verified_setting/);
});

test("all evidence is dated and uses a validated HTTPS URL or safe repository path", () => {
  const register = loadPassportRegister();
  for (const service of register.services) {
    for (const item of service.evidence) {
      assert.match(item.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
      if (item.source.type === "url") assert.match(item.source.value, /^https:\/\//);
      else {
        assert.equal(item.source.type, "repository");
        assert.equal(item.source.value.includes(".."), false);
      }
    }
  }
});
