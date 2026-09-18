"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  EXPECTED_IDS,
  RELEASE_CONTROLS_PATH,
  checkReleaseControls,
  loadReleaseControls,
  validateReleaseControls,
} = require("../scripts/check-release-controls");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("current release-control pack is valid, incomplete, and release gated", () => {
  const register = loadReleaseControls();
  const validation = validateReleaseControls(register);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.gateSatisfied, false);
  assert.deepEqual(register.controls.map((control) => control.id), EXPECTED_IDS);
  assert.deepEqual(validation.summary, {
    pass: 4,
    partial: 8,
    missing: 0,
    incomplete: 8,
    partialOrMissing: 8,
  });
  assert.equal(register.releaseGate.releaseAccepted, false);
  assert.equal(register.controls.every((control) => control.releaseAccepted === false), true);
  assert.equal(readFileSync(RELEASE_CONTROLS_PATH, "utf8").includes("@gmail.com"), false);

  const strict = checkReleaseControls();
  assert.equal(strict.schemaValid, true);
  assert.equal(strict.ok, false);
  assert.equal(strict.releaseGate, "fail");
  assert.equal(strict.counts.partialOrMissing, 8);
  assert.deepEqual(strict.machineEvidence.verifiedControls, ["C01", "C02", "C03", "C04", "C11", "C12"]);
  assert.equal(strict.machineEvidence.verifiedControlCount, 6);
  assert.equal(strict.machineEvidence.unverifiedControlCount, 6);
  assert.equal(strict.machineEvidence.controls.C03.probes[0].passingTests, 24);
  assert.equal(strict.machineEvidence.controls.C03.probes[0].requiredPassingTests, 24);
  assert.equal(strict.machineEvidence.controls.C03.probes[0].expectedTestCount, 10);
  assert.equal(strict.machineEvidence.controls.C04.probes[0].passingTests, 24);
  assert.equal(strict.machineEvidence.controls.C04.probes[0].requiredPassingTests, 24);
  assert.equal(strict.machineEvidence.controls.C04.probes[0].expectedTestCount, 8);
  assert.equal(strict.machineEvidence.controls.C11.probes[0].passingTests, 6);
  assert.equal(strict.machineEvidence.controls.C11.probes[0].requiredPassingTests, 6);
  assert.equal(strict.machineEvidence.controls.C11.probes[0].expectedTestCount, 6);
  assert.equal(strict.machineEvidence.controls.C12.probes[0].passingTests, 9);
  assert.equal(strict.machineEvidence.controls.C12.probes[0].requiredPassingTests, 9);
  assert.equal(strict.machineEvidence.controls.C12.probes[0].expectedTestCount, 9);

  const audit = checkReleaseControls({ allowIncomplete: true });
  assert.equal(audit.schemaValid, true);
  assert.equal(audit.ok, true);
  assert.equal(audit.releaseGate, "fail", "allow-incomplete must not misrepresent release acceptance");
});

test("editing every status and acceptance field cannot bypass machine-bound release evidence", () => {
  const tampered = clone(loadReleaseControls());
  for (const control of tampered.controls) {
    control.status = "pass";
    control.releaseAccepted = true;
  }
  tampered.expectedSummary = {
    pass: 12,
    partial: 0,
    missing: 0,
    incomplete: 0,
    releaseAccepted: true,
  };
  tampered.releaseGate.releaseAccepted = true;

  const metadataOnly = validateReleaseControls(tampered);
  assert.equal(metadataOnly.valid, true, metadataOnly.errors.join("\n"));
  assert.equal(metadataOnly.gateSatisfied, true, "fixture must prove metadata alone would have passed the old gate");

  const directory = mkdtempSync(path.join(tmpdir(), "neurohands-release-gate-"));
  const filePath = path.join(directory, "tampered-release-controls.json");
  try {
    writeFileSync(filePath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const strict = checkReleaseControls({ filePath });
    assert.equal(strict.schemaValid, true);
    assert.equal(strict.releaseAccepted, true);
    assert.equal(strict.machineEvidence.gateSatisfied, false);
    assert.deepEqual(strict.machineEvidence.verifiedControls, ["C01", "C02", "C03", "C04", "C11", "C12"]);
    assert.equal(strict.machineEvidence.unverifiedControlCount, 6);
    assert.equal(strict.releaseGate, "fail");
    assert.equal(strict.ok, false);
    assert.match(strict.errors.join("\n"), /C05 is marked pass without a passing deterministic machine probe/);

    const audit = checkReleaseControls({ filePath, allowIncomplete: true });
    assert.equal(audit.schemaValid, true);
    assert.equal(audit.ok, false, "allow-incomplete cannot excuse an unsupported pass label");
    assert.match(audit.errors.join("\n"), /marked pass without a passing deterministic machine probe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid status, missing evidence path, and credential-like values are rejected", () => {
  const original = loadReleaseControls();

  const invalidStatus = clone(original);
  invalidStatus.controls[0].status = "probably_passes";
  assert.match(validateReleaseControls(invalidStatus).errors.join("\n"), /status is invalid/);

  const missingPath = clone(original);
  missingPath.controls[0].evidence[0].path = "test/does-not-exist.test.js";
  assert.match(validateReleaseControls(missingPath).errors.join("\n"), /path does not resolve/);

  const escapedPath = clone(original);
  escapedPath.controls[0].evidence[0].path = "../outside.txt";
  assert.match(validateReleaseControls(escapedPath).errors.join("\n"), /path does not resolve/);

  const leaked = clone(original);
  leaked.controls[0].apiKey = "sk-private-example-value-123456789";
  const errors = validateReleaseControls(leaked).errors.join("\n");
  assert.match(errors, /unexpected fields/);
  assert.match(errors, /secret scan/);
});

test("summary drift and premature release acceptance fail validation", () => {
  const original = loadReleaseControls();

  const drifted = clone(original);
  drifted.expectedSummary.pass = 12;
  assert.match(validateReleaseControls(drifted).errors.join("\n"), /expectedSummary\.pass/);

  const premature = clone(original);
  premature.releaseGate.releaseAccepted = true;
  premature.expectedSummary.releaseAccepted = true;
  assert.match(validateReleaseControls(premature).errors.join("\n"), /cannot be accepted/);
});

test("CLI fails normally and succeeds only for explicit incomplete-pack inspection", () => {
  const script = require.resolve("../scripts/check-release-controls");
  const strict = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(strict.status, 1);
  assert.equal(strict.stderr, "");
  const strictResult = JSON.parse(strict.stdout);
  assert.equal(strictResult.schemaValid, true);
  assert.equal(strictResult.releaseGate, "fail");
  assert.equal(strictResult.counts.pass, 4);
  assert.equal(strictResult.counts.partialOrMissing, 8);
  assert.deepEqual(strictResult.machineEvidence.verifiedControls, ["C01", "C02", "C03", "C04", "C11", "C12"]);
  assert.equal(strictResult.machineEvidence.gateSatisfied, false);

  const audit = spawnSync(process.execPath, [script, "--allow-incomplete"], { encoding: "utf8" });
  assert.equal(audit.status, 0);
  assert.equal(audit.stderr, "");
  const auditResult = JSON.parse(audit.stdout);
  assert.equal(auditResult.ok, true);
  assert.equal(auditResult.releaseGate, "fail");
  assert.equal(auditResult.releaseAccepted, false);

  const unknown = spawnSync(process.execPath, [script, "--invented"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(JSON.parse(unknown.stdout).errors[0], /Unknown arguments/);
});
