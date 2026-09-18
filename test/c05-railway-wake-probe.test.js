"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  WakeProbeError,
  cliArguments,
  probeInactiveRailwayWake,
} = require("../scripts/c05-railway-wake-probe");

const COMMIT = "a".repeat(40);

function sequencedFetch(sequence, calls) {
  return async (url, options) => {
    calls.push({ url, options });
    const next = sequence.shift();
    assert.ok(next, `Unexpected request to ${url}`);
    if (next instanceof Error) throw next;
    return new Response(next.body || "", {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers || {}) },
    });
  };
}

test("C05 staging probe tolerates one read-only wake response and pins readiness to the reviewed revision", async () => {
  const calls = [];
  const result = await probeInactiveRailwayWake({
    baseUrl: "https://inactive-test.example/",
    expectedCommit: COMMIT,
    retryDelayMs: 0,
    fetchImpl: sequencedFetch([
      { status: 502, body: "cold start" },
      { status: 200, body: JSON.stringify({ version: "3.10.0", commit: COMMIT }) },
      { status: 200, body: JSON.stringify({ ready: true }) },
    ], calls),
  });

  assert.equal(result.result, "infrastructure_probe_passed_release_control_incomplete");
  assert.equal(result.expectedCommit, COMMIT);
  assert.equal(result.observedCommit, COMMIT);
  assert.deepEqual(result.wake.attempts.map(({ status }) => status), [502, 200]);
  assert.deepEqual(result.readiness.attempts.map(({ status }) => status), [200]);
  assert.deepEqual(result.evidence, {
    reviewedRevisionMatched: true,
    readinessConfirmed: true,
    customerResponseTested: false,
    lineDeliveryTested: false,
    ramMeasured: false,
    cpuMeasured: false,
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://inactive-test.example/version",
    "https://inactive-test.example/version",
    "https://inactive-test.example/ready",
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
  }
});

test("C05 staging probe fails closed on a different deployed revision", async () => {
  await assert.rejects(probeInactiveRailwayWake({
    baseUrl: "https://inactive-test.example",
    expectedCommit: COMMIT,
    retryDelayMs: 0,
    fetchImpl: sequencedFetch([
      { status: 200, body: JSON.stringify({ version: "3.10.0", commit: "b".repeat(40) }) },
    ], []),
  }), (error) => error instanceof WakeProbeError && error.code === "REVISION_MISMATCH");
});

test("C05 staging probe never promotes an unavailable or false readiness result", async () => {
  await assert.rejects(probeInactiveRailwayWake({
    baseUrl: "https://inactive-test.example",
    expectedCommit: COMMIT,
    retryDelayMs: 0,
    fetchImpl: sequencedFetch([
      { status: 200, body: JSON.stringify({ version: "3.10.0", commit: COMMIT }) },
      { status: 503, body: JSON.stringify({ ready: false }) },
      { status: 200, body: JSON.stringify({ ready: false }) },
    ], []),
  }), (error) => error instanceof WakeProbeError && error.code === "READINESS_UNCONFIRMED_AFTER_WAKE");
});

test("C05 staging probe rejects unsafe targets, partial commit identifiers and unknown CLI options", async () => {
  for (const baseUrl of [
    "http://inactive-test.example",
    "https://user:secret@inactive-test.example",
    "https://inactive-test.example/path",
    "https://inactive-test.example/?token=private",
  ]) {
    await assert.rejects(probeInactiveRailwayWake({ baseUrl, expectedCommit: COMMIT }),
      (error) => error instanceof WakeProbeError && error.code === "INVALID_BASE_URL");
  }
  await assert.rejects(probeInactiveRailwayWake({
    baseUrl: "https://inactive-test.example",
    expectedCommit: "a".repeat(7),
  }), (error) => error instanceof WakeProbeError && error.code === "INVALID_EXPECTED_COMMIT");
  assert.throws(() => cliArguments(["--base-url", "https://inactive-test.example", "--unknown", "value"]),
    (error) => error instanceof WakeProbeError && error.code === "INVALID_ARGUMENTS");
});

test("C05 staging probe bounds response data and exposes no response body in failure evidence", async () => {
  await assert.rejects(probeInactiveRailwayWake({
    baseUrl: "https://inactive-test.example",
    expectedCommit: COMMIT,
    retryDelayMs: 0,
    fetchImpl: sequencedFetch([
      { status: 200, body: "x".repeat((64 * 1024) + 1) },
    ], []),
  }), (error) => error instanceof WakeProbeError && error.code === "VERSION_UNAVAILABLE_AFTER_WAKE");
});
