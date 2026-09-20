"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { scanForSecrets } = require("../src/lib/software-passports");

const ROOT = path.resolve(__dirname, "..");
const RELEASE_CONTROLS_PATH = path.join(ROOT, "config", "release-controls.v1.json");
const EXPECTED_IDS = Object.freeze(Array.from({ length: 12 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`));
const STATUSES = new Set(["pass", "partial", "missing"]);
const CONTROL_FIELDS = Object.freeze([
  "id", "name", "status", "releaseAccepted", "evidence", "passCriteria",
  "remainingGap", "manualOrLiveRequirements",
]);

// These probes are code-owned release evidence. The release register may describe
// a control, but editing its status can never create the executable evidence that
// this table requires. Add a control here only after its exact local test exists.
const MACHINE_PROBES = Object.freeze({
  C01: Object.freeze([
    Object.freeze({
      id: "C01-TEST-UNKNOWN-ALLOWANCE",
      kind: "node-test",
      files: Object.freeze([
        "test/admission-control.test.js",
        "test/langsmith-admission.test.js",
      ]),
      minimumPassingTests: 21,
      expectedTestNames: Object.freeze([
        "unknown allowance blocks a new billable experiment and explicitly degrades frontline",
        "explicit LangSmith trace stops before upload while private allowance is unresolved",
      ]),
    }),
    Object.freeze({
      id: "C01-CHECK-PRIVATE-ALLOWANCE-UNRESOLVED",
      kind: "json-script",
      file: "scripts/check-software-passports.js",
      assertions: Object.freeze([
        Object.freeze({ field: "schemaValid", equals: true }),
        Object.freeze({ field: "workflowAccepted", equals: false }),
        Object.freeze({ field: "unresolvedAllowanceCount", minimum: 1 }),
      ]),
    }),
  ]),
  C02: Object.freeze([
    Object.freeze({
      id: "C02-TEST-ATOMIC-CAPACITY",
      kind: "node-test",
      files: Object.freeze(["test/durable-allowance-admission.test.js"]),
      minimumPassingTests: 12,
      expectedTestNames: Object.freeze([
        "concurrent callers cannot both spend the final action-plus-verification budget",
        "an audit write failure rolls back the pool debit and reservation",
      ]),
    }),
  ]),
  C03: Object.freeze([
    Object.freeze({
      id: "C03-TEST-ALLOWANCE-CONTINUITY",
      kind: "node-test",
      files: Object.freeze([
        "test/allowance-continuity.test.js",
        "test/allowance-continuity-postgres.test.js",
      ]),
      minimumPassingTests: 24,
      expectedTestNames: Object.freeze([
        "C03: successful accepted work sends one idempotent threshold alert with required evidence",
        "C03: failed founder delivery is recorded once without a delivery claim or retry loop",
        "C03: an alert failure does not undo the already settled customer action",
        "C03: a stalled founder notifier never delays the settled customer result",
        "C03: a late notifier completion remains uncertain and is never retried",
        "C03: concurrent threshold completions share one durable alert claim",
        "C03: an unconfirmed receipt and a lost completion record never become false delivery claims",
        "C03: threshold alert waits for verified settlement",
        "concurrent claims create one durable alert and later claims are replays",
        "uncertain, failed and delivered outcomes are explicit terminal states",
      ]),
    }),
  ]),
  C04: Object.freeze([
    Object.freeze({
      id: "C04-TEST-ALLOWANCE-CONTINUITY",
      kind: "node-test",
      files: Object.freeze([
        "test/allowance-continuity.test.js",
        "test/allowance-continuity-postgres.test.js",
      ]),
      minimumPassingTests: 24,
      expectedTestNames: Object.freeze([
        "C04: optional exhausted work stops before transport without fallback or provider change",
        "C04: exhausted Frontline records a static response, alerts once and never dispatches",
        "C04: storage failure still denies transport and cannot invent an alert delivery",
        "C04: a stalled continuity store returns the approved static response within its deadline",
        "alert wording rejects unverified hard-limit facts",
        "hard-limit continuity evidence is durable, idempotent and conflict detecting",
        "browser roles cannot read or invoke continuity storage",
        "service role cannot forge a delivered receipt through direct table writes",
      ]),
    }),
  ]),
  C11: Object.freeze([
    Object.freeze({
      id: "C11-TEST-PROVIDER-COMPATIBILITY",
      kind: "node-test",
      files: Object.freeze(["test/provider-contracts.test.js"]),
      minimumPassingTests: 6,
      expectedTestNames: Object.freeze([
        "the pinned provider and SDK compatibility pack passes offline",
        "the production request encoders produce the registered Gemini and OpenAI-compatible contracts",
        "an intentional provider API contract change exits nonzero and names the blocked interface",
        "a removed installed SDK method blocks compatibility before dispatch",
        "declared or locked SDK version drift blocks compatibility",
        "the CLI emits one safe result and makes no production call",
      ]),
    }),
    Object.freeze({
      id: "C11-CHECK-INSTALLED-CONTRACTS",
      kind: "json-script",
      file: "scripts/check-provider-contracts.js",
      assertions: Object.freeze([
        Object.freeze({ field: "schemaValid", equals: true }),
        Object.freeze({ field: "compatibilityValid", equals: true }),
        Object.freeze({ field: "checkedRequestCount", equals: 2 }),
        Object.freeze({ field: "productionCalls", equals: 0 }),
      ]),
    }),
  ]),
  C12: Object.freeze([
    Object.freeze({
      id: "C12-TEST-ISOLATED-BACKUP-RESTORE",
      kind: "node-test",
      files: Object.freeze(["test/isolated-backup-restore.test.js"]),
      minimumPassingTests: 9,
      expectedTestNames: Object.freeze([
        "C12 restores scoped records, audit evidence and original private objects into clean isolated destinations",
        "a shared LINE actor cannot carry another client's structured audit evidence into the backup",
        "an object path outside the exact client-code prefix is rejected before object access",
        "exact rows and objects restore, permissions hold, and the authorized app answer comes from the original",
        "a missing source object fails visibly before a backup can be claimed",
        "a tampered backup fails validation before either destination is touched",
        "a destination that alters object bytes fails before database restoration",
        "a post-restore record mismatch cleans both destinations and permits a retry",
        "a post-restore object mismatch cleans both destinations and permits a retry",
      ]),
    }),
  ]),
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function probeEnvironment() {
  const names = [
    "PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
    "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "HOME",
  ];
  const env = { NODE_ENV: "test", CI: "1" };
  for (const name of names) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return env;
}

function runProbeProcess(args, rootDir) {
  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: probeEnvironment(),
    timeout: 120_000,
    windowsHide: true,
  });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    processError: result.error?.code || null,
  };
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tapTestPassed(stdout, name) {
  const escaped = escapedRegExp(name);
  const declared = new RegExp(`^\\s*# Subtest: ${escaped}\\s*$`, "m").test(stdout);
  const passed = new RegExp(`^\\s*ok \\d+ - ${escaped}\\s*$`, "m").test(stdout);
  return declared && passed;
}

function runNodeTestProbe(probe, rootDir) {
  const missingFiles = probe.files.filter((file) => !safeLocalFile(file, rootDir));
  if (missingFiles.length) {
    return { id: probe.id, passed: false, exitCode: null, reason: "Bound test file is missing." };
  }
  const execution = runProbeProcess([
    "--test",
    "--test-reporter=tap",
    ...probe.files,
  ], rootDir);
  const passMatch = execution.stdout.match(/^# pass (\d+)\s*$/m);
  const failMatch = execution.stdout.match(/^# fail (\d+)\s*$/m);
  const passingTests = passMatch ? Number(passMatch[1]) : 0;
  const failingTests = failMatch ? Number(failMatch[1]) : null;
  const missingTestNames = probe.expectedTestNames.filter((name) =>
    !tapTestPassed(execution.stdout, name));
  const passed = execution.exitCode === 0 && execution.processError === null &&
    passingTests >= probe.minimumPassingTests && failingTests === 0 && missingTestNames.length === 0;
  let reason = null;
  if (!passed) {
    if (execution.processError) reason = `Probe process failed (${execution.processError}).`;
    else if (execution.exitCode !== 0) reason = `Bound tests exited ${execution.exitCode}.`;
    else if (missingTestNames.length) reason = "One or more bound test names did not execute.";
    else reason = "Bound test summary did not meet the required passing count.";
  }
  return {
    id: probe.id,
    passed,
    exitCode: execution.exitCode,
    passingTests,
    requiredPassingTests: probe.minimumPassingTests,
    expectedTestCount: probe.expectedTestNames.length,
    reason,
  };
}

function runJsonScriptProbe(probe, rootDir) {
  if (!safeLocalFile(probe.file, rootDir)) {
    return { id: probe.id, passed: false, exitCode: null, reason: "Bound checker file is missing." };
  }
  const execution = runProbeProcess([probe.file], rootDir);
  let output = null;
  try {
    const lines = execution.stdout.split(/\r?\n/).filter((line) => line.trim());
    output = JSON.parse(lines.at(-1) || "");
  } catch {
    output = null;
  }
  const failedAssertions = [];
  for (const assertion of probe.assertions) {
    const value = output?.[assertion.field];
    if (Object.hasOwn(assertion, "equals") && value !== assertion.equals) {
      failedAssertions.push(assertion.field);
    }
    if (Object.hasOwn(assertion, "minimum") &&
        (typeof value !== "number" || value < assertion.minimum)) {
      failedAssertions.push(assertion.field);
    }
  }
  const passed = execution.exitCode === 0 && execution.processError === null &&
    plainObject(output) && failedAssertions.length === 0;
  let reason = null;
  if (!passed) {
    if (execution.processError) reason = `Probe process failed (${execution.processError}).`;
    else if (execution.exitCode !== 0) reason = `Bound checker exited ${execution.exitCode}.`;
    else if (!plainObject(output)) reason = "Bound checker did not return JSON.";
    else reason = "Bound checker assertions failed.";
  }
  return {
    id: probe.id,
    passed,
    exitCode: execution.exitCode,
    assertionCount: probe.assertions.length,
    failedAssertionCount: failedAssertions.length,
    reason,
  };
}

function evaluateMachineControls({ rootDir = ROOT } = {}) {
  const controls = {};
  for (const id of EXPECTED_IDS) {
    const probes = MACHINE_PROBES[id] || [];
    const results = probes.map((probe) => probe.kind === "node-test"
      ? runNodeTestProbe(probe, rootDir)
      : runJsonScriptProbe(probe, rootDir));
    controls[id] = {
      verified: results.length > 0 && results.every((result) => result.passed),
      probeCount: results.length,
      probes: results,
      reason: results.length ? null : "No deterministic machine probe is bound to this control.",
    };
  }
  const verifiedControls = EXPECTED_IDS.filter((id) => controls[id].verified);
  const unverifiedControls = EXPECTED_IDS.filter((id) => !controls[id].verified);
  return {
    gateSatisfied: unverifiedControls.length === 0,
    verifiedControlCount: verifiedControls.length,
    unverifiedControlCount: unverifiedControls.length,
    verifiedControls,
    unverifiedControls,
    controls,
  };
}

function safeLocalFile(relativePath, rootDir) {
  if (!nonempty(relativePath) || path.isAbsolute(relativePath) || relativePath.includes("\\")) return null;
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const resolved = path.resolve(rootDir, ...segments);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(resolved)) return null;
  try {
    const realRoot = fs.realpathSync(rootDir);
    const realTarget = fs.realpathSync(resolved);
    const realRelative = path.relative(realRoot, realTarget);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative) || !fs.statSync(realTarget).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function countStatuses(controls = []) {
  const summary = { pass: 0, partial: 0, missing: 0 };
  for (const control of controls) {
    if (STATUSES.has(control?.status)) summary[control.status] += 1;
  }
  return {
    ...summary,
    incomplete: summary.partial + summary.missing,
    partialOrMissing: summary.partial + summary.missing,
  };
}

function validateEvidence(control, prefix, errors, rootDir) {
  if (!Array.isArray(control.evidence) || control.evidence.length === 0) {
    errors.push(`${prefix}.evidence must contain at least one local evidence item`);
    return;
  }
  control.evidence.forEach((item, index) => {
    const evidencePrefix = `${prefix}.evidence[${index}]`;
    if (!plainObject(item)) {
      errors.push(`${evidencePrefix} must be an object`);
      return;
    }
    if (!nonempty(item.path)) errors.push(`${evidencePrefix}.path is required`);
    else if (!safeLocalFile(item.path, rootDir)) errors.push(`${evidencePrefix}.path does not resolve to an existing repository file`);
    if (!nonempty(item.locator)) errors.push(`${evidencePrefix}.locator is required`);
    if (!nonempty(item.claim)) errors.push(`${evidencePrefix}.claim is required`);
    const unexpected = Object.keys(item).filter((key) => !["path", "locator", "claim"].includes(key));
    if (unexpected.length) errors.push(`${evidencePrefix} has unexpected fields: ${unexpected.join(", ")}`);
  });
}

function validateCriteria(control, prefix, errors) {
  if (!Array.isArray(control.passCriteria) || control.passCriteria.length === 0) {
    errors.push(`${prefix}.passCriteria must contain at least one deterministic criterion`);
    return;
  }
  const ids = new Set();
  control.passCriteria.forEach((criterion, index) => {
    const criterionPrefix = `${prefix}.passCriteria[${index}]`;
    if (!plainObject(criterion)) {
      errors.push(`${criterionPrefix} must be an object`);
      return;
    }
    if (!nonempty(criterion.id) || !new RegExp(`^${control.id}-PC[1-9][0-9]*$`).test(criterion.id)) {
      errors.push(`${criterionPrefix}.id must be scoped to ${control.id}`);
    } else if (ids.has(criterion.id)) errors.push(`${criterionPrefix}.id is duplicated`);
    else ids.add(criterion.id);
    for (const field of ["given", "when", "then"]) {
      if (!nonempty(criterion[field])) errors.push(`${criterionPrefix}.${field} is required`);
    }
    const unexpected = Object.keys(criterion).filter((key) => !["id", "given", "when", "then"].includes(key));
    if (unexpected.length) errors.push(`${criterionPrefix} has unexpected fields: ${unexpected.join(", ")}`);
  });
}

function validateReleaseControls(register, { rootDir = ROOT } = {}) {
  const errors = [];
  if (!plainObject(register)) {
    return {
      valid: false,
      errors: ["release-control register must be an object"],
      summary: { pass: 0, partial: 0, missing: 0, incomplete: 0, partialOrMissing: 0 },
      gateSatisfied: false,
    };
  }
  if (register.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(register.registerVersion || "")) {
    errors.push("registerVersion must use YYYY-MM-DD.N");
  }
  if (!isDate(register.reviewedOn)) errors.push("reviewedOn must be YYYY-MM-DD");
  if (register.scope !== "local_release_control_evidence") errors.push("scope must be local_release_control_evidence");
  if (!plainObject(register.releaseGate)) errors.push("releaseGate is required");
  else {
    if (typeof register.releaseGate.releaseAccepted !== "boolean") errors.push("releaseGate.releaseAccepted must be boolean");
    if (!nonempty(register.releaseGate.reason)) errors.push("releaseGate.reason is required");
  }
  if (!Array.isArray(register.controls)) errors.push("controls must be an array");
  const controls = Array.isArray(register.controls) ? register.controls : [];
  const ids = new Set();
  controls.forEach((control, index) => {
    const prefix = `controls[${index}]`;
    if (!plainObject(control)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const unexpected = Object.keys(control).filter((key) => !CONTROL_FIELDS.includes(key));
    if (unexpected.length) errors.push(`${prefix} has unexpected fields: ${unexpected.join(", ")}`);
    if (!EXPECTED_IDS.includes(control.id)) errors.push(`${prefix}.id is invalid`);
    else if (ids.has(control.id)) errors.push(`${prefix}.id is duplicated`);
    else ids.add(control.id);
    if (!nonempty(control.name)) errors.push(`${prefix}.name is required`);
    if (!STATUSES.has(control.status)) errors.push(`${prefix}.status is invalid`);
    if (typeof control.releaseAccepted !== "boolean") errors.push(`${prefix}.releaseAccepted must be boolean`);
    if (control.releaseAccepted === true && control.status !== "pass") {
      errors.push(`${prefix} cannot be release accepted unless status is pass`);
    }
    validateEvidence(control, prefix, errors, rootDir);
    validateCriteria(control, prefix, errors);
    if (!nonempty(control.remainingGap)) errors.push(`${prefix}.remainingGap is required`);
    if (!Array.isArray(control.manualOrLiveRequirements) || control.manualOrLiveRequirements.length === 0 ||
        control.manualOrLiveRequirements.some((item) => !nonempty(item))) {
      errors.push(`${prefix}.manualOrLiveRequirements must contain non-empty strings`);
    }
  });
  if (controls.length !== EXPECTED_IDS.length) errors.push(`controls must contain exactly ${EXPECTED_IDS.length} entries`);
  for (const id of EXPECTED_IDS) if (!ids.has(id)) errors.push(`${id} is missing`);
  const orderedIds = controls.map((control) => control?.id);
  if (orderedIds.length === EXPECTED_IDS.length && orderedIds.some((id, index) => id !== EXPECTED_IDS[index])) {
    errors.push("controls must be ordered C01 through C12");
  }

  const summary = countStatuses(controls);
  if (!plainObject(register.expectedSummary)) errors.push("expectedSummary is required");
  else {
    for (const field of ["pass", "partial", "missing", "incomplete"]) {
      if (register.expectedSummary[field] !== summary[field]) {
        errors.push(`expectedSummary.${field} does not match controls`);
      }
    }
    if (register.expectedSummary.releaseAccepted !== register.releaseGate?.releaseAccepted) {
      errors.push("expectedSummary.releaseAccepted does not match releaseGate.releaseAccepted");
    }
  }

  const everyControlAccepted = controls.length === EXPECTED_IDS.length && controls.every((control) =>
    control?.status === "pass" && control.releaseAccepted === true);
  const gateSatisfied = errors.length === 0 && summary.incomplete === 0 &&
    register.releaseGate?.releaseAccepted === true && everyControlAccepted;
  if (register.releaseGate?.releaseAccepted === true && !everyControlAccepted) {
    errors.push("releaseGate cannot be accepted until every control passes and is release accepted");
  }
  errors.push(...scanForSecrets(register).map((finding) => `secret scan: ${finding}`));
  return { valid: errors.length === 0, errors, summary, gateSatisfied };
}

function loadReleaseControls(filePath = RELEASE_CONTROLS_PATH) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function checkReleaseControls({ filePath = RELEASE_CONTROLS_PATH, allowIncomplete = false, rootDir = ROOT } = {}) {
  let register;
  try {
    register = loadReleaseControls(filePath);
  } catch {
    return {
      ok: false,
      schemaValid: false,
      releaseGate: "fail",
      allowIncomplete,
      counts: { pass: 0, partial: 0, missing: 0, incomplete: 0, partialOrMissing: 0 },
      errors: ["Release-control register could not be loaded."],
    };
  }
  const validation = validateReleaseControls(register, { rootDir });
  const machineEvidence = validation.valid
    ? evaluateMachineControls({ rootDir })
    : {
        gateSatisfied: false,
        verifiedControlCount: 0,
        unverifiedControlCount: EXPECTED_IDS.length,
        verifiedControls: [],
        unverifiedControls: [...EXPECTED_IDS],
        controls: {},
      };
  const statusEvidenceErrors = validation.valid
    ? register.controls
        .filter((control) => control.status === "pass" && machineEvidence.controls?.[control.id]?.verified !== true)
        .map((control) => `${control.id} is marked pass without a passing deterministic machine probe`)
    : [];
  const evidenceAligned = statusEvidenceErrors.length === 0;
  const gateSatisfied = validation.valid && evidenceAligned && validation.gateSatisfied && machineEvidence.gateSatisfied;
  return {
    ok: validation.valid && evidenceAligned && (gateSatisfied || allowIncomplete),
    schemaValid: validation.valid,
    releaseGate: gateSatisfied ? "pass" : "fail",
    releaseAccepted: register.releaseGate?.releaseAccepted === true,
    allowIncomplete,
    registerVersion: register.registerVersion || null,
    counts: validation.summary,
    machineEvidence,
    errors: [...validation.errors, ...statusEvidenceErrors],
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const allowedArgs = new Set(["--allow-incomplete"]);
  const unexpected = args.filter((arg) => !allowedArgs.has(arg));
  const allowIncomplete = args.includes("--allow-incomplete");
  const result = unexpected.length
    ? {
        ok: false,
        schemaValid: false,
        releaseGate: "fail",
        allowIncomplete,
        counts: { pass: 0, partial: 0, missing: 0, incomplete: 0, partialOrMissing: 0 },
        errors: [`Unknown arguments: ${unexpected.join(", ")}`],
      }
    : checkReleaseControls({ allowIncomplete });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = {
  EXPECTED_IDS,
  MACHINE_PROBES,
  RELEASE_CONTROLS_PATH,
  checkReleaseControls,
  countStatuses,
  evaluateMachineControls,
  loadReleaseControls,
  validateReleaseControls,
};
