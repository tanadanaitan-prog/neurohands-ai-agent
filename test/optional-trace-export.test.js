"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
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

function trustedSynthetic(payload) {
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
    const tracePayload = { inputs: { question: "fictional service question" }, outputs: customerResult };
    const trace = {
      ...scenario.trace,
      ...trustedSynthetic(tracePayload),
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

test("the actual outbound transport receives only the bounded redacted trace", async () => {
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
  const result = await exportOptionalTrace({
    enabled: true,
    timeoutMs: 50,
    ...trustedSynthetic(payload),
    transport: async (outbound) => { transport.push(outbound); return acceptedReceipt(); },
    notify: async (event) => { notifications.push(event); },
  });

  assert.deepEqual(result, { status: "exported", code: "TRACE_EXPORTED", attempts: 1, settlement: "completed" });
  assert.equal(transport.length, 1);
  assert.deepEqual(transport[0].headers, { "content-type": "application/json" });
  assert.equal(transport[0].body.inputs.authorization, "[REDACTED]");
  assert.equal(transport[0].body.inputs.api_key, "[REDACTED]");
  assert.equal(transport[0].body.inputs.activation_code, "[REDACTED]");
  assert.equal(transport[0].body.inputs.line_user_id, "[REDACTED]");
  assert.equal(transport[0].body.inputs.signed_url, "[REDACTED]");
  const storedTraceFixture = JSON.stringify(transport[0]);
  const logFixture = JSON.stringify(notifications);
  assertAbsent(
    [transport, storedTraceFixture, logFixture, result],
    Object.values(fixtures).filter((value) => value !== fixtures.privateDocument)
  );
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
        body: String(init?.body || ""),
      });
      return new Response("", { status: 202 });
    },
  });
  const payload = {
      id: "11111111-1111-4111-8111-111111111111",
      trace_id: "11111111-1111-4111-8111-111111111111",
      name: "captured-offline-test",
      run_type: "chain",
      project_name: "captured-offline-test",
      start_time: 1,
      end_time: 2,
      inputs: {
        authorization: fixtures.bearer,
        note: [fixtures.langsmith, fixtures.lineUser, fixtures.gemini, fixtures.groq, fixtures.github, fixtures.jwt].join(" "),
      },
      outputs: { activation_code: fixtures.activation, signed_url: fixtures.signedUrl, sdk_error: fixtures.awsSignedUrl },
      extra: { metadata: { api_key: fixtures.apiKey, data_class: "synthetic" } },
  };
  const result = await exportOptionalTrace({
    enabled: true,
    timeoutMs: 1_000,
    ...trustedSynthetic(payload),
    transport: async ({ body }) => {
      await client.createRun(body);
      return acceptedReceipt();
    },
  });

  assert.deepEqual(result, { status: "exported", code: "TRACE_EXPORTED", attempts: 1, settlement: "completed" });
  assert.equal(requests.length, 1, "LangSmith transport must make exactly one bounded attempt");
  assert.match(requests[0].url, /capture\.invalid\/runs$/);
  assertAbsent(requests, Object.values(fixtures).filter((value) => value !== fixtures.privateDocument));
});

test("transport errors and optional notifications expose only fixed classifications", async () => {
  const fixtures = sensitiveFixtures();
  const notifications = [];
  const payload = { text: "fictional input" };
  const result = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(payload),
    transport: async () => {
      throw new Error(Object.values(fixtures).join(" "));
    },
    notify: async (event) => { notifications.push(event); },
  });

  assert.deepEqual(result, { status: "uncertain", code: "TRACE_EXPORT_UNCERTAIN", attempts: 1, settlement: "transport_uncertain" });
  assertAbsent([result, notifications], Object.values(fixtures));
});

test("a stalled optional notification cannot delay the bounded export result", async () => {
  const payload = { text: "fictional input" };
  const completion = await Promise.race([
    exportOptionalTrace({
      enabled: true,
      ...trustedSynthetic(payload),
      transport: async () => acceptedReceipt(),
      notify: async () => new Promise(() => {}),
    }),
    new Promise((resolve) => setTimeout(() => resolve("unexpected-delay"), 50)),
  ]);
  assert.deepEqual(completion, { status: "exported", code: "TRACE_EXPORTED", attempts: 1, settlement: "completed" });
});

test("a transport that ignores abort is attempted once and remains uncertain after late completion", async () => {
  const payload = { text: "fixed synthetic input" };
  let attempts = 0;
  let lateCompletions = 0;
  const result = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(payload),
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
  const payload = { text: "fixed synthetic input" };
  const order = [];
  const completed = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(payload),
    beforeTransport: async () => { order.push("mark"); return { ok: true }; },
    transport: async () => { order.push("transport"); return acceptedReceipt(); },
  });
  assert.deepEqual(order, ["mark", "transport"]);
  assert.equal(completed.settlement, "completed");

  order.length = 0;
  const blocked = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(payload),
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
  const payload = { inputs: { text: "fixed synthetic" }, outputs: { reply: "fixed answer" } };
  const noReceipt = await exportOptionalTrace({
    enabled: true,
    ...trustedSynthetic(payload),
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
    ...trustedSynthetic(payload),
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
  const payload = { text: "fixed synthetic" };
  let transportCalls = 0;
  const outcome = await Promise.race([
    exportOptionalTrace({
      enabled: true,
      ...trustedSynthetic(payload),
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
  assert.deepEqual(
    prepareTraceExport({ outputs: { reply: "private document excerpt" } }, {
      authority: { source: "fixed_internal_cli", dataClass: "synthetic" },
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
  const changed = { text: "fixed synthetic" };
  const changedAuthority = issueFixedSyntheticTraceAuthority(changed);
  changed.text = "mutated after classification";
  assert.deepEqual(
    prepareTraceExport(changed, { authority: changedAuthority }).result,
    { status: "denied", code: "TRACE_AUTHORITY_MISMATCH", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
  const large = { text: "x".repeat(100) };
  assert.deepEqual(
    prepareTraceExport(large, { authority: issueFixedSyntheticTraceAuthority(large), maxPayloadBytes: 16 }).result,
    { status: "denied", code: "TRACE_PAYLOAD_TOO_LARGE", attempts: 0, settlement: "cancelled_before_dispatch" }
  );
});
