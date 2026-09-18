"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  ADVERSARIAL_PROBE,
  boundarySupport,
  runUntrustedBoundaryProbe,
} = require("../src/lib/untrusted-execution-boundary");

test("C10 boundary support check and public runner fail closed when permission flags are unavailable", () => {
  assert.equal(boundarySupport().supported, true, "This local proof requires Node permission support");
  assert.deepEqual(boundarySupport({
    allowedFlags: new Set(),
    nodeVersion: "24.0.0",
    platform: "linux",
  }), {
    supported: false,
    nodeMajor: 24,
    platform: "linux",
    permissionFlagsAvailable: false,
  });
  assert.equal(boundarySupport({
    allowedFlags: process.allowedNodeEnvironmentFlags,
    nodeVersion: "21.9.0",
    platform: "linux",
  }).supported, false);
  assert.equal(boundarySupport({
    allowedFlags: process.allowedNodeEnvironmentFlags,
    nodeVersion: "24.0.0",
    platform: "invented-os",
  }).supported, false);

  const descriptor = Object.getOwnPropertyDescriptor(process, "allowedNodeEnvironmentFlags");
  assert.equal(descriptor?.configurable, true);
  try {
    Object.defineProperty(process, "allowedNodeEnvironmentFlags", {
      configurable: true,
      enumerable: descriptor.enumerable,
      value: new Set(),
    });
    const result = runUntrustedBoundaryProbe({ cwd: path.resolve(tmpdir()) });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BOUNDARY_UNSUPPORTED");
    assert.equal(result.spawned, false);
    assert.equal(result.support.supported, false);
    assert.equal(result.support.permissionFlagsAvailable, false);
  } finally {
    Object.defineProperty(process, "allowedNodeEnvironmentFlags", descriptor);
  }
});

test("C10 local evidence: the fixed probe receives no secrets, customer data, real transport or tools", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "neurohands-untrusted-boundary-"));
  const secret = "sb_secret_C10_SENTINEL_123456789";
  const customer = "PRIVATE_CUSTOMER_C10_SENTINEL";
  try {
    writeFileSync(path.join(directory, ".env"),
      `SUPABASE_SERVICE_KEY=${secret}\nCUSTOMER_RECORD=${customer}\n`, "utf8");
    const result = runUntrustedBoundaryProbe({
      cwd: directory,
      forbiddenSentinels: [secret, customer],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, "BOUNDARY_PROBE_PASSED");
    assert.equal(result.spawned, true);
    assert.deepEqual(result.environment, { allowlisted: true });
    assert.deepEqual(result.network, {
      scope: "application_capabilities",
      transport: "absent",
      attemptedPaths: 3,
      osNetworkIsolated: false,
    });
    assert.equal(Object.values(result.permissions).every(Boolean), true);
    assert.deepEqual(result.enforcement, {
      secretFileReadDenied: true,
      artifactWriteDenied: true,
      childProcessStartDenied: true,
    });
    assert.deepEqual(result.attempts, {
      environmentEnumeration: true,
      moduleLoading: true,
      secretFileRead: true,
      directNetwork: true,
      socketNetwork: true,
      networkMetadata: true,
      productionTools: true,
      globalConstructorEscape: true,
      objectConstructorEscape: true,
      fetchConstructorEscape: true,
      toolsConstructorEscape: true,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /C10_SENTINEL|SUPABASE_SERVICE_KEY|CUSTOMER_RECORD/);
    assert.deepEqual(readdirSync(directory), [".env"], "The child must not produce files or artifacts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("C10-PC2: a requested credential is rejected before any child command starts", () => {
  const secret = "sb_secret_REJECT_BEFORE_SPAWN_123456";
  const result = runUntrustedBoundaryProbe({
    cwd: path.resolve(tmpdir()),
    requestedEnvironment: { SUPABASE_SERVICE_KEY: secret },
    forbiddenSentinels: [secret],
  });
  assert.deepEqual(result, {
    ok: false,
    code: "UNTRUSTED_ENVIRONMENT_REJECTED",
    spawned: false,
    rejectedCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /REJECT_BEFORE_SPAWN/);
});

test("the harness exposes one fixed reviewed probe rather than an arbitrary command interface", () => {
  assert.equal(typeof ADVERSARIAL_PROBE, "string");
  assert.match(ADVERSARIAL_PROBE, /process\.env/);
  assert.match(ADVERSARIAL_PROBE, /node:fs/);
  assert.match(ADVERSARIAL_PROBE, /169\.254\.169\.254/);
  assert.match(ADVERSARIAL_PROBE, /node:net/);
  assert.match(ADVERSARIAL_PROBE, /networkInterfaces/);
  assert.match(ADVERSARIAL_PROBE, /deployProduction/);
  assert.match(ADVERSARIAL_PROBE, /fetch\.constructor/);
  assert.match(ADVERSARIAL_PROBE, /tools\.constructor\.constructor/);
  assert.equal(Object.hasOwn(runUntrustedBoundaryProbe, "execute"), false);
});

test("invalid caller settings are rejected before spawn", () => {
  assert.equal(runUntrustedBoundaryProbe({ cwd: "relative" }).code, "BOUNDARY_WORKDIR_REQUIRED");
  assert.equal(runUntrustedBoundaryProbe({ cwd: path.resolve(tmpdir()), requestedEnvironment: null }).code,
    "UNTRUSTED_ENVIRONMENT_REJECTED");
  assert.equal(runUntrustedBoundaryProbe({ cwd: path.resolve(tmpdir()), forbiddenSentinels: [1] }).code,
    "INVALID_SENTINEL_POLICY");
  const missing = path.join(tmpdir(), `neurohands-missing-boundary-${process.pid}-${Date.now()}`);
  assert.deepEqual(runUntrustedBoundaryProbe({ cwd: missing }), {
    ok: false,
    code: "BOUNDARY_CHILD_FAILED",
    spawned: true,
  });
});
