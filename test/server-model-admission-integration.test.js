"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const PRIVATE_MARKER = "private-prompt-must-not-enter-admission-metadata";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("the server model seam preserves admission identity and terminal lifecycle safety", { concurrency: false }, async (t) => {
  const serverPath = require.resolve("../src/server");
  const lifecyclePath = require.resolve("../src/lib/model-dispatch-lifecycle");
  const originalServerEntry = require.cache[serverPath];
  const originalLifecycleEntry = require.cache[lifecyclePath];
  const originalLifecycleExports = originalLifecycleEntry?.exports;
  const originalFetch = globalThis.fetch;
  const envValues = {
    LINE_CHANNEL_SECRET: "synthetic-line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "synthetic-line-token",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    SUPABASE_URL: "https://database.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_synthetic-only",
    GEMINI_API_KEY: "synthetic-gemini-key",
    GEMINI_ENABLED: "true",
    GEMINI_MODEL: "fixture-gemini-model",
    FOUNDER_LINE_ID: "synthetic-founder",
    NEUROHANDS_API_KEY: "synthetic-api-key",
    CRON_SECRET: "synthetic-cron-secret",
    FALLBACK_PROVIDER: "groq",
    FALLBACK_API_KEY: "synthetic-fallback-key",
    FALLBACK_MODEL: "fixture-fallback-model",
    FALLBACK_MODELS: "",
    FALLBACK_BASE_URL: "",
    ENABLE_STUDIO: "false",
    SOFTWARE_ADMISSION_ENABLED: "false",
  };
  const originalEnv = Object.fromEntries(
    Object.keys(envValues).map((key) => [key, process.env[key]])
  );

  let behavior = "success";
  let terminalCode = null;
  const lifecycleCalls = [];
  let fetchCalls = 0;
  let fetchImpl = async () => new Response(JSON.stringify({ usable: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  async function controlledDispatch(input) {
    const { execute, ...metadata } = input;
    lifecycleCalls.push(metadata);
    if (behavior === "denied") {
      return { ok: false, code: "INCOMPATIBLE", phase: "admission" };
    }
    if (behavior === "terminal") {
      return {
        ok: false,
        code: terminalCode,
        phase: "settlement",
        value: { leaked: PRIVATE_MARKER },
      };
    }
    const outcome = await execute();
    if (outcome?.type === "completed") {
      return { ok: true, code: "MODEL_COMPLETED", value: outcome.value };
    }
    return {
      ok: false,
      code: `MODEL_${String(outcome?.type || "invalid_result").toUpperCase()}`,
      phase: "settlement",
    };
  }

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete require.cache[serverPath];
    if (originalServerEntry) require.cache[serverPath] = originalServerEntry;
    if (originalLifecycleEntry) {
      originalLifecycleEntry.exports = originalLifecycleExports;
      require.cache[lifecyclePath] = originalLifecycleEntry;
    } else {
      delete require.cache[lifecyclePath];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  Object.assign(process.env, envValues);
  const realLifecycle = require(lifecyclePath);
  require.cache[lifecyclePath].exports = {
    ...realLifecycle,
    dispatchAdmittedModel: controlledDispatch,
  };
  delete require.cache[serverPath];
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };

  const { askAI, askGeminiWithTools, requestModelJson, runAgent, modelExecutionIdentity, modelPromptTimestamp } = require(serverPath);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/fixture-gemini-model:generateContent";
  const headers = { "Content-Type": "application/json", "x-goog-api-key": "synthetic-gemini-key" };
  const lanes = [
    { lane: "public", suffix: "concierge", phase: "plain", step: 0, executionId: "run-public-001" },
    { lane: "frontline", suffix: "frontline", phase: "tool", step: 2, executionId: "run-frontline-002" },
    { lane: "operator", suffix: "operator", phase: "tool", step: 3, executionId: "run-operator-003" },
  ];

  await t.test("public, frontline and operator lanes produce stable privacy-safe admission metadata", async () => {
    behavior = "success";
    const beforeCalls = lifecycleCalls.length;
    const beforeFetches = fetchCalls;

    for (const item of lanes) {
      const body = {
        system_instruction: { parts: [{ text: `${PRIVATE_MARKER}-${item.lane}` }] },
        contents: [{ role: "user", parts: [{ text: `question-${item.lane}` }] }],
      };
      const data = await requestModelJson(
        "Gemini", endpoint, headers, body, "fixture-gemini-model",
        (value) => value?.usable === true,
        item
      );
      assert.deepEqual(data, { usable: true });

      const call = lifecycleCalls.at(-1);
      assert.equal(call.actionId, `model.gemini.${item.suffix}`);
      assert.equal(call.runId, item.executionId);
      assert.equal(call.requestFingerprint, sha256(JSON.stringify({
        provider: "gemini",
        model: "fixture-gemini-model",
        body,
      })));
      assert.match(call.requestFingerprint, /^[a-f0-9]{64}$/);
      assert.match(call.actionKey, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/);
      assert.match(call.actionKey, new RegExp(`\\.${item.lane}\\.${item.phase}\\.${item.step}\\.gemini\\.`));
      assert.equal(call.actionKey.includes(item.executionId), false);
      assert.equal(call.actionKey.includes("fixture-gemini-model"), false);
      assert.equal(JSON.stringify(call).includes(PRIVATE_MARKER), false);
      assert.equal(JSON.stringify(call).includes("synthetic-gemini-key"), false);
    }

    assert.equal(lifecycleCalls.length - beforeCalls, lanes.length);
    assert.equal(fetchCalls - beforeFetches, lanes.length);
  });

  await t.test("an admission denial performs no provider request", async () => {
    behavior = "denied";
    const beforeFetches = fetchCalls;
    const result = await requestModelJson(
      "Gemini", endpoint, headers, { contents: [{ role: "user", parts: [{ text: "denied" }] }] },
      "fixture-gemini-model", () => true,
      { lane: "frontline", phase: "plain", step: 0, executionId: "run-denied-004" }
    );
    assert.equal(result, null);
    assert.equal(fetchCalls, beforeFetches);
  });

  await t.test("terminal settlement and replay failures throw without exposing a helper value", async () => {
    behavior = "terminal";
    for (const code of [
      "LIFECYCLE_SETTLEMENT_FAILED", "IDEMPOTENT_REPLAY", "MODEL_DISPATCH_REPLAY",
      "ALREADY_DISPATCHED", "ALREADY_SETTLED", "RECONCILIATION_REQUIRED",
      "IDEMPOTENCY_CONFLICT", "DISPATCH_CONFLICT", "SETTLEMENT_CONFLICT",
      "TRANSPORT_UNCERTAIN", "MODEL_TRANSPORT_ERROR", "MODEL_TIMEOUT",
    ]) {
      terminalCode = code;
      const beforeFetches = fetchCalls;
      await assert.rejects(
        requestModelJson(
          "Gemini", endpoint, headers,
          { contents: [{ role: "user", parts: [{ text: `${PRIVATE_MARKER}-${code}` }] }] },
          "fixture-gemini-model", () => true,
          { lane: "operator", phase: "tool", step: 7, executionId: `run-terminal-${sha256(code).slice(0, 8)}` }
        ),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.message, "Model allowance lifecycle could not be verified");
          assert.equal(String(error.stack).includes(PRIVATE_MARKER), false);
          assert.equal(JSON.stringify(error).includes(PRIVATE_MARKER), false);
          return true;
        },
        `Expected ${code} to stop the model request`
      );
      assert.equal(fetchCalls, beforeFetches);
    }
  });

  await t.test("a replay, conflict or uncertain primary result stops the complete request before fallback", async () => {
    behavior = "terminal";
    for (const code of [
      "ALREADY_DISPATCHED", "ALREADY_SETTLED", "RECONCILIATION_REQUIRED",
      "IDEMPOTENCY_CONFLICT", "DISPATCH_CONFLICT", "SETTLEMENT_CONFLICT",
      "TRANSPORT_UNCERTAIN", "MODEL_TRANSPORT_ERROR", "MODEL_TIMEOUT",
    ]) {
      terminalCode = code;
      const beforeLifecycle = lifecycleCalls.length;
      const beforeFetches = fetchCalls;
      await assert.rejects(
        askAI("Synthetic fixed system prompt", "Synthetic fixed user prompt", {
          lane: "public",
          executionId: `line:fixture-event-${sha256(code).slice(0, 8)}`,
        }),
        (error) => error?.code === code,
        `Expected ${code} to stop before fallback`
      );
      assert.equal(lifecycleCalls.length, beforeLifecycle + 1, "Fallback admission must not start");
      assert.equal(fetchCalls, beforeFetches, "Neither primary nor fallback transport may run");
    }
  });

  await t.test("durable LINE identity and event time remain stable when database run IDs change", () => {
    const first = { webhookEventId: "line-event-replay-001", eventTimestamp: 1_800_000_000_000 };
    const replay = { webhookEventId: "line-event-replay-001", eventTimestamp: 1_800_000_000_000 };
    assert.equal(modelExecutionIdentity(first, 101), "line:line-event-replay-001");
    assert.equal(modelExecutionIdentity(replay, 202), "line:line-event-replay-001");
    assert.equal(modelPromptTimestamp(first), modelPromptTimestamp(replay));
    assert.equal(modelExecutionIdentity({}, 303), 303);
  });

  await t.test("the tool loop uses durable LINE identity instead of each replay's new run row", async () => {
    behavior = "success";
    fetchImpl = async () => new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "fixed answer" }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const event = { webhookEventId: "line-event-tool-replay-002", eventTimestamp: 1_800_000_100_000 };
    const system = `Fixed system time: ${modelPromptTimestamp(event)}`;
    const beforeCalls = lifecycleCalls.length;
    for (const databaseRunId of [401, 902]) {
      const result = await askGeminiWithTools(system, "fixed request", [], {}, databaseRunId, {
        admissionContext: {
          lane: "frontline",
          executionId: modelExecutionIdentity(event, databaseRunId),
        },
      });
      assert.equal(result.text, "fixed answer");
    }
    const [first, replay] = lifecycleCalls.slice(beforeCalls);
    assert.equal(first.runId, "line:line-event-tool-replay-002");
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.actionKey, first.actionKey);
    assert.equal(replay.requestFingerprint, first.requestFingerprint);
  });

  await t.test("replayed LINE agent runs keep one model identity despite new evidence rows", async () => {
    behavior = "success";
    const databaseRunIds = [501, 902];
    const insertedRuns = [];
    fetchImpl = async (address, options = {}) => {
      const url = new URL(String(address));
      if (url.hostname === "generativelanguage.googleapis.com") {
        return new Response(JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "stable answer" }] } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(url.hostname, "database.invalid");
      const table = url.pathname.slice("/rest/v1/".length);
      if (table === "client_agent_bindings") {
        return new Response(JSON.stringify([{ client_account_id: 77, department: "sales", status: "active" }]), { status: 200 });
      }
      if (table === "client_accounts") {
        return new Response(JSON.stringify([{ id: 77, active: true }]), { status: 200 });
      }
      if (table === "agent_memory") return new Response("[]", { status: 200 });
      if (table === "agent_runs" && options.method === "POST") {
        const id = databaseRunIds[insertedRuns.length];
        insertedRuns.push({ id, ...JSON.parse(options.body) });
        return new Response(JSON.stringify([{ id }]), { status: 201 });
      }
      if (table === "agent_runs" && options.method === "PATCH") {
        const id = Number(url.searchParams.get("id")?.slice(3));
        return new Response(JSON.stringify([{ id }]), { status: 200 });
      }
      throw new Error(`Unexpected integration request: ${url.pathname}`);
    };
    const agent = {
      agent_code: "AGT-001",
      agent_name: "Sales agent",
      callsign: "Aria",
      objective: "Answer the fixed request",
      allowed_tools: [],
      domains: [],
      responsibilities: [],
    };
    const eventContext = { webhookEventId: "durable-line-event-003", eventTimestamp: 1_800_000_200_000 };
    const beforeCalls = lifecycleCalls.length;
    for (const _run of databaseRunIds) {
      const ctx = { lineUserId: "fixture-client", clientAccountId: 77, department: "sales", ...eventContext };
      assert.equal(await runAgent(ctx, "same LINE request", agent), "stable answer");
      assert.equal(ctx.runStatus, "completed");
    }
    assert.deepEqual(insertedRuns.map((row) => row.id), databaseRunIds);
    const [first, replay] = lifecycleCalls.slice(beforeCalls);
    assert.equal(first.runId, "line:durable-line-event-003");
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.actionKey, first.actionKey);
    assert.equal(replay.requestFingerprint, first.requestFingerprint);
  });

  await t.test("a successful helper executes transport and returns only usable provider data", async () => {
    behavior = "success";
    fetchImpl = async (_url, options) => {
      const sent = JSON.parse(options.body);
      assert.equal(sent.contents[0].parts[0].text, "successful request");
      return new Response(JSON.stringify({ usable: true, answer: 17 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const beforeFetches = fetchCalls;
    const result = await requestModelJson(
      "Gemini", endpoint, headers,
      { contents: [{ role: "user", parts: [{ text: "successful request" }] }] },
      "fixture-gemini-model", (value) => value?.answer === 17,
      { lane: "frontline", phase: "tool", step: 8, executionId: "run-success-005" }
    );
    assert.deepEqual(result, { usable: true, answer: 17 });
    assert.equal(fetchCalls, beforeFetches + 1);
  });

  await t.test("a permanent provider latch is checked before the lifecycle helper", async () => {
    behavior = "success";
    fetchImpl = async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const beforeLifecycle = lifecycleCalls.length;
    const beforeFetches = fetchCalls;
    const context = { lane: "public", phase: "plain", step: 9, executionId: "run-latch-006" };
    assert.equal(await requestModelJson(
      "Gemini", endpoint, headers,
      { contents: [{ role: "user", parts: [{ text: "first authentication failure" }] }] },
      "fixture-gemini-model", () => true, context
    ), null);
    assert.equal(lifecycleCalls.length, beforeLifecycle + 1);
    assert.equal(fetchCalls, beforeFetches + 1);

    assert.equal(await requestModelJson(
      "Gemini", endpoint, headers,
      { contents: [{ role: "user", parts: [{ text: "must be blocked before admission" }] }] },
      "fixture-gemini-model", () => true,
      { ...context, step: 10, executionId: "run-latch-007" }
    ), null);
    assert.equal(lifecycleCalls.length, beforeLifecycle + 1);
    assert.equal(fetchCalls, beforeFetches + 1);
  });
});
