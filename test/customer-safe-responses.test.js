"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  C06_DATABASE_DEGRADED_ID,
  C06_DATABASE_DEGRADED_NO_SIDE_EFFECT_ID,
  CUSTOMER_SAFE_RESPONSES_PATH,
  EXPECTED_FAILURE_CODES,
  getCustomerSafeResponse,
  loadCustomerSafeResponses,
  validateCustomerSafeResponses,
} = require("../src/lib/customer-safe-responses");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("C06 customer safe response is versioned, digest-pinned, approval-pending, and loaded by the application", () => {
  const manifest = loadCustomerSafeResponses();
  const validation = validateCustomerSafeResponses(manifest);
  const response = getCustomerSafeResponse(C06_DATABASE_DEGRADED_ID, manifest);
  const noSideEffectResponse = getCustomerSafeResponse(C06_DATABASE_DEGRADED_NO_SIDE_EFFECT_ID, manifest);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(response.controlId, "C06");
  assert.equal(response.responseVersion, "1.0.0");
  assert.deepEqual(response.failureCodes, EXPECTED_FAILURE_CODES);
  assert.equal(response.approval.status, "pending");
  assert.equal(response.approval.approvedBy, null);
  assert.equal(response.approval.approvedAt, null);
  assert.equal(response.approval.approvedCommit, null);
  assert.equal(response.releaseEligible, false);
  assert.equal(noSideEffectResponse.approval.status, "pending");
  assert.equal(noSideEffectResponse.approval.approvedBy, null);
  assert.equal(noSideEffectResponse.approval.approvedAt, null);
  assert.equal(noSideEffectResponse.approval.approvedCommit, null);
  assert.equal(noSideEffectResponse.releaseEligible, false);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(response), true);

  const serverSource = readFileSync(path.resolve(__dirname, "../src/server.js"), "utf8");
  for (const configuredResponse of manifest.responses) {
    assert.equal(serverSource.includes(configuredResponse.message), false, "the runtime must not duplicate customer text in code");
  }
  assert.match(serverSource, /getCustomerSafeResponse\(C06_DATABASE_DEGRADED_ID/);
});

test("message, digest, or response-version drift fails validation", () => {
  const original = loadCustomerSafeResponses();

  const changedMessage = clone(original);
  changedMessage.responses[0].message += " Changed.";
  assert.match(validateCustomerSafeResponses(changedMessage).errors.join("\n"), /messageSha256/);

  const changedMessageAndDigest = clone(original);
  changedMessageAndDigest.responses[0].message = "A different static customer response that remains deliberately unapproved.";
  changedMessageAndDigest.responses[0].messageSha256 = require("../src/lib/customer-safe-responses")
    .sha256(changedMessageAndDigest.responses[0].message);
  assert.match(validateCustomerSafeResponses(changedMessageAndDigest).errors.join("\n"), /code-pinned response version/);

  const changedVersion = clone(original);
  changedVersion.responses[0].responseVersion = "1.0.1";
  assert.match(validateCustomerSafeResponses(changedVersion).errors.join("\n"), /not independently pinned/);
});

test("approval cannot be inferred from populated metadata or release eligibility", () => {
  const original = loadCustomerSafeResponses();

  const inventedApproval = clone(original);
  Object.assign(inventedApproval.responses[0].approval, {
    status: "approved",
    approvedBy: "founder",
    approvedAt: "2026-09-18",
    approvedCommit: "0".repeat(40),
  });
  inventedApproval.responses[0].releaseEligible = true;
  const errors = validateCustomerSafeResponses(inventedApproval).errors.join("\n");
  assert.match(errors, /must remain pending/);
  assert.match(errors, /must be null/);
  assert.match(errors, /must be false/);
});

test("the checker reports valid structure while keeping release and founder approval false", () => {
  const script = require.resolve("../scripts/check-customer-safe-responses");
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.schemaValid, true);
  assert.equal(output.responseCount, 2);
  assert.equal(output.pendingApprovalCount, 2);
  assert.equal(output.releaseEligibleCount, 0);
  assert.equal(output.founderApprovalRecorded, false);
  assert.equal(readFileSync(CUSTOMER_SAFE_RESPONSES_PATH, "utf8").includes("@gmail.com"), false);
});
