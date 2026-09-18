"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SYNTHETIC_PROJECT_NAME,
  SYNTHETIC_TRACE_SCHEMA,
  createFixedSyntheticTracePayload,
  exportOptionalTrace,
  finalizeAuditedWorkflow,
  issueFixedSyntheticTraceAuthority,
  prepareTraceExport,
} = require("../src/lib/optional-trace-export");
const { redactTracePayload } = require("../src/lib/admission-control");

function sensitiveFixtures() {
  return {
    langsmith: ["lsv2", "outbound", "fixture"].join("_"),
    apiKey: ["sk", "outbound", "fixture"].join("-"),
    bearer: ["Bearer", "outbound-fixture"].join(" "),
    signedUrl: `https://example.invalid/upload?${["to", "ken"].join("")}=outbound-fixture`,
    awsSignedUrl: `https://example.invalid/object?${["X-Amz", "Signature"].join("-")}=0123456789abcdef`,
    activation: ["NH", "OUTBOUND", "FIXTURE"].join("-"),
    lineUser: `U${"a".repeat(32)}`,
    gemini: `AIza${"a".repeat(28)}`,
    groq: `gsk_${"b".repeat(24)}`,
    github: `github_pat_${"c".repeat(24)}`,
    jwt: `${`eyJ${"d".repeat(12)}`}.${"e".repeat(12)}.${"f".repeat(12)}`,
    privateDocument: ["private", "document", "fixture"].join("-"),
  };
}

function assertAbsent(haystacks, needles) {
  const combined = haystacks.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  for (const needle of needles) assert.equal(combined.includes(needle), false, `Sensitive fixture leaked: ${needle}`);
}

let syntheticSequence = 0;

function trustedSynthetic({ scenario = "connection-check", toolVerified = false, modelCalls = 0 } = {}) {
  syntheticSequence += 1;
  const payload = createFixedSyntheticTracePayload({
    scenario,
    runId: `11111111-1111-4111-8111-${syntheticSequence.toString(16).padStart(12, "0")}`,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    modelCalls,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolVerified,
  });
  const authority = issueFixedSyntheticTraceAuthority(payload);
  assert.ok(authority, "Fixed synthetic fixture must receive trusted authority");
  return { payload, authority };
}

function acceptedReceipt() {
  return { accepted: true, receiptId: "offline-test-receipt" };
}

test("disabled, rejected, and timed-out optional exports preserve the customer result and mandatory audit", async (t) => {
  const cases = [
    {
      name: "disabled",
      trace: { enabled: false },
      expected: { status: "disabled", code: "TRACE_EXPORT_DISABLED", attempts: 0, settlement: "cancelled_before_dispatch" },
      expectedCalls: 0,
    },
    {
      name: "rejected",
      trace: { enabled: true, transport: async () => {
        const error = new Error("provider rejected");
        error.traceOutcome = "failed_after_dispatch";
        throw error;
      } },
      expected: { status: "rejected", code: "TRACE_EXPORT_REJECTED", attempts: 1, settlement: "failed_after_dispatch" },
      expectedCalls: 1,
    },
    {
      name: "timeout",
      trace: {
        enabled: true,
        timeoutMs: 5,
        transport: async (_outbound, { signal }) => new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        }),
      },
      expected: { status: "timeout", code: "TRACE_EXPORT_TIMEOUT", attempts: 1, settlement: "transport_uncertain" },
      expectedCalls: 1,
    },
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const customerResult = Object.freeze({ reply: "verified fictional answer" });
    const auditEvidence = Object.freeze({ auditId: "audit-1", persisted: true });
    let auditCalls = 0;
    let transportCalls = 0;
    const originalTransport = scenario.trace.transport;
    const trace = {
      ...scenario.trace,
      ...trustedSynthetic(),
      ...(originalTransport ? {
        transport: async (...args) => {
          transportCalls += 1;
          return originalTransport(...args);
        },
      } : {}),
    };
    const completed = await finalizeAuditedWorkflow({
      customerResult,
      persistMandatoryAudit: async () => { auditCalls += 1; return auditEvidence; },
      optionalTrace: trace,
    });

    assert.equal(completed.ok, true);
    assert.strictEqual(completed.customerResult, customerResult);
    assert.strictEqual(completed.auditEvidence, auditEvidence);
    assert.equal(auditCalls, 1);
    assert.equal(transportCalls, scenario.expectedCalls);
    assert.deepEqual(completed.optionalTrace, scenario.expected);
  });
});

test("mandatory audit failure blocks a consequential action and skips optional tracing", async () => {
  let actionCalls = 0;
  let transportCalls = 0;
  const outcome = await finalizeAuditedWorkflow({
    customerResult: { reply: "must not be released" },
    persistMandatoryAudit: async () => { throw new Error("audit store unavailable"); },
    dispatchConsequentialAction: async () => { actionCalls += 1; },
    optionalTrace: {
      enabled: true,
      dataClass: "synthetic",
      payload: { event: "consequential action" },
      transport: async () => { transportCalls += 1; },
    },
  });

  assert.deepEqual(outcome, {
    ok: false,
    code: "MANDATORY_AUDIT_FAILED",
    customerResult: null,
    auditEvidence: null,
    actionResult: null,
    optionalTrace: { status: "skipped", code: "TRACE_SKIPPED_AUDIT_FAILURE", attempts: 0, settlement: "cancelled_before_dispatch" },
  });
  assert.equal(actionCalls, 0);
  assert.equal(transportCalls, 0);
});

test("caller-provided free-form trace data cannot receive authority or reach transport", async () => {
  const fixtures = sensitiveFixtures();
  const transport = [];
  const notifications = [];
  const payload = {
    inputs: {
      authorization: fixtures.bearer,
      api_key: fixtures.apiKey,
      activation_code: fixtures.activation,
      line_user_id: fixtures.lineUser,
      signed_url: fixtures.signedUrl,
      text: [
        fixtures.langsmith, fixtures.lineUser, fixtures.gemini, fixtures.groq,
        fixtures.github, fixtures.jwt, fixtures.awsSignedUrl, fixtures.activation,
      ].join(" "),
    },
    outputs: { reply: "synthetic answer" },
    metadata: { purpose: "fixed test", contains_private_document: false },
  };
  assert.equal(issueFixedSyntheticTraceAuthority(payload), null);
  const result = await exportOptionalTrace({
    enabled: true,
    timeoutMs: 50,
    payload,
    authority: null,
    transport: async (outbound) => { transport.push(outbound); return acceptedReceipt(); },
    notify: async (event) => { notifications.push(event); },
  });

  assert.deepEqual(result, { status: "denied", code: "TRACE_SCHEMA_REQUIRED", attempts: 0, settlement: "cancelled_before_dispatch" });
  assert.equal(transport.length, 0);
  const storedTraceFixture = JSON.stringify(transport);
  const logFixture = JSON.stringify(notifications);
  assertAbsent([transport, storedTraceFixture, logFixture, result], Object.values(fixtures));
});

test("the installed LangSmith client sends one redacted HTTP request through a captured offline transport", async () => {
  const { Client } = await import("langsmith");
  const fixtures = sensitiveFixtures();
  const requests = [];
  const client = new Client({
    apiUrl: "https://capture.invalid",
    apiKey: "capture-only-auth",
    timeout_ms: 50,
    callerOptions: { maxRetries: 0, maxConcurrency: 1 },
    autoBatchTracing: false,
    omitTracedRuntimeInfo: true,
    anonymizer: redactTracePayload,
    fetchImplementation: async (url, init) => {
      requests.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : String(init?.body || ""),
      });
      return new Response("", { status: 202 });
    },
  });
  const fixed = trustedSynthetic();
  const result = await exportOptionalTrace({
    enabled: true,
    timeoutMs: 1_000,
    ...fixed,
    transport: async ({ body }) => {
      await client.createRun(body);
      return acceptedReceipt();
    },
  });

  assert.deepEqual(result, { status: "exported", code: "TRACE_EXPORTED", attempts: 1, settlement: "completed" });
  assert.equal(requests.length, 1, "LangSmith transport must make exactly one bounded attempt");
  assert.match(requests[0].url, /capture\.invalid\/runs$/);
  assertAbsent(requests, Object.values(fixtures));
  const sent = JSON.parse(requests[0].body);
  assert.equal(sent.session_name, SYNTHETIC_PROJECT_NAME);
  assert.equal(sent.extra.metadata.schema, SYNTHETIC_TRACE_SCHEMA);
  assert.deepEqual(sent.inputs, { fixture_id: "fixed-echo-v1" });
  assert.equal(Object.hasOwn(sent.outputs, "reply"), false);
});

test("transport errors and optional notifications expose only fixed classifications", async () => {
  const fixtures = sensitiveFixtures();
  const notifications = [];
  const result = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(),
    transport: async () => {
      throw new Error(Object.values(fixtures).join(" "));
    },
    notify: async (event) => { notifications.push(event); },
  });

  assert.deepEqual(result, { status: "uncertain", code: "TRACE_EXPORT_UNCERTAIN", attempts: 1, settlement: "transport_uncertain" });
  assertAbsent([result, notifications], Object.values(fixtures));
});

test("a stalled optional notification cannot delay the bounded export result", async () => {
  const completion = await Promise.race([
    exportOptionalTrace({
      enabled: true,
      ...trustedSynthetic(),
      transport: async () => acceptedReceipt(),
      notify: async () => new Promise(() => {}),
    }),
    new Promise((resolve) => setTimeout(() => resolve("unexpected-delay"), 50)),
  ]);
  assert.deepEqual(completion, { status: "exported", code: "TRACE_EXPORTED", attempts: 1, settlement: "completed" });
});

test("a transport that ignores abort is attempted once and remains uncertain after late completion", async () => {
  let attempts = 0;
  let lateCompletions = 0;
  const result = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(),
    timeoutMs: 5,
    transport: async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      lateCompletions += 1;
      return acceptedReceipt();
    },
  });
  assert.deepEqual(result, { status: "timeout", code: "TRACE_EXPORT_TIMEOUT", attempts: 1, settlement: "transport_uncertain" });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(attempts, 1);
  assert.equal(lateCompletions, 1, "Late completion does not turn the uncertain result into success");
});

test("dispatch is marked immediately before transport and a failed mark makes zero transport calls", async () => {
  const order = [];
  const completed = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(),
    beforeTransport: async () => { order.push("mark"); return { ok: true }; },
    transport: async () => { order.push("transport"); return acceptedReceipt(); },
  });
  assert.deepEqual(order, ["mark", "transport"]);
  assert.equal(completed.settlement, "completed");

  order.length = 0;
  const blocked = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(),
    beforeTransport: async () => { order.push("mark"); return { ok: false }; },
    transport: async () => { order.push("transport"); },
  });
  assert.deepEqual(order, ["mark"]);
  assert.deepEqual(blocked, {
    status: "rejected",
    code: "TRACE_DISPATCH_NOT_MARKED",
    attempts: 0,
    settlement: "cancelled_before_dispatch",
  });
});

test("private document content is denied before transport instead of being relabelled", async () => {
  const fixtures = sensitiveFixtures();
  const transport = [];
  const notifications = [];
  const payload = {
    metadata: { data_class: "redacted_evidence" },
    private_document_content: fixtures.privateDocument,
  };
  const result = await exportOptionalTrace({
    enabled: true,
    payload,
    authority: null,
    transport: async (outbound) => { transport.push(outbound); },
    notify: async (event) => { notifications.push(event); },
  });

  assert.deepEqual(result, { status: "denied", code: "PRIVATE_DOCUMENT_EXPORT_DENIED", attempts: 0, settlement: "cancelled_before_dispatch" });
  assert.equal(transport.length, 0);
  assertAbsent([transport, notifications, result], [fixtures.privateDocument]);
});

test("private document text hidden in generic outputs.reply is denied before transport", async () => {
  const privateText = "confidential customer document paragraph with invoice details";
  const payload = {
    inputs: { fixture_id: "fixed-echo-v1" },
    outputs: { reply: privateText },
  };
  let transportCalls = 0;

  assert.equal(issueFixedSyntheticTraceAuthority(payload), null);
  const result = await exportOptionalTrace({
    enabled: true,
    payload,
    authority: null,
    transport: async () => { transportCalls += 1; return acceptedReceipt(); },
  });

  assert.deepEqual(result, {
    status: "denied",
    code: "TRACE_SCHEMA_REQUIRED",
    attempts: 0,
    settlement: "cancelled_before_dispatch",
  });
  assert.equal(transportCalls, 0);
  assert.equal(JSON.stringify(result).includes(privateText), false);
});

test("the fixed synthetic builder rejects unknown fields instead of ignoring free-form text", () => {
  const privateText = "confidential document text must not enter a synthetic trace";
  const attempted = createFixedSyntheticTracePayload({
    scenario: "connection-check",
    runId: "22222222-2222-4222-8222-222222222222",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    outputs: { reply: privateText },
  });
  assert.equal(attempted, null);
  assert.equal(createFixedSyntheticTracePayload({
    scenario: "__proto__",
    runId: "22222222-2222-4222-8222-222222222222",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
  }), null);
});

test("accessors, custom prototypes and toJSON hooks cannot create an outbound payload", async () => {
  const hidden = sensitiveFixtures().privateDocument;
  const withGetter = { outputs: {} };
  Object.defineProperty(withGetter.outputs, "reply", {
    enumerable: true,
    get() { return hidden; },
  });
  const withToJson = {
    outputs: { reply: "visible synthetic value" },
    toJSON() { return { private_document_content: hidden }; },
  };
  const inherited = Object.create({ private_document_content: hidden });
  inherited.outputs = { reply: "visible synthetic value" };

  for (const payload of [withGetter, withToJson, inherited]) {
    assert.equal(issueFixedSyntheticTraceAuthority(payload), null);
    const outcome = prepareTraceExport(payload, { authority: null });
    assert.deepEqual(outcome.result, {
      status: "denied",
      code: "TRACE_PAYLOAD_INVALID",
      attempts: 0,
      settlement: "cancelled_before_dispatch",
    });
    assert.equal(JSON.stringify(outcome).includes(hidden), false);
  }
});

test("a resolved transport response needs an explicit acceptance receipt", async () => {
  const first = trustedSynthetic();
  const noReceipt = await exportOptionalTrace({
    enabled: true,
    ...first,
    transport: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(noReceipt, {
    status: "uncertain",
    code: "TRACE_EXPORT_UNCERTAIN",
    attempts: 1,
    settlement: "transport_uncertain",
  });
  const accepted = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(),
    transport: async () => acceptedReceipt(),
  });
  assert.deepEqual(accepted, {
    status: "exported",
    code: "TRACE_EXPORTED",
    attempts: 1,
    settlement: "completed",
  });
});

test("a stalled dispatch marker is bounded and never calls transport", async () => {
  let transportCalls = 0;
  const outcome = await Promise.race([
    exportOptionalTrace({
      enabled: true,
      ...trustedSynthetic(),
      timeoutMs: 5,
      beforeTransport: async () => new Promise(() => {}),
      transport: async () => { transportCalls += 1; return acceptedReceipt(); },
    }),
    new Promise((resolve) => setTimeout(() => resolve("unbounded"), 50)),
  ]);
  assert.deepEqual(outcome, {
    status: "timeout",
    code: "TRACE_DISPATCH_TIMEOUT",
    attempts: 0,
    settlement: "transport_uncertain",
  });
  assert.equal(transportCalls, 0);
});

test("forged authority, changed payloads, invalid structures, and oversized payloads fail closed", async () => {
  const fixed = trustedSynthetic();
  assert.deepEqual(
    prepareTraceExport({ outputs: { reply: "private document excerpt" } }, {
      authority: { source: "fixed_internal_cli", dataClass: "synthetic" },
    }).result,
    { status: "denied", code: "TRACE_SCHEMA_REQUIRED", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
  assert.deepEqual(
    prepareTraceExport(fixed.payload, {
      authority: { source: "fixed_internal_cli", schema: SYNTHETIC_TRACE_SCHEMA },
    }).result,
    { status: "denied", code: "TRACE_AUTHORITY_REQUIRED", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
  const circular = {};
  circular.self = circular;
  assert.equal(issueFixedSyntheticTraceAuthority(circular), null);
  assert.deepEqual(
    prepareTraceExport(circular, {}).result,
    { status: "denied", code: "TRACE_PAYLOAD_INVALID", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
  const cloned = JSON.parse(JSON.stringify(fixed.payload));
  assert.deepEqual(
    prepareTraceExport(cloned, { authority: fixed.authority }).result,
    { status: "denied", code: "TRACE_SCHEMA_REQUIRED", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
  assert.equal(Object.isFrozen(fixed.payload), true);
  assert.equal(Object.isFrozen(fixed.payload.outputs), true);
  assert.throws(() => { fixed.payload.outputs.status = "mutated"; }, TypeError);
  assert.deepEqual(
    prepareTraceExport(fixed.payload, { authority: fixed.authority, maxPayloadBytes: 16 }).result,
    { status: "denied", code: "TRACE_PAYLOAD_TOO_LARGE", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
});
