"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SYNTHETIC_PROJECT_NAME,
  SYNTHETIC_TRACE_SCHEMA,
  createFixedSyntheticTracePayload,
  exportOptionalTrace,
  issueFixedSyntheticTraceAuthority,
} = require("../src/lib/optional-trace-export");

function prohibitedSentinels() {
  return Object.freeze({
    langsmith: `lsv2_${"a".repeat(24)}`,
    apiKey: `sk-${"b".repeat(24)}`,
    bearer: `Bearer ${"c".repeat(24)}`,
    signedUrl: "https://example.invalid/upload?token=private-signed-token",
    activation: "NH-PRIVATE-ACTIVATION",
    lineUser: `U${"d".repeat(32)}`,
    privateDocument: "PRIVATE_DOCUMENT_SENTINEL_C08",
  });
}

function assertNoSentinel(values, sentinels) {
  const serialized = JSON.stringify(values);
  for (const sentinel of Object.values(sentinels)) {
    assert.equal(serialized.includes(sentinel), false, `Sensitive sentinel leaked: ${sentinel}`);
  }
}

test("C08: a candidate containing every prohibited sentinel is denied before transport and leaks nowhere", async () => {
  const sentinels = prohibitedSentinels();
  const outbound = [];
  const notifications = [];
  const candidate = {
    inputs: {
      authorization: sentinels.bearer,
      api_key: sentinels.apiKey,
      langsmith_key: sentinels.langsmith,
      signed_url: sentinels.signedUrl,
      activation_code: sentinels.activation,
      line_user_id: sentinels.lineUser,
      private_document_content: sentinels.privateDocument,
    },
  };

  const result = await exportOptionalTrace({
    enabled: true,
    payload: candidate,
    authority: null,
    transport: async (request) => {
      outbound.push(request);
      return { accepted: true, receiptId: "must-not-run" };
    },
    notify: async (event) => notifications.push(event),
  });

  assert.deepEqual(result, {
    status: "denied",
    code: "PRIVATE_DOCUMENT_EXPORT_DENIED",
    attempts: 0,
    settlement: "cancelled_before_dispatch",
  });
  assert.equal(outbound.length, 0);
  assert.deepEqual(notifications, [{
    event: "optional_trace_export",
    outcome: "PRIVATE_DOCUMENT_EXPORT_DENIED",
    attempts: 0,
  }]);
  assertNoSentinel([result, outbound, notifications], sentinels);
});

test("C08: the actual fixed-synthetic exporter emits only the allowlisted schema", async () => {
  const sentinels = prohibitedSentinels();
  const payload = createFixedSyntheticTracePayload({
    scenario: "connection-check",
    runId: "88888888-8888-4888-8888-888888888888",
    startedAt: 10,
    endedAt: 12,
    durationMs: 2,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolVerified: false,
  });
  const authority = issueFixedSyntheticTraceAuthority(payload);
  const outbound = [];

  const result = await exportOptionalTrace({
    enabled: true,
    payload,
    authority,
    transport: async (request) => {
      outbound.push(request);
      return { accepted: true, receiptId: "c08-offline-capture" };
    },
  });

  assert.deepEqual(result, {
    status: "exported",
    code: "TRACE_EXPORTED",
    attempts: 1,
    settlement: "completed",
  });
  assert.equal(outbound.length, 1);
  assert.deepEqual(outbound[0].headers, { "content-type": "application/json" });
  assert.equal(outbound[0].body.project_name, SYNTHETIC_PROJECT_NAME);
  assert.equal(outbound[0].body.extra.metadata.schema, SYNTHETIC_TRACE_SCHEMA);
  assert.deepEqual(outbound[0].body.inputs, { fixture_id: "fixed-echo-v1" });
  assert.deepEqual(Object.keys(outbound[0].body).sort(), [
    "end_time", "extra", "id", "inputs", "name", "outputs",
    "project_name", "run_type", "start_time", "tags", "trace_id",
  ]);
  assertNoSentinel(outbound, sentinels);
});
