import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";

import {
  AGENT_PROFILES,
  AGENT_PROFILE_BY_ID,
  getAgentProfile,
  validateAgentProfiles,
} from "../src/agent/profiles.mjs";
import {
  MAX_WORKFLOW_OBJECTIVE_CHARACTERS,
  WORKFLOW_TEMPLATES,
  WorkflowAuthorizationError,
  createWorkflowRunner,
  getWorkflowTemplate,
  validateWorkflowTemplates,
} from "../src/agent/workflow.mjs";

const PROFILE_CONTRACT = Object.freeze([
  Object.freeze({ agentId: "sales-suri", displayName: "Suri", departmentId: "sales", role: "aria",
    responsibilities: Object.freeze(["Gather client requirements", "Prepare a grounded quotation brief"]) }),
  Object.freeze({ agentId: "marketing-mira", displayName: "Mira", departmentId: "marketing", role: "aria",
    responsibilities: Object.freeze(["Turn verified requirements into an evidence-grounded proposal"]) }),
  Object.freeze({ agentId: "it-ivo", displayName: "Ivo", departmentId: "it", role: "aria",
    responsibilities: Object.freeze(["Check connector readiness", "Verify tool permissions and client boundaries"]) }),
  Object.freeze({ agentId: "backend-beck", displayName: "Beck", departmentId: "backend-engineering", role: "aria",
    responsibilities: Object.freeze(["Design idempotent CRM persistence", "Define recoverable backend delivery steps"]) }),
  Object.freeze({ agentId: "ai-qa-quinn", displayName: "Quinn", departmentId: "ai-engineering-quality", role: "jarvis",
    responsibilities: Object.freeze(["Perform evidence-based quality checks", "Issue the final verified result or a concrete blocker"]) }),
]);

const TEMPLATE_CONTRACT = Object.freeze({
  individual: Object.freeze([
    Object.freeze({ stepId: "requirements_quote", agentId: "sales-suri", dependsOn: Object.freeze([]),
      allowedTools: Object.freeze(["lookup_company", "calculate", "get_order_status", "read_document", "list_tasks", "create_task"]) }),
  ]),
  pair: Object.freeze([
    Object.freeze({ stepId: "requirements_quote", agentId: "sales-suri", dependsOn: Object.freeze([]),
      allowedTools: Object.freeze(["read_document", "calculate"]) }),
    Object.freeze({ stepId: "final_verification", agentId: "ai-qa-quinn", dependsOn: Object.freeze(["requirements_quote"]),
      allowedTools: Object.freeze(["read_document", "calculate"]) }),
  ]),
  full_department: Object.freeze([
    Object.freeze({ stepId: "requirements_quote", agentId: "sales-suri", dependsOn: Object.freeze([]),
      allowedTools: Object.freeze(["read_document", "calculate"]) }),
    Object.freeze({ stepId: "marketing_proposal", agentId: "marketing-mira", dependsOn: Object.freeze(["requirements_quote"]),
      allowedTools: Object.freeze(["lookup_company", "read_document", "calculate"]) }),
    Object.freeze({ stepId: "connector_permission_review", agentId: "it-ivo", dependsOn: Object.freeze(["marketing_proposal"]),
      allowedTools: Object.freeze(["read_document", "list_tasks"]) }),
    Object.freeze({ stepId: "crm_persistence_design", agentId: "backend-beck", dependsOn: Object.freeze(["connector_permission_review"]),
      allowedTools: Object.freeze(["list_tasks", "create_task", "remember", "recall", "calculate"]) }),
    Object.freeze({ stepId: "final_verification", agentId: "ai-qa-quinn", dependsOn: Object.freeze(["crm_persistence_design"]),
      allowedTools: Object.freeze(["read_document", "calculate"]) }),
  ]),
});

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

async function fixture(t, {
  agentInvoker,
  toolExecutor,
  modelFactory,
  authorizedClientIds = ["client-fixture-a", "client-fixture-b"],
  defaultAgent = false,
  now,
} = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), "neurohands-named-workflow-"));
  let modelCalls = 0;
  let toolCalls = 0;
  let id = 0;
  let timestamp = Date.parse("2026-09-16T12:00:00.000Z");
  const runner = createWorkflowRunner({
    storageDir,
    authorizedClientIds,
    now: now || (() => new Date(timestamp += 1000).toISOString()),
    idFactory: (prefix = "id") => `${prefix}-${++id}`,
    modelFactory(...args) {
      modelCalls += 1;
      if (modelFactory) return modelFactory(...args);
      throw new Error("A deterministic workflow test must not construct a model.");
    },
    async toolExecutor(...args) {
      toolCalls += 1;
      if (toolExecutor) return toolExecutor(...args);
      return { ok: true, receipt: `tool-${toolCalls}` };
    },
    ...(!defaultAgent ? { agentInvoker: agentInvoker || (async (profile, step) => ({
        output: `${profile.displayName} completed ${step.stepId}`,
        evidence: [{ kind: "fixture", stepId: step.stepId }],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
        toolAudit: [],
      })) } : {}),
  });
  await runner.initialize();
  t.after(async () => {
    await runner.close();
    await rm(storageDir, { recursive: true, force: true });
  });
  return {
    runner,
    storageDir,
    counts: () => ({ modelCalls, toolCalls }),
    ledgerPath: join(storageDir, "handoffs.jsonl"),
  };
}

const request = (overrides = {}) => ({
  templateId: "full_department",
  clientId: "client-fixture-a",
  workflowId: "workflow-fixture-a",
  objective: "Prepare a synthetic launch plan and verify its evidence.",
  idempotencyKey: "fixture-request-a",
  budget: {
    maxModelCalls: 20,
    maxToolCalls: 20,
    maxTokens: 10000,
    maxDurationMs: 60000,
    maxStoredBytes: 1000000,
  },
  ...overrides,
});

async function ledger(path) {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  const lines = text.trim().split("\n").filter(Boolean);
  return { bytes, text, records: lines.map((line) => JSON.parse(line)) };
}

async function eventually(check, message) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function fileBytes(path) {
  try { return (await readFile(path)).byteLength; }
  catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

const modelToolCall = (name, args, id = "fixture-call") => new AIMessage({
  content: "",
  tool_calls: [{ name, args, id, type: "tool_call" }],
});

function fakeModelFactory(responses) {
  let index = 0;
  return () => ({
    bindTools() { return this; },
    async invoke(messages) {
      const response = responses[Math.min(index++, responses.length - 1)];
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(messages, index) : response;
    },
  });
}

test("the named registry contains exactly the five fixed, validated, deeply frozen profiles", () => {
  assert.deepEqual(AGENT_PROFILES.map(({ agentId, displayName, departmentId, role, responsibilities }) =>
    ({ agentId, displayName, departmentId, role, responsibilities })), PROFILE_CONTRACT);
  assert.equal(Object.getPrototypeOf(AGENT_PROFILE_BY_ID), null);
  assert.deepEqual(Object.keys(AGENT_PROFILE_BY_ID), PROFILE_CONTRACT.map(({ agentId }) => agentId));
  assert.equal(new Set(AGENT_PROFILES.map(({ agentId }) => agentId)).size, 5);
  assert.equal(new Set(AGENT_PROFILES.map(({ departmentId }) => departmentId)).size, 5);
  assertDeepFrozen(AGENT_PROFILES);
  assertDeepFrozen(AGENT_PROFILE_BY_ID);
  assert.throws(() => { AGENT_PROFILES[0].displayName = "Changed"; }, TypeError);
  assert.throws(() => { AGENT_PROFILES[0].allowedTools.push("calculate"); }, TypeError);
  assert.doesNotThrow(() => validateAgentProfiles(AGENT_PROFILES));
  for (const expected of PROFILE_CONTRACT) assert.equal(getAgentProfile(expected.agentId), AGENT_PROFILE_BY_ID[expected.agentId]);
  assert.throws(() => getAgentProfile("unknown-agent"), /unknown|agent/i);

  const duplicate = structuredClone(AGENT_PROFILES);
  duplicate[1].agentId = duplicate[0].agentId;
  assert.throws(() => validateAgentProfiles(duplicate), /duplicate|unique/i);
  assert.throws(() => validateAgentProfiles(structuredClone(AGENT_PROFILES).slice(0, 4)), /five|5|profile/i);
  const badTool = structuredClone(AGENT_PROFILES);
  badTool[0].allowedTools.push("not-a-registered-tool");
  assert.throws(() => validateAgentProfiles(badTool), /tool|allow/i);
});

test("individual, pair and full-department templates use unique agents in the required order", () => {
  assert.deepEqual(Object.keys(WORKFLOW_TEMPLATES), Object.keys(TEMPLATE_CONTRACT));
  assertDeepFrozen(WORKFLOW_TEMPLATES);
  for (const [templateId, expected] of Object.entries(TEMPLATE_CONTRACT)) {
    const template = getWorkflowTemplate(templateId);
    assert.equal(template, WORKFLOW_TEMPLATES[templateId]);
    assert.deepEqual(template.steps.map(({ stepId, agentId, dependsOn, allowedTools }) => ({ stepId, agentId, dependsOn, allowedTools })), expected);
    assert.equal(new Set(template.steps.map(({ agentId }) => agentId)).size, template.steps.length);
  }
  assert.throws(() => getWorkflowTemplate("invented-template"), /unknown|template/i);
});

test("workflow template validation requires unique, registered, profile-authorized step tools", () => {
  const missing = structuredClone(WORKFLOW_TEMPLATES);
  delete missing.pair.steps[0].allowedTools;
  assert.throws(() => validateWorkflowTemplates(missing), /allowedTools|unsupported fields/i);

  const unknown = structuredClone(WORKFLOW_TEMPLATES);
  unknown.pair.steps[0].allowedTools = ["invented_admin_tool"];
  assert.throws(() => validateWorkflowTemplates(unknown), /unknown tool/i);

  const outsideProfile = structuredClone(WORKFLOW_TEMPLATES);
  outsideProfile.pair.steps[0].allowedTools = ["remember"];
  assert.throws(() => validateWorkflowTemplates(outsideProfile), /not authorized|sales-suri/i);

  const duplicate = structuredClone(WORKFLOW_TEMPLATES);
  duplicate.pair.steps[0].allowedTools = ["calculate", "calculate"];
  assert.throws(() => validateWorkflowTemplates(duplicate), /duplicate/i);
});

test("wrong tool, client and recipient identities are denied before tool execution", async (t) => {
  const denials = [];
  const f = await fixture(t, { agentInvoker: async (profile, step, context) => {
    const allowed = profile.allowedTools[0];
    const attempt = context.objective.includes("tool")
      ? () => context.executeTool({ name: "invented_admin_tool", args: {} })
      : context.objective.includes("client")
        ? () => context.executeTool({ name: allowed, args: {}, clientId: "different-client" })
        : () => context.handoff({ toAgentId: "marketing-mira", evidence: [{ forbidden: true }] });
    try {
      await attempt();
      assert.fail("The unauthorized operation unexpectedly resolved.");
    } catch (error) {
      denials.push(error);
      assert.equal(error instanceof WorkflowAuthorizationError, true);
      assert.equal(error.code, "WORKFLOW_AUTHORIZATION_DENIED");
      assert.match(error.message, /authorization denied/i);
    }
    // Catching a denial must not let an agent turn it into a successful step.
    return {
      output: `${step.stepId} tried an unauthorized operation`, evidence: [], toolAudit: [],
      metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
    };
  } });

  const cases = [
    ["tool", "auth-tool", "workflow-auth-tool"],
    ["client", "auth-client", "workflow-auth-client"],
    ["recipient", "auth-recipient", "workflow-auth-recipient"],
  ];
  for (const [objective, idempotencyKey, workflowId] of cases) {
    const result = await f.runner.run(request({ templateId: "individual", objective, idempotencyKey, workflowId }));
    assert.equal(result.status, "failed");
    assert.equal(result.steps[0].status, "failed");
  }
  assert.equal(denials.length, 3);
  assert.deepEqual(f.counts(), { modelCalls: 0, toolCalls: 0 });
  const recipientRecords = await f.runner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-auth-recipient" });
  assert.equal(recipientRecords.some(({ recordType }) => recordType === "handoff"), false);
});

test("full-department step scopes deny sales task and order tools while allowing Beck to create a task", async (t) => {
  const deniedTools = [];
  let deniedExecutorCalls = 0;
  const denied = await fixture(t, {
    toolExecutor: async () => { deniedExecutorCalls += 1; return { ok: true }; },
    agentInvoker: async (profile, step, context) => {
      if (profile.agentId === "sales-suri") {
        const name = context.objective.includes("order") ? "get_order_status" : "create_task";
        assert.deepEqual(context.allowedTools, ["read_document", "calculate"]);
        try {
          await context.executeTool({ name, args: {} });
          assert.fail(`${name} unexpectedly passed the full-department sales step scope.`);
        } catch (error) {
          deniedTools.push(name);
          assert.equal(error instanceof WorkflowAuthorizationError, true);
        }
      }
      return {
        output: `${profile.agentId} completed its synthetic step`, evidence: [], toolAudit: [],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
      };
    },
  });
  for (const [objective, workflowId, idempotencyKey] of [
    ["attempt sales create task", "workflow-sales-create-denied", "sales-create-denied"],
    ["attempt sales order lookup", "workflow-sales-order-denied", "sales-order-denied"],
  ]) {
    const result = await denied.runner.run(request({ templateId: "full_department", objective, workflowId, idempotencyKey }));
    assert.equal(result.status, "failed");
    assert.equal(result.steps[0].status, "failed");
    assert.equal(result.steps[0].toolAudit[0].status, "denied");
  }
  assert.deepEqual(deniedTools.sort(), ["create_task", "get_order_status"]);
  assert.equal(deniedExecutorCalls, 0);

  const executorContexts = [];
  const allowed = await fixture(t, {
    toolExecutor: async (name, args, fixedContext) => {
      executorContexts.push({ name, args, fixedContext });
      return { ok: true, taskId: "task-beck-1" };
    },
    agentInvoker: async (profile, step, context) => {
      if (profile.agentId === "backend-beck") {
        assert.ok(context.allowedTools.includes("create_task"));
        await context.executeTool({ name: "create_task", args: { title: "Synthetic CRM persistence task" } });
      }
      return {
        output: `${profile.agentId} completed its synthetic step`, evidence: [], toolAudit: [],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
      };
    },
  });
  const completed = await allowed.runner.run(request({
    templateId: "full_department", workflowId: "workflow-beck-create-allowed", idempotencyKey: "beck-create-allowed",
  }));
  assert.equal(completed.status, "completed");
  const beck = completed.steps.find(({ agentId }) => agentId === "backend-beck");
  assert.deepEqual(beck.toolAudit.map(({ name, status }) => ({ name, status })), [{ name: "create_task", status: "completed" }]);
  assert.equal(executorContexts.length, 1);
  assert.equal(executorContexts[0].fixedContext.agentId, "backend-beck");
  assert.deepEqual(executorContexts[0].fixedContext.allowedTools, ["list_tasks", "create_task", "remember", "recall", "calculate"]);
});

test("default named agents receive only the tools authorized for their fixed workflow step", async (t) => {
  const boundToolNames = [];
  const f = await fixture(t, {
    defaultAgent: true,
    modelFactory: () => ({
      bindTools(definitions) {
        boundToolNames.push(definitions.map(({ function: definition }) => definition.name));
        return this;
      },
      async invoke() {
        return new AIMessage({
          content: "Synthetic step completed without a tool call.",
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    }),
  });
  const result = await f.runner.run(request({
    templateId: "full_department", workflowId: "workflow-default-step-scopes", idempotencyKey: "default-step-scopes",
  }));
  assert.equal(result.status, "completed");
  assert.deepEqual(boundToolNames.map((names) => [...names].sort()),
    WORKFLOW_TEMPLATES.full_department.steps.map(({ allowedTools }) => [...allowedTools].sort()));
});

test("a two-agent workflow records queued, running, handoff and completed lifecycle state", async (t) => {
  const seenEvidence = [];
  const f = await fixture(t, { agentInvoker: async (profile, step, context) => {
    if (profile.agentId === "sales-suri") {
      const evidence = [{ fact: "Synthetic requirement R-17", source: "fixture" }];
      await context.handoff({ toAgentId: "ai-qa-quinn", evidence });
      return {
        output: "Requirements and quote prepared.", evidence, toolAudit: [],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 3 },
      };
    }
    seenEvidence.push(...context.evidence);
    return {
      output: "Evidence verified.", evidence: [{ verified: true }], toolAudit: [],
      metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 2 },
    };
  } });
  const result = await f.runner.run(request({
    templateId: "pair", workflowId: "workflow-lifecycle", idempotencyKey: "lifecycle-request",
  }));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.steps.map(({ agentId, status, certainty }) => ({ agentId, status, certainty })), [
    { agentId: "sales-suri", status: "completed", certainty: "confirmed" },
    { agentId: "ai-qa-quinn", status: "completed", certainty: "confirmed" },
  ]);
  assert.equal(seenEvidence.length, 1);
  assert.equal(seenEvidence[0].fromAgentId, "sales-suri");
  assert.equal(seenEvidence[0].toAgentId, "ai-qa-quinn");
  assert.equal(seenEvidence[0].fromStepId, "requirements_quote");
  assert.equal(seenEvidence[0].toStepId, "final_verification");
  assert.deepEqual(seenEvidence[0].evidence, [{ fact: "Synthetic requirement R-17", source: "fixture" }]);
  assert.match(seenEvidence[0].evidenceDigest, /^[a-f0-9]{64}$/);

  const file = await ledger(f.ledgerPath);
  assert.equal(file.text.endsWith("\n"), true, "The lifecycle log must remain valid append-only JSONL.");
  assert.equal(file.bytes.byteLength, (await stat(f.ledgerPath)).size);
  assert.deepEqual(file.records.filter(({ recordType, agentId }) => recordType === "step" && agentId === "sales-suri")
    .map(({ status }) => status), ["queued", "running", "completed"]);
  assert.deepEqual(file.records.filter(({ recordType, agentId }) => recordType === "step" && agentId === "ai-qa-quinn")
    .map(({ status }) => status), ["queued", "running", "completed"]);
  const handoffs = file.records.filter(({ recordType }) => recordType === "handoff");
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].status, "completed");
  assert.match(JSON.stringify(handoffs[0]), /sales-suri/);
  assert.match(JSON.stringify(handoffs[0]), /ai-qa-quinn/);
  assert.match(JSON.stringify(handoffs[0]), /Synthetic requirement R-17/);
  assert.ok(file.records.every(({ workflowId, clientId, templateId }) =>
    workflowId === "workflow-lifecycle" && clientId === "client-fixture-a" && templateId === "pair"));
  assert.deepEqual(f.counts(), { modelCalls: 0, toolCalls: 0 });
});

test("a completed idempotent rerun returns the stored result without invoking agents or appending bytes", async (t) => {
  let invocations = 0;
  const f = await fixture(t, { agentInvoker: async (profile, step) => {
    invocations += 1;
    return {
      output: `${profile.displayName}: ${step.stepId}`, evidence: [{ invocation: invocations }], toolAudit: [],
      metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
    };
  } });
  const input = request({ templateId: "individual", workflowId: "workflow-idempotent", idempotencyKey: "stable-key" });
  const first = await f.runner.run(input);
  const before = await readFile(f.ledgerPath);
  const duplicate = await f.runner.run(structuredClone(input));
  const after = await readFile(f.ledgerPath);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.workflowId, first.workflowId);
  assert.equal(duplicate.status, "completed");
  assert.equal(invocations, 1);
  assert.deepEqual(after, before);
  await assert.rejects(() => f.runner.run({ ...input, objective: "Different work with the same key" }), /idempotency|different|collision/i);
  assert.deepEqual(await readFile(f.ledgerPath), before);
  assert.deepEqual(f.counts(), { modelCalls: 0, toolCalls: 0 });
});

test("startup recovery marks an interrupted running step failed with uncertain certainty", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "neurohands-named-recovery-"));
  const ledgerPath = join(storageDir, "handoffs.jsonl");
  const base = {
    schemaVersion: 1,
    requestDigest: "a".repeat(64),
    idempotencyKey: "interrupted-key",
    workflowId: "workflow-interrupted",
    templateId: "pair",
    clientId: "client-fixture-a",
    certainty: "confirmed",
  };
  const seeded = [
    { ...base, recordId: "seed-1", recordType: "step", timestamp: "2026-09-16T12:00:00.000Z",
      stepId: "requirements_quote", agentId: "sales-suri", departmentId: "sales", status: "queued" },
    { ...base, recordId: "seed-2", recordType: "step", timestamp: "2026-09-16T12:00:01.000Z",
      stepId: "final_verification", agentId: "ai-qa-quinn", departmentId: "ai-engineering-quality", status: "queued" },
    { ...base, recordId: "seed-3", recordType: "step", timestamp: "2026-09-16T12:00:02.000Z",
      stepId: "requirements_quote", agentId: "sales-suri", departmentId: "sales", status: "running" },
  ];
  await writeFile(ledgerPath, `${seeded.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  let id = 100;
  const recoveredRunner = createWorkflowRunner({
    storageDir,
    authorizedClientIds: ["client-fixture-a"],
    now: () => "2026-09-16T13:00:00.000Z",
    idFactory: (prefix = "id") => `${prefix}-recovery-${++id}`,
    modelFactory() { throw new Error("Recovery must not construct a model."); },
    toolExecutor() { throw new Error("Recovery must not execute a tool."); },
    agentInvoker() { throw new Error("Recovery must not restart uncertain work."); },
  });
  t.after(async () => {
    await recoveredRunner.close();
    await rm(storageDir, { recursive: true, force: true });
  });
  await recoveredRunner.initialize();
  const afterFirstRecovery = await readFile(ledgerPath);
  await recoveredRunner.recover();
  assert.deepEqual(await readFile(ledgerPath), afterFirstRecovery, "Recovery must itself be idempotent.");
  const records = await recoveredRunner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-interrupted" });
  const uncertain = records.find(({ recordType, stepId, status, certainty }) =>
    recordType === "recovery" && stepId === "requirements_quote" && status === "failed" && certainty === "uncertain");
  assert.ok(uncertain, "A persisted running step needs an explicit uncertain recovery record.");
  assert.ok(records.some(({ stepId, status }) => stepId === "final_verification" && status === "blocked"));
});

test("a failed step blocks every dependent step without invoking it", async (t) => {
  const invoked = [];
  const f = await fixture(t, { agentInvoker: async (profile, step) => {
    invoked.push(profile.agentId);
    if (profile.agentId === "marketing-mira") throw new Error("synthetic fixture failure");
    return {
      output: `${step.stepId} completed`, evidence: [{ stepId: step.stepId }], toolAudit: [],
      metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 2 },
    };
  } });
  const result = await f.runner.run(request({ workflowId: "workflow-failed", idempotencyKey: "failed-key" }));
  assert.equal(result.status, "failed");
  assert.deepEqual(invoked, ["sales-suri", "marketing-mira"]);
  assert.deepEqual(result.steps.map(({ status }) => status), ["completed", "failed", "blocked", "blocked", "blocked"]);
  assert.deepEqual(result.steps.slice(2).map(({ agentId }) => agentId), ["it-ivo", "backend-beck", "ai-qa-quinn"]);
  assert.deepEqual(result.metrics, {
    ...result.metrics,
    completedSteps: 1,
    failedSteps: 1,
    blockedSteps: 3,
  });
  const records = await f.runner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-failed" });
  assert.deepEqual(records.filter(({ recordType, status }) => recordType === "step" && status === "blocked")
    .map(({ agentId }) => agentId), ["it-ivo", "backend-beck", "ai-qa-quinn"]);
  assert.deepEqual(f.counts(), { modelCalls: 0, toolCalls: 0 });
});

test("run metrics aggregate agent time, token use, step counts and exact persisted JSONL bytes", async (t) => {
  const synthetic = {
    "sales-suri": { modelCalls: 1, toolCalls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, durationMs: 12 },
    "ai-qa-quinn": { modelCalls: 2, toolCalls: 2, inputTokens: 80, outputTokens: 30, totalTokens: 110, durationMs: 18 },
  };
  const f = await fixture(t, { agentInvoker: async (profile, step, context) => {
    if (profile.agentId === "sales-suri") {
      await context.handoff({ toAgentId: "ai-qa-quinn", evidence: [{ artifact: "quote-v1", bytes: 321 }] });
    }
    for (let index = 0; index < synthetic[profile.agentId].toolCalls; index += 1) {
      await context.executeTool({ name: step.allowedTools[0], args: { fixtureCall: index + 1 } });
    }
    return {
      output: `${step.stepId} output`, evidence: [{ agentId: profile.agentId, stored: true }],
      metrics: synthetic[profile.agentId], toolAudit: [],
    };
  } });
  const result = await f.runner.run(request({
    templateId: "pair", workflowId: "workflow-metrics", idempotencyKey: "metrics-key",
  }));
  const size = (await stat(f.ledgerPath)).size;
  const persisted = await ledger(f.ledgerPath);
  assert.deepEqual(result.metrics, {
    modelCalls: 3,
    toolCalls: 3,
    inputTokens: 180,
    outputTokens: 50,
    totalTokens: 230,
    durationMs: 30,
    storedBytes: size,
    completedSteps: 2,
    failedSteps: 0,
    blockedSteps: 0,
  });
  assert.equal(result.metrics.storedBytes, persisted.bytes.byteLength);
  assert.equal(Buffer.byteLength(persisted.text, "utf8"), persisted.bytes.byteLength);
  assert.equal(persisted.records.length > 0, true);
  assert.deepEqual(f.counts(), { modelCalls: 0, toolCalls: 3 });
});

test("runner scope is mandatory and both runs and record reads deny unfiltered or unauthorized clients", async (t) => {
  const invalidDir = await mkdtemp(join(tmpdir(), "neurohands-invalid-scope-"));
  t.after(() => rm(invalidDir, { recursive: true, force: true }));
  assert.throws(() => createWorkflowRunner({ storageDir: invalidDir }), /authorizedClientIds|authorized client/i);
  assert.throws(() => createWorkflowRunner({ storageDir: invalidDir, authorizedClientIds: [] }), /authorizedClientIds|authorized client/i);

  const f = await fixture(t, { authorizedClientIds: ["client-fixture-a"] });
  const before = await fileBytes(f.ledgerPath);
  await assert.rejects(() => f.runner.run(request({
    clientId: "client-fixture-b", workflowId: "workflow-foreign", idempotencyKey: "foreign-key",
  })), (error) => error instanceof WorkflowAuthorizationError);
  await assert.rejects(() => f.runner.readRecords(), (error) => error instanceof WorkflowAuthorizationError);
  await assert.rejects(() => f.runner.readRecords({ clientId: "client-fixture-b" }),
    (error) => error instanceof WorkflowAuthorizationError);
  assert.equal(await fileBytes(f.ledgerPath), before);

  await f.runner.run(request({ templateId: "individual", workflowId: "workflow-owned", idempotencyKey: "owned-key" }));
  const owned = await f.runner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-owned" });
  assert.ok(owned.length > 0);
  assert.ok(owned.every(({ clientId }) => clientId === "client-fixture-a"));
});

test("foreign client identifiers nested in tool arguments are denied before the executor", async (t) => {
  let executorCalls = 0;
  const f = await fixture(t, {
    toolExecutor: async () => { executorCalls += 1; return { ok: true }; },
    agentInvoker: async (profile, step, context) => {
      await assert.rejects(() => context.executeTool({
        name: profile.allowedTools[0],
        args: { request: { records: [{ owner: { client_id: "client-fixture-b" } }] } },
      }), (error) => error instanceof WorkflowAuthorizationError);
      return {
        output: `${step.stepId} attempted foreign work`, evidence: [], toolAudit: [],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
      };
    },
  });
  const result = await f.runner.run(request({
    templateId: "individual", workflowId: "workflow-nested-foreign", idempotencyKey: "nested-foreign-key",
  }));
  assert.equal(result.status, "failed");
  assert.equal(executorCalls, 0);
  assert.equal(result.steps[0].toolAudit[0].status, "denied");
});

test("idempotency keys are global within an authorized client and independent across clients", async (t) => {
  let invocations = 0;
  const f = await fixture(t, { agentInvoker: async () => {
    invocations += 1;
    return {
      output: `invocation-${invocations}`, evidence: [{ invocation: invocations }], toolAudit: [],
      metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
    };
  } });
  const a = request({ templateId: "individual", clientId: "client-fixture-a", workflowId: "workflow-client-a", idempotencyKey: "shared-key" });
  const b = request({ templateId: "individual", clientId: "client-fixture-b", workflowId: "workflow-client-b", idempotencyKey: "shared-key" });
  const firstA = await f.runner.run(a);
  const firstB = await f.runner.run(b);
  assert.equal(firstA.status, "completed");
  assert.equal(firstB.status, "completed");
  assert.notEqual(firstA.workflowId, firstB.workflowId);
  assert.equal((await f.runner.run(structuredClone(a))).duplicate, true);
  assert.equal((await f.runner.run(structuredClone(b))).duplicate, true);
  assert.equal(invocations, 2);
  await assert.rejects(() => f.runner.run({ ...a, objective: "A conflicting request for client A" }), /idempotency|different|collision/i);
  const recordsA = await f.runner.readRecords({ clientId: "client-fixture-a", idempotencyKey: "shared-key" });
  const recordsB = await f.runner.readRecords({ clientId: "client-fixture-b", idempotencyKey: "shared-key" });
  assert.ok(recordsA.every(({ workflowId }) => workflowId === "workflow-client-a"));
  assert.ok(recordsB.every(({ workflowId }) => workflowId === "workflow-client-b"));
});

test("only one live runner can own a storage directory until close releases its lock", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "neurohands-runner-lock-"));
  let serial = 0;
  const makeRunner = (label) => createWorkflowRunner({
    storageDir,
    authorizedClientIds: ["client-fixture-a"],
    idFactory: (prefix = "id") => `${prefix}-${label}-${++serial}`,
    agentInvoker: async () => ({
      output: "lock fixture complete", evidence: [], toolAudit: [],
      metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
    }),
  });
  const first = makeRunner("first");
  const competing = makeRunner("competing");
  let successor;
  t.after(async () => {
    await Promise.allSettled([first.close(), competing.close(), successor?.close()]);
    await rm(storageDir, { recursive: true, force: true });
  });
  await first.initialize();
  await assert.rejects(() => competing.initialize(), /lock|owned|active|runner/i);
  await assert.rejects(() => competing.run(request({
    templateId: "individual", workflowId: "workflow-competing", idempotencyKey: "competing-key",
  })), /lock|owned|active|runner/i);
  const firstResult = await first.run(request({
    templateId: "individual", workflowId: "workflow-lock-owner", idempotencyKey: "lock-owner-key",
  }));
  assert.equal(firstResult.status, "completed");
  await first.close();
  successor = makeRunner("successor");
  await successor.initialize();
  const records = await successor.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-lock-owner" });
  assert.ok(records.length > 0);
});

test("measured duration cannot be reduced by agent metrics and a never-settling invoker hits a hard deadline", async (t) => {
  const measured = await fixture(t, {
    now: () => new Date(),
    agentInvoker: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        output: "finished after a measurable delay", evidence: [], toolAudit: [],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 },
      };
    },
  });
  const measuredResult = await measured.runner.run(request({
    templateId: "individual", workflowId: "workflow-measured-time", idempotencyKey: "measured-time-key",
    budget: { ...request().budget, maxDurationMs: 100 },
  }));
  assert.equal(measuredResult.status, "completed");
  assert.ok(measuredResult.metrics.durationMs >= 15, `Expected measured time, received ${measuredResult.metrics.durationMs}ms.`);

  const hanging = await fixture(t, {
    now: () => new Date(),
    agentInvoker: async () => new Promise(() => {}),
  });
  const started = Date.now();
  const hardTimeout = hanging.runner.run(request({
    templateId: "individual", workflowId: "workflow-hard-timeout", idempotencyKey: "hard-timeout-key",
    budget: { ...request().budget, maxDurationMs: 20 },
  }));
  const timeoutResult = await Promise.race([
    hardTimeout,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Hard workflow timeout did not settle.")), 500)),
  ]);
  assert.equal(timeoutResult.status, "failed");
  assert.ok(Date.now() - started < 500);
  assert.match(timeoutResult.steps[0].error?.code || "", /BUDGET|TIMEOUT/);
  const records = await hanging.runner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-hard-timeout" });
  assert.equal(records.at(-1).status, "failed");
});

test("fire-and-forget tool calls are drained before terminal state and cannot mutate the ledger later", async (t) => {
  let gate = deferred();
  let toolStarted = deferred();
  const f = await fixture(t, {
    toolExecutor: async () => {
      toolStarted.resolve();
      return gate.promise;
    },
    agentInvoker: async (profile, step, context) => {
      void context.executeTool({ name: profile.allowedTools[0], args: { query: "synthetic fixture" } });
      return {
        output: `${step.stepId} returned before its tool`, evidence: [], toolAudit: [{ name: "forged", status: "completed" }],
        metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
      };
    },
  });
  let settled = false;
  const successfulRun = f.runner.run(request({
    templateId: "individual", workflowId: "workflow-drained-tool", idempotencyKey: "drained-tool-key",
  })).finally(() => { settled = true; });
  await toolStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "The workflow completed while an authorized tool was still pending.");
  gate.resolve({ ok: true, source: "fixture receipt" });
  const successful = await successfulRun;
  assert.equal(successful.status, "completed");
  assert.equal(successful.steps[0].toolAudit.length, 1);
  assert.equal(successful.steps[0].toolAudit[0].name, "lookup_company");

  gate = deferred();
  toolStarted = deferred();
  const failedRun = f.runner.run(request({
    templateId: "individual", workflowId: "workflow-rejected-tool", idempotencyKey: "rejected-tool-key",
  }));
  await toolStarted.promise;
  gate.reject(new Error("synthetic late tool failure"));
  const failed = await failedRun;
  assert.equal(failed.status, "failed");
  const terminalBytes = await readFile(f.ledgerPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await readFile(f.ledgerPath), terminalBytes, "No late tool callback may append after terminal state.");
});

test("default agents cannot turn model errors, call limits or failed tools into completed workflow steps", async (t) => {
  const modelError = await fixture(t, {
    defaultAgent: true,
    modelFactory: fakeModelFactory([new Error("synthetic provider failure")]),
  });
  const modelFailure = await modelError.runner.run(request({
    templateId: "individual", workflowId: "workflow-model-error", idempotencyKey: "model-error-key",
  }));
  assert.equal(modelFailure.status, "failed");

  const callLimit = await fixture(t, {
    defaultAgent: true,
    modelFactory: fakeModelFactory([(_messages, callNumber) =>
      modelToolCall("calculate", { expression: "1 + 1" }, `repeat-${callNumber}`)]),
  });
  const limited = await callLimit.runner.run(request({
    templateId: "individual", workflowId: "workflow-call-limit", idempotencyKey: "call-limit-key",
  }));
  assert.equal(limited.status, "failed");
  assert.equal(limited.steps[0].metrics.modelCalls, 4);

  const failedTool = await fixture(t, {
    defaultAgent: true,
    modelFactory: fakeModelFactory([
      modelToolCall("list_tasks", {}),
      new AIMessage("The task listing is complete."),
    ]),
    toolExecutor: async () => { throw new Error("synthetic tool failure"); },
  });
  const toolFailure = await failedTool.runner.run(request({
    templateId: "individual", workflowId: "workflow-tool-error", idempotencyKey: "tool-error-key",
  }));
  assert.equal(toolFailure.status, "failed");
  assert.ok(toolFailure.steps[0].toolAudit.some((entry) => entry.status === "failed" || entry.ok === false));
});

test("an incomplete default-agent stop persists the graph's complete tool audit", async (t) => {
  const f = await fixture(t, {
    defaultAgent: true,
    modelFactory: fakeModelFactory([
      modelToolCall("list_tasks", {}, "executor-call"),
      modelToolCall("delegate_to_agent", { agent: "aria", task: "Synthetic disallowed attempt" }, "denied-call"),
      modelToolCall("calculate", { expression: "1 + 1" }, "builtin-one"),
      modelToolCall("calculate", { expression: "2 + 2" }, "builtin-two"),
    ]),
  });
  const result = await f.runner.run(request({
    templateId: "individual", workflowId: "workflow-complete-failure-audit", idempotencyKey: "complete-failure-audit-key",
  }));
  const step = result.steps[0];
  assert.equal(result.status, "failed");
  assert.equal(step.metrics.toolCalls, 4, "Graph metrics count every attempted tool call.");
  assert.deepEqual(step.toolAudit.map(({ name }) => name), ["list_tasks", "delegate_to_agent", "calculate", "calculate"]);
  assert.equal(step.toolAudit.length, step.metrics.toolCalls, "The persisted audit explains the graph's tool-call metric.");
  assert.equal(step.toolAudit.find(({ name }) => name === "delegate_to_agent")?.ok, false);
  assert.deepEqual(f.counts(), { modelCalls: 1, toolCalls: 1 }, "Only the allowed injected tool reaches the executor.");
});

test("custom agents cannot forge persisted tool audit evidence", async (t) => {
  const marker = "FORGED-TOOL-SUCCESS";
  const f = await fixture(t, { agentInvoker: async () => ({
    output: "A valid synthetic non-tool result.",
    evidence: [{ source: "fixture" }],
    toolAudit: [{ name: "delete_everything", status: "completed", ok: true, result: { marker, clientId: "client-fixture-b" } }],
    metrics: { modelCalls: 0, toolCalls: 99, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
  }) });
  const result = await f.runner.run(request({
    templateId: "individual", workflowId: "workflow-forged-audit", idempotencyKey: "forged-audit-key",
  }));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.steps[0].toolAudit, []);
  assert.equal(result.steps[0].metrics.toolCalls, 0);
  assert.doesNotMatch((await readFile(f.ledgerPath, "utf8")), new RegExp(marker));
});

test("existing ledger bytes do not spend a new workflow budget and replay keeps per-workflow storage stable", async (t) => {
  const f = await fixture(t, { agentInvoker: async (profile, step, context) => ({
    output: `${profile.agentId}:${step.stepId}`,
    evidence: [{ objective: context.objective, padding: context.objective.includes("large") ? "x".repeat(3000) : "ok" }],
    toolAudit: [],
    metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
  }) });
  const large = await f.runner.run(request({
    objective: "large synthetic history", workflowId: "workflow-large-history", idempotencyKey: "large-history-key",
  }));
  assert.equal(large.status, "completed");
  const existingBytes = await fileBytes(f.ledgerPath);
  const compactInput = request({
    templateId: "individual", objective: "compact synthetic work", workflowId: "workflow-compact", idempotencyKey: "compact-key",
    budget: { ...request().budget, maxStoredBytes: 6000 },
  });
  assert.ok(existingBytes > compactInput.budget.maxStoredBytes);
  const compact = await f.runner.run(compactInput);
  assert.equal(compact.status, "completed");
  const compactRecords = await f.runner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-compact" });
  const compactBytes = compactRecords.reduce((sum, record) => sum + Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"), 0);
  assert.equal(compact.metrics.storedBytes, compactBytes);
  assert.ok(compact.metrics.storedBytes < compactInput.budget.maxStoredBytes);
  const beforeReplay = await readFile(f.ledgerPath);
  const replay = await f.runner.run(structuredClone(compactInput));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.metrics.storedBytes, compact.metrics.storedBytes);
  assert.deepEqual(await readFile(f.ledgerPath), beforeReplay);
});

test("storage-budget exhaustion always writes a terminal failed state", async (t) => {
  const f = await fixture(t, { agentInvoker: async () => ({
    output: "large output",
    evidence: [{ padding: "x".repeat(4000) }],
    toolAudit: [],
    metrics: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 },
  }) });
  const result = await f.runner.run(request({
    templateId: "individual", workflowId: "workflow-storage-limit", idempotencyKey: "storage-limit-key",
    budget: { ...request().budget, maxStoredBytes: 1400 },
  }));
  assert.equal(result.status, "failed");
  assert.match(result.steps[0].error?.code || "", /BUDGET/);
  const records = await f.runner.readRecords({ clientId: "client-fixture-a", workflowId: "workflow-storage-limit" });
  assert.equal(records.at(-1).status, "failed");
  assert.equal(["queued", "running"].includes(records.at(-1).status), false);
});

test("the objective limit remains compatible with the composed default-agent prompt", async (t) => {
  let observedPrompt = "";
  const f = await fixture(t, {
    defaultAgent: true,
    modelFactory: () => ({
      bindTools() { return this; },
      async invoke(messages) {
        observedPrompt = messages.at(-1).content;
        return new AIMessage({
          content: "The maximum-length synthetic objective was accepted.",
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    }),
  });
  const maximumObjective = "x".repeat(MAX_WORKFLOW_OBJECTIVE_CHARACTERS);
  const accepted = await f.runner.run(request({
    templateId: "individual", objective: maximumObjective,
    workflowId: "workflow-max-objective", idempotencyKey: "max-objective-key",
  }));
  assert.equal(accepted.status, "completed");
  assert.equal(observedPrompt, maximumObjective);
  assert.ok(observedPrompt.length <= 2000, `The composed prompt exceeded the local agent input limit: ${observedPrompt.length}.`);
  const beforeRejectedInput = await readFile(f.ledgerPath);
  await assert.rejects(() => f.runner.run(request({
    templateId: "individual", objective: `${maximumObjective}x`,
    workflowId: "workflow-oversize-objective", idempotencyKey: "oversize-objective-key",
  })), new RegExp(`at most ${MAX_WORKFLOW_OBJECTIVE_CHARACTERS}`));
  assert.deepEqual(await readFile(f.ledgerPath), beforeRejectedInput);
});
