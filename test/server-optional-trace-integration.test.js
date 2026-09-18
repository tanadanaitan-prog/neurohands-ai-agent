"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OPTIONAL_TRACE_POLICY,
  createApprovedOptionalTraceRuntime,
  readApprovedOptionalTraceHandle,
} = require("../src/lib/optional-trace-runtime");

const LINE_SENTINEL = "U-private-line-sentinel-731";
const PROMPT_SENTINEL = "private-customer-prompt-sentinel-842";
const ANSWER_SENTINEL = "private-customer-answer-sentinel-953";
const DOCUMENT_SENTINEL = "private-document-text-sentinel-164";
const TOOL_SENTINEL = "private-tool-output-sentinel-275";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { failCompletionAudit = false } = {}) {
  const env = {
    LINE_CHANNEL_SECRET: "fixture-line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "fixture-line-token",
    SUPABASE_URL: "https://database.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_trace-fixture",
    GEMINI_API_KEY: "fixture-gemini-key",
    GEMINI_ENABLED: "true",
    GEMINI_MODEL: "fixture-gemini-model",
    FALLBACK_API_KEY: "",
    FALLBACK_PROVIDER: "",
    FALLBACK_MODEL: "",
    FALLBACK_MODELS: "",
    ENABLE_STUDIO: "false",
    SOFTWARE_ADMISSION_ENABLED: "false",
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const serverPath = require.resolve("../src/server");
  delete require.cache[serverPath];

  const state = {
    nextRun: 1,
    patches: [],
    modelCalls: 0,
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(String(address));
    const method = options.method || "GET";
    if (url.hostname === "generativelanguage.googleapis.com") {
      state.modelCalls += 1;
      return json({ candidates: [{ content: { role: "model", parts: [{ text: ANSWER_SENTINEL }] } }] });
    }
    assert.equal(url.hostname, "database.invalid", "The C07 tests must stay offline");
    const table = url.pathname.slice("/rest/v1/".length);
    if (table === "client_agent_bindings") {
      return json([{ id: 1, line_user_id: LINE_SENTINEL, client_account_id: 77, department: "sales", status: "active" }]);
    }
    if (table === "client_accounts") return json([{ id: 77, active: true }]);
    if (table === "agent_memory") return json([]);
    if (table === "agent_runs" && method === "POST") {
      const id = `run-${state.nextRun++}`;
      return json([{ id }], 201);
    }
    if (table === "agent_runs" && method === "PATCH") {
      state.patches.push(JSON.parse(options.body));
      if (failCompletionAudit) return json({ code: "PGRST000", message: "private database detail" }, 503);
      const id = url.searchParams.get("id")?.slice(3);
      return json([{ id }]);
    }
    throw new Error(`Unexpected offline request: ${method} ${url.pathname}`);
  });

  const gateway = require("../src/server");
  t.after(() => {
    delete require.cache[serverPath];
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const agent = {
    agent_code: "AGT-001",
    agent_name: "Fixture agent",
    callsign: "Aria",
    objective: `Answer only this fixture; ${DOCUMENT_SENTINEL}`,
    system_prompt: "",
    allowed_tools: [],
    domains: ["sales"],
    responsibilities: [`Never expose ${TOOL_SENTINEL}`],
  };
  const run = (optionalTraceRuntime) => gateway.runAgent({
    lineUserId: LINE_SENTINEL,
    clientAccountId: 77,
    department: "sales",
    webhookEventId: "fixture-event-001",
    eventTimestamp: 1_800_000_000_000,
  }, PROMPT_SENTINEL, agent, { optionalTraceRuntime });
  return { gateway, state, run };
}

test("disabled export leaves the answer and mandatory audit unchanged", async (t) => {
  const f = await fixture(t);
  let forgedCalls = 0;
  const answer = await f.run(Object.freeze({
    enabled: true,
    dispatch() { forgedCalls += 1; },
  }));
  await delay(10);

  assert.equal(answer, ANSWER_SENTINEL);
  assert.equal(f.state.patches.length, 1);
  assert.equal(f.state.patches[0].status, "completed");
  assert.equal(f.state.patches[0].output, ANSWER_SENTINEL);
  assert.equal(forgedCalls, 0, "Only a factory-approved injected runtime may run");
});

test("rejection and timeout leave the settled answer unchanged", async (t) => {
  const f = await fixture(t);
  const rejectedOutcome = deferred();
  const rejected = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    dispatch: async () => ({ rejected: true }),
    onOutcome: rejectedOutcome.resolve,
  });
  assert.equal(await f.run(rejected), ANSWER_SENTINEL);
  assert.deepEqual(await rejectedOutcome.promise, {
    status: "rejected",
    code: "TRACE_EXPORT_REJECTED",
    attempts: 1,
    settlement: "failed_after_dispatch",
  });

  const timeoutOutcome = deferred();
  const timedOut = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    timeoutMs: 5,
    dispatch: async () => new Promise(() => {}),
    onOutcome: timeoutOutcome.resolve,
  });
  const customer = await Promise.race([
    f.run(timedOut),
    delay(100).then(() => "CUSTOMER_RESULT_DELAYED"),
  ]);
  assert.equal(customer, ANSWER_SENTINEL);
  assert.deepEqual(await timeoutOutcome.promise, {
    status: "timeout",
    code: "TRACE_EXPORT_TIMEOUT",
    attempts: 1,
    settlement: "transport_uncertain",
  });
  assert.equal(f.state.patches.length, 2);
  assert.ok(f.state.patches.every((patch) => patch.output === ANSWER_SENTINEL));
});

test("a transport ignoring abort is attempted once and never retried", async (t) => {
  const f = await fixture(t);
  const outcome = deferred();
  let attempts = 0;
  let lateCompletions = 0;
  const runtime = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    timeoutMs: 5,
    dispatch: async () => {
      attempts += 1;
      await delay(30);
      lateCompletions += 1;
      return { accepted: true, receiptId: "late-receipt" };
    },
    onOutcome: outcome.resolve,
  });

  assert.equal(await f.run(runtime), ANSWER_SENTINEL);
  assert.equal((await outcome.promise).code, "TRACE_EXPORT_TIMEOUT");
  await delay(50);
  assert.equal(attempts, 1);
  assert.equal(lateCompletions, 1);
});

test("mandatory audit failure makes zero trace calls", async (t) => {
  const f = await fixture(t, { failCompletionAudit: true });
  let traceCalls = 0;
  const runtime = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    dispatch: async () => { traceCalls += 1; return { accepted: true, receiptId: "must-not-exist" }; },
  });

  const answer = await f.run(runtime);
  await delay(20);
  assert.notEqual(answer, ANSWER_SENTINEL);
  assert.equal(f.state.patches.length, 2, "The error-audit retry also failed closed");
  assert.equal(traceCalls, 0);
});

test("customer and document sentinels never reach the hook or outbound capture", async (t) => {
  const f = await fixture(t);
  const outcome = deferred();
  const outbound = [];
  const runtime = createApprovedOptionalTraceRuntime({
    enabled: true,
    approvedPolicy: OPTIONAL_TRACE_POLICY,
    dispatch: async (handle, context) => {
      outbound.push(JSON.stringify({
        handle,
        payload: readApprovedOptionalTraceHandle(handle),
        aborted: context.signal.aborted,
      }));
      return { accepted: true, receiptId: "offline-capture-1" };
    },
    onOutcome: outcome.resolve,
  });

  assert.equal(await f.run(runtime), ANSWER_SENTINEL);
  assert.equal((await outcome.promise).code, "TRACE_EXPORTED");
  assert.equal(outbound.length, 1);
  const capture = outbound[0];
  for (const sentinel of [LINE_SENTINEL, PROMPT_SENTINEL, ANSWER_SENTINEL, DOCUMENT_SENTINEL, TOOL_SENTINEL]) {
    assert.equal(capture.includes(sentinel), false, `Optional trace leaked: ${sentinel}`);
  }
  assert.deepEqual(JSON.parse(capture).payload, {
    schema: "neurohands-agent-run-audit-handle-v1",
    run_id: "run-1",
    status: "completed",
  });
});
