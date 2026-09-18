import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { AGENT_PROFILES } from "../src/agent/profiles.mjs";
import { WORKFLOW_TEMPLATES, createWorkflowRunner } from "../src/agent/workflow.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_FIXTURE = resolve(ROOT, "test/fixtures/team-workflow-scenarios.json");
const REQUIRED_TEMPLATES = Object.freeze(["individual", "pair", "full_department"]);
const CONFORMANCE_CATEGORIES = Object.freeze(["coverage", "correctness", "quality", "efficiency"]);
const FIXED_PROPOSAL = Object.freeze({
  currency: "THB",
  seatCount: 5,
  monthlyPricePerSeat: 1000,
  discountPercent: 10,
  setupFee: 2000,
  expectedSubtotal: 5000,
  expectedDiscount: 500,
  expectedMonthly: 4500,
  expectedFirstMonth: 6500,
});
const execFileAsync = promisify(execFile);

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
  return argv[index + 1];
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function signature(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function proposalTruth(proposal) {
  const subtotal = proposal.seatCount * proposal.monthlyPricePerSeat;
  const discount = subtotal * proposal.discountPercent / 100;
  const monthly = subtotal - discount;
  return Object.freeze({
    currency: proposal.currency,
    seatCount: proposal.seatCount,
    monthlyPricePerSeat: proposal.monthlyPricePerSeat,
    discountPercent: proposal.discountPercent,
    setupFee: proposal.setupFee,
    subtotal,
    discount,
    monthly,
    firstMonth: monthly + proposal.setupFee,
  });
}

function atPath(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function stepIdOf(step) {
  return step?.stepId ?? step?.id;
}

export function validateTeamWorkflowFixture(specification) {
  if (specification?.schemaVersion !== 1) throw new Error("The orchestration conformance fixture must use schemaVersion 1.");
  if (typeof specification.conformanceId !== "string" || !specification.conformanceId) throw new Error("The fixture requires a conformanceId.");
  if (specification.status !== "deterministic_orchestration_conformance") throw new Error("The fixture status must identify deterministic orchestration conformance.");
  if (!Array.isArray(specification.agents) || specification.agents.length !== 5) throw new Error("The fixture must define exactly five agents.");
  if (!Array.isArray(specification.checks) || specification.checks.length !== 10) throw new Error("The fixture must define exactly ten binary checks.");
  if (!Array.isArray(specification.scenarios) || specification.scenarios.length !== 3) throw new Error("The fixture must define one, two and five-agent scenarios.");
  if (!isDeepStrictEqual(specification.scenarios.map(({ templateId }) => templateId), REQUIRED_TEMPLATES)) {
    throw new Error("The fixture scenarios must be individual, pair and full_department in that order.");
  }
  const proposal = specification.proposal;
  if (!proposal || ["seatCount", "monthlyPricePerSeat", "discountPercent", "setupFee", "expectedSubtotal", "expectedDiscount", "expectedMonthly", "expectedFirstMonth"]
    .some((key) => typeof proposal[key] !== "number" || !Number.isFinite(proposal[key]))) {
    throw new Error("The fixed proposal must contain finite numeric truth fields.");
  }
  if (!isDeepStrictEqual(proposal, FIXED_PROPOSAL)) {
    throw new Error("The fixture proposal must remain the fixed 5-seat THB 4,500 monthly / THB 6,500 first-month case.");
  }
  const truth = proposalTruth(proposal);
  if (truth.subtotal !== proposal.expectedSubtotal || truth.discount !== proposal.expectedDiscount
    || truth.monthly !== proposal.expectedMonthly || truth.firstMonth !== proposal.expectedFirstMonth) {
    throw new Error("The fixed proposal arithmetic in the fixture is inconsistent.");
  }
  if (!Array.isArray(specification.requiredAgentIds)
    || !isDeepStrictEqual(specification.requiredAgentIds, specification.agents.map(({ id }) => id))) {
    throw new Error("requiredAgentIds must contain all five fixture agents in delegation order.");
  }
  const owners = new Map(specification.agents.map((agent) => [agent.id, 0]));
  for (const check of specification.checks) {
    if (!owners.has(check.ownerAgentId)) throw new Error(`Check ${check.id} has an unknown owner.`);
    if (!CONFORMANCE_CATEGORIES.includes(check.category)) throw new Error(`Check ${check.id} has an invalid conformance category.`);
    owners.set(check.ownerAgentId, owners.get(check.ownerAgentId) + 1);
  }
  if ([...owners.values()].some((count) => count !== 2)) throw new Error("Each of the five agents must own exactly two checks.");

  const expected = specification.expectedEvidence;
  if (!expected || typeof expected !== "object") throw new Error("Expected evidence is required.");
  const sales = expected.sales_quote?.data;
  if (!sales || sales.seats !== truth.seatCount || sales.currency !== truth.currency
    || sales.monthlyTotal !== truth.monthly || sales.firstMonthTotal !== truth.firstMonth
    || sales.setupFee !== truth.setupFee || sales.discountPercent !== truth.discountPercent) {
    throw new Error("The expected sales quote must exactly match raw proposal truth.");
  }
  const marketing = expected.marketing_brief?.data;
  if (!marketing || marketing.verifiedMonthlyTHB !== truth.monthly || marketing.verifiedFirstMonthTHB !== truth.firstMonth) {
    throw new Error("The expected marketing prices must exactly match raw proposal truth.");
  }
  if (expected.security_controls?.data?.tenantScope !== specification.clientId) {
    throw new Error("The expected security tenant scope must match the fixed client.");
  }

  const runtimeProfiles = new Map(AGENT_PROFILES.map((profile) => [profile.agentId, profile]));
  const plannedEvidenceOwners = new Map();
  for (const agent of specification.agents) {
    const profile = runtimeProfiles.get(agent.id);
    if (!profile || profile.displayName !== agent.name || profile.departmentId !== agent.department) {
      throw new Error(`Fixture identity ${agent.id} does not match the runtime registry.`);
    }
    const plan = specification.plans?.[agent.stepId];
    if (!plan || plan.agentId !== agent.id) throw new Error(`Fixture agent ${agent.id} has no matching deterministic plan.`);
    if (!plan.usage || plan.usage.inputTokens + plan.usage.outputTokens !== plan.usage.totalTokens) {
      throw new Error(`${agent.id} synthetic token fields must add exactly to totalTokens.`);
    }
    if (!Array.isArray(plan.tools) || !Array.isArray(plan.evidenceTypes)) throw new Error(`${agent.id} plan must declare tools and evidenceTypes arrays.`);
    if (!isDeepStrictEqual(agent.plannedTools, plan.tools.map(({ name }) => name))) {
      throw new Error(`${agent.id}.plannedTools must exactly match its deterministic plan calls.`);
    }
    const runtimeSteps = Object.values(WORKFLOW_TEMPLATES).flatMap((template) => template.steps)
      .filter((step) => step.stepId === agent.stepId && step.agentId === agent.id);
    if (!runtimeSteps.length) throw new Error(`${agent.id} has no fixed runtime step.`);
    for (const call of plan.tools || []) {
      if (runtimeSteps.some((step) => !step.allowedTools.includes(call.name))) {
        throw new Error(`${agent.id} planned tool ${call.name} is outside the exact fixed step allowedTools.`);
      }
      if (call.args?.operation === "store_evidence") throw new Error(`${agent.id} must return non-write evidence directly instead of using a pseudo write tool.`);
    }
    for (const evidenceType of plan.evidenceTypes) {
      const expectedRecord = expected[evidenceType];
      if (!expectedRecord || expectedRecord.ownerAgentId !== agent.id || expectedRecord.source !== "trusted_injected_agent_result") {
        throw new Error(`${agent.id} direct evidence ${evidenceType} does not match its trusted fixture ownership.`);
      }
      if (plannedEvidenceOwners.has(evidenceType)) throw new Error(`Direct evidence ${evidenceType} is assigned more than once.`);
      plannedEvidenceOwners.set(evidenceType, agent.id);
    }
  }
  if (!isDeepStrictEqual([...plannedEvidenceOwners.keys()].sort(), Object.keys(expected).sort())) {
    throw new Error("Every expected evidence record must be returned exactly once by its fixed injected agent.");
  }
  const pricingCall = specification.plans.requirements_quote.tools.find(({ args }) => args?.operation === "calculate_pricing");
  if (!pricingCall || !isDeepStrictEqual({
    seatCount: pricingCall.args.seatCount,
    monthlyPricePerSeat: pricingCall.args.monthlyPricePerSeat,
    discountPercent: pricingCall.args.discountPercent,
    setupFee: pricingCall.args.setupFee,
  }, {
    seatCount: truth.seatCount,
    monthlyPricePerSeat: truth.monthlyPricePerSeat,
    discountPercent: truth.discountPercent,
    setupFee: truth.setupFee,
  })) throw new Error("The pricing plan inputs must exactly match raw proposal truth.");
  for (const scenario of specification.scenarios) {
    const runtime = WORKFLOW_TEMPLATES[scenario.templateId];
    if (!runtime) throw new Error(`Runtime template ${scenario.templateId} is missing.`);
    const steps = runtime.steps || runtime;
    if (!isDeepStrictEqual(steps.map((step) => step.agentId), scenario.agentIds)
      || !isDeepStrictEqual(steps.map(stepIdOf), scenario.expectedStepIds)) {
      throw new Error(`Fixture scenario ${scenario.templateId} does not match the runtime template.`);
    }
    const missingAgentIds = specification.requiredAgentIds.filter((agentId) => !scenario.agentIds.includes(agentId));
    if (scenario.structuralEligibility?.includesAllRequiredRoles !== !missingAgentIds.length
      || !isDeepStrictEqual(scenario.structuralEligibility?.missingAgentIds, missingAgentIds)) {
      throw new Error(`Fixture scenario ${scenario.templateId} has inconsistent structural eligibility.`);
    }
  }
  return specification;
}

export function runFixtureMutationSelfCheck(specification) {
  validateTeamWorkflowFixture(specification);
  const mutations = [
    ["sales_quote_monthly_999", (value) => { value.expectedEvidence.sales_quote.data.monthlyTotal = 999; }],
    ["marketing_monthly_999", (value) => { value.expectedEvidence.marketing_brief.data.verifiedMonthlyTHB = 999; }],
    ["raw_proposal_monthly_999", (value) => { value.proposal.expectedMonthly = 999; }],
    ["pair_step_pseudo_write", (value) => {
      value.agents.find(({ id }) => id === "sales-suri").plannedTools.push("create_task");
      value.plans.requirements_quote.tools.push({ name: "create_task", args: { operation: "store_evidence" } });
    }],
  ];
  const results = mutations.map(([id, mutate]) => {
    const changed = structuredClone(specification);
    mutate(changed);
    try { validateTeamWorkflowFixture(changed); }
    catch (error) { return { id, rejected: true, error: error.message }; }
    return { id, rejected: false, error: null };
  });
  if (results.some(({ rejected }) => !rejected)) throw new Error("Fixture mutation self-check failed to reject false pricing truth.");
  return { passed: true, cases: results };
}

function createDeterministicModel(specification) {
  let invocations = 0;
  return {
    async invoke({ profile, step }) {
      invocations += 1;
      const stepId = stepIdOf(step);
      const plan = specification.plans[stepId];
      if (!plan || plan.agentId !== profile.agentId) throw new Error(`No deterministic model plan for ${profile.agentId}/${stepId}.`);
      return {
        content: `${profile.displayName} fixture plan for ${stepId}`,
        toolCalls: structuredClone(plan.tools),
        evidenceTypes: structuredClone(plan.evidenceTypes),
        usage: structuredClone(plan.usage),
      };
    },
    get invocationCount() { return invocations; },
  };
}

function trustedContext(value = {}) {
  return Object.fromEntries([
    "clientId", "workflowId", "templateId", "stepId", "agentId", "departmentId",
    "idempotencyKey", "profileVersion",
  ].filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function persistedEvidenceRecords(records, clientId) {
  const found = [];
  for (const record of records) {
    if (record.recordType !== "step" || record.status !== "completed" || record.clientId !== clientId) continue;
    const values = Array.isArray(record.evidence) ? record.evidence : [record.evidence];
    for (const value of values) {
      if (value && typeof value === "object" && typeof value.evidenceType === "string") {
        found.push({ ...value, runtimeRecordId: record.recordId, runtimeStepId: record.stepId });
      }
    }
  }
  return found;
}

function expectedEvidenceMatches(record, expected, clientId) {
  return Boolean(record) && record.ownerAgentId === expected.ownerAgentId && record.clientId === clientId
    && record.source === expected.source && isDeepStrictEqual(record.data, expected.data);
}

function createDeterministicExecutor(specification) {
  const audit = [];
  const expectedEvidence = new Map(Object.entries(specification.expectedEvidence));
  let readPersistedRecords = null;
  let sequence = 0;

  async function execute(name, args = {}, fixedContext = {}) {
    const context = trustedContext(fixedContext);
    const operation = args.operation;
    let result;
    if (operation === "calculate_pricing" && name === "calculate") {
      const proposal = specification.proposal;
      const supplied = {
        seatCount: args.seatCount,
        monthlyPricePerSeat: args.monthlyPricePerSeat,
        discountPercent: args.discountPercent,
        setupFee: args.setupFee,
      };
      const expected = {
        seatCount: proposal.seatCount,
        monthlyPricePerSeat: proposal.monthlyPricePerSeat,
        discountPercent: proposal.discountPercent,
        setupFee: proposal.setupFee,
      };
      const subtotal = args.seatCount * args.monthlyPricePerSeat;
      const discount = subtotal * args.discountPercent / 100;
      const monthly = subtotal - discount;
      const firstMonth = monthly + args.setupFee;
      const verified = context.agentId === "sales-suri" && isDeepStrictEqual(supplied, expected)
        && subtotal === proposal.expectedSubtotal && discount === proposal.expectedDiscount
        && monthly === proposal.expectedMonthly && firstMonth === proposal.expectedFirstMonth;
      result = {
        ok: verified,
        verified,
        currency: proposal.currency,
        subtotal,
        discount,
        monthly,
        firstMonth,
        ...(verified ? {} : { error: "pricing_fixture_mismatch" }),
      };
    } else if (operation === "verify_evidence" && name === "calculate") {
      const truth = proposalTruth(specification.proposal);
      const requiredEvidenceTypes = [...expectedEvidence.keys()];
      const runtimeRecords = readPersistedRecords ? await readPersistedRecords() : [];
      const persisted = persistedEvidenceRecords(runtimeRecords, context.clientId);
      const byType = new Map(persisted.map((record) => [record.evidenceType, record]));
      const missingEvidenceTypes = requiredEvidenceTypes.filter((kind) => {
        const expectedRecord = expectedEvidence.get(kind);
        return !expectedEvidenceMatches(byType.get(kind), expectedRecord, context.clientId);
      });
      const pricing = byType.get("pricing_calculation");
      const pricingRecomputed = Boolean(pricing)
        && pricing.ownerAgentId === "sales-suri"
        && isDeepStrictEqual(pricing.inputs, {
          seatCount: truth.seatCount,
          monthlyPricePerSeat: truth.monthlyPricePerSeat,
          discountPercent: truth.discountPercent,
          setupFee: truth.setupFee,
        })
        && pricing.subtotal === truth.subtotal && pricing.discount === truth.discount
        && pricing.monthly === truth.monthly && pricing.firstMonth === truth.firstMonth;
      const persistedSales = byType.get("sales_quote")?.data;
      const persistedMarketing = byType.get("marketing_brief")?.data;
      const commercialEvidenceRecomputed = Boolean(persistedSales && persistedMarketing)
        && persistedSales.seats === truth.seatCount && persistedSales.currency === truth.currency
        && persistedSales.discountPercent === truth.discountPercent && persistedSales.setupFee === truth.setupFee
        && persistedSales.monthlyTotal === truth.monthly && persistedSales.firstMonthTotal === truth.firstMonth
        && persistedMarketing.verifiedMonthlyTHB === truth.monthly
        && persistedMarketing.verifiedFirstMonthTHB === truth.firstMonth;
      const complete = context.agentId === "ai-qa-quinn" && pricingRecomputed
        && commercialEvidenceRecomputed && !missingEvidenceTypes.length;
      result = {
        ok: true,
        complete,
        pricingRecomputed,
        commercialEvidenceRecomputed,
        verificationSource: "persisted_runtime_step_evidence",
        persistedRuntimeRecordCount: runtimeRecords.length,
        persistedEvidenceDigest: sha256(signature(persisted)),
        verifiedEvidenceTypes: requiredEvidenceTypes.filter((kind) => !missingEvidenceTypes.includes(kind)),
        missingEvidenceTypes,
      };
    } else {
      result = { ok: false, error: "unsupported_fixture_operation" };
    }
    const entry = {
      sequence: ++sequence,
      name,
      args: structuredClone(args),
      fixedContext: context,
      ok: result.ok !== false,
      result: structuredClone(result),
    };
    audit.push(entry);
    return structuredClone(result);
  }

  return {
    execute,
    audit,
    setRuntimeReader(reader) {
      if (typeof reader !== "function") throw new Error("The QA runtime reader must be a function.");
      readPersistedRecords = reader;
    },
  };
}

function createAgentInvoker(specification, scenario, model, executorAudit) {
  const order = scenario.agentIds;
  return async (profile, step, context) => {
    const started = performance.now();
    const response = await model.invoke({ profile, step, context });
    const evidence = response.evidenceTypes.map((evidenceType) => {
      const expected = specification.expectedEvidence[evidenceType];
      if (!expected || expected.ownerAgentId !== profile.agentId) throw new Error(`Unexpected direct evidence ${evidenceType}.`);
      return {
        evidenceId: `evidence-${evidenceType}`,
        evidenceType,
        ownerAgentId: profile.agentId,
        clientId: context.clientId,
        source: expected.source,
        data: structuredClone(expected.data),
      };
    });
    const toolAudit = [];
    for (const call of response.toolCalls) {
      if (!context.allowedTools.includes(call.name)) throw new Error(`Deterministic plan attempted tool ${call.name} outside the fixed step scope.`);
      const result = await context.executeTool({ name: call.name, args: structuredClone(call.args) });
      const accepted = result?.ok !== false;
      toolAudit.push({ name: call.name, args: structuredClone(call.args), result: structuredClone(result), ok: accepted });
      if (accepted && call.args.operation === "calculate_pricing") {
        const { operation, ...inputs } = call.args;
        evidence.push({
          evidenceType: "pricing_calculation",
          ownerAgentId: profile.agentId,
          clientId: context.clientId,
          source: "accepted_deterministic_tool_result",
          inputs,
          ...result,
        });
      }
    }
    const position = order.indexOf(profile.agentId);
    const nextAgentId = order[position + 1];
    if (nextAgentId) await context.handoff({ toAgentId: nextAgentId, evidence: structuredClone(evidence) });
    const durationMs = Math.max(0, +(performance.now() - started).toFixed(3));
    return {
      output: `${profile.displayName} completed the fixed ${stepIdOf(step)} fixture plan.`,
      evidence,
      metrics: {
        modelCalls: 1,
        toolCalls: response.toolCalls.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        durationMs,
      },
      toolAudit,
      conformanceExecutorAuditCount: executorAudit.length,
    };
  };
}

function repeatCount(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = `${entry.fixedContext.agentId || "unknown"}|${entry.name}|${signature(entry.args)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function handoffPair(record) {
  const packet = record.handoff || record;
  const from = packet.fromAgentId ?? packet.sourceAgentId ?? packet.senderAgentId ?? packet.agentId
    ?? packet.from?.agentId ?? packet.source?.agentId;
  const to = packet.toAgentId ?? packet.targetAgentId ?? packet.recipientAgentId
    ?? packet.to?.agentId ?? packet.target?.agentId;
  return from && to ? [from, to] : null;
}

function hasHandoffChain(records, agentIds) {
  const edges = new Set(records.filter((record) => record.recordType === "handoff" && record.status !== "failed")
    .map(handoffPair).filter(Boolean).map(([from, to]) => `${from}->${to}`));
  return agentIds.slice(0, -1).every((from, index) => edges.has(`${from}->${agentIds[index + 1]}`));
}

function runtimeToolResults(records) {
  const results = [];
  for (const record of records) {
    if (record.recordType !== "step" || record.status !== "completed") continue;
    for (const [index, call] of (record.toolAudit || []).entries()) {
      results.push({ ...call, runtimeRecordId: record.recordId, runtimeStepId: record.stepId, index });
    }
  }
  return results;
}

function evaluateConformance(specification, records) {
  const persisted = persistedEvidenceRecords(records, specification.clientId);
  const persistedByType = new Map(persisted.map((record) => [record.evidenceType, record]));
  const tools = runtimeToolResults(records);
  const checks = specification.checks.map((check) => {
    const proof = check.proof;
    let passed = false;
    let evidenceRef = null;
    if (proof.type === "tool_result") {
      const match = tools.find((entry) => entry.name === proof.tool && entry.status === "completed"
        && (!proof.operation || entry.args?.operation === proof.operation)
        && isDeepStrictEqual(atPath(entry.result, proof.resultPath), proof.equals));
      passed = Boolean(match);
      evidenceRef = match ? `runtime-record:${match.runtimeRecordId}:tool:${match.index}` : null;
    } else if (proof.type === "evidence_record") {
      const record = persistedByType.get(proof.evidenceType);
      const expected = specification.expectedEvidence[proof.evidenceType];
      passed = expectedEvidenceMatches(record, expected, specification.clientId);
      evidenceRef = passed ? `runtime-record:${record.runtimeRecordId}:evidence:${record.evidenceId}` : null;
    } else if (proof.type === "handoff_chain") {
      passed = hasHandoffChain(records, proof.agentIds);
      evidenceRef = passed ? `runtime-handoff-chain:${proof.agentIds.join("->")}` : null;
    }
    return { id: check.id, category: check.category, ownerAgentId: check.ownerAgentId, description: check.description, passed, evidenceRef };
  });
  const categories = Object.fromEntries(CONFORMANCE_CATEGORIES.map((category) => {
    const categoryChecks = checks.filter((check) => check.category === category);
    return [category, {
      passedChecks: categoryChecks.filter(({ passed }) => passed).length,
      totalChecks: categoryChecks.length,
      provenance: "derived",
    }];
  }));
  return {
    label: "deterministic_orchestration_conformance",
    passedChecks: checks.filter(({ passed }) => passed).length,
    totalChecks: checks.length,
    provenance: "derived",
    categories,
    checks,
  };
}

async function storageMeasurements(storageDir, records, ledgerPath) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(storageDir);
  let storageBytes = 0;
  let jsonlBytes = 0;
  let jsonlRecordCount = 0;
  for (const path of files) {
    const size = (await stat(path)).size;
    storageBytes += size;
    if (path.endsWith(".jsonl")) {
      jsonlBytes += size;
      const text = await readFile(path, "utf8");
      jsonlRecordCount += text.split(/\r?\n/).filter((line) => line.trim()).length;
    }
  }
  const ledger = await readFile(ledgerPath);
  return {
    storageBytes,
    storageFileCount: files.length,
    jsonlBytes,
    jsonlFileCount: files.filter((path) => path.endsWith(".jsonl")).length,
    jsonlRecordCount,
    runtimeRecordCount: records.length,
    runtimeLedgerSha256: sha256(ledger),
    provenance: {
      storageBytes: "measured",
      storageFileCount: "measured",
      jsonlBytes: "measured",
      jsonlFileCount: "measured",
      jsonlRecordCount: "measured",
      runtimeRecordCount: "derived",
      runtimeLedgerSha256: "measured",
    },
  };
}

function agentMeasurements(run, audit) {
  const profileById = new Map(AGENT_PROFILES.map((profile) => [profile.agentId, profile]));
  return run.steps.map((step) => {
    const profile = profileById.get(step.agentId);
    const calls = audit.filter((entry) => entry.fixedContext.agentId === step.agentId);
    return {
      agentId: step.agentId,
      name: profile?.displayName ?? step.agentId,
      department: profile?.departmentId ?? step.departmentId,
      stepId: step.stepId,
      status: step.status,
      certainty: step.certainty,
      wallMs: step.metrics?.durationMs ?? null,
      inputTokens: step.metrics?.inputTokens ?? null,
      outputTokens: step.metrics?.outputTokens ?? null,
      totalTokens: step.metrics?.totalTokens ?? null,
      modelCalls: step.metrics?.modelCalls ?? null,
      toolCalls: calls.length,
      toolFailureCount: calls.filter((entry) => !entry.ok).length,
      failedStepCount: step.status === "failed" ? 1 : 0,
      blockedStepCount: step.status === "blocked" ? 1 : 0,
      repeatedIdenticalToolCallCount: repeatCount(calls),
      evidenceRecords: (Array.isArray(step.evidence) ? step.evidence : [step.evidence])
        .filter((record) => record && typeof record.evidenceType === "string").length,
      provenance: {
        wallMs: "measured",
        inputTokens: "synthetic",
        outputTokens: "synthetic",
        totalTokens: "synthetic",
        modelCalls: "measured",
        toolCalls: "measured",
        toolFailureCount: "derived",
        failedStepCount: "derived",
        blockedStepCount: "derived",
        repeatedIdenticalToolCallCount: "derived",
        evidenceRecords: "derived",
      },
    };
  });
}

async function runScenario(specification, scenario, { keepStorage = false } = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), `neurohands-${scenario.templateId}-`));
  const model = createDeterministicModel(specification);
  const executor = createDeterministicExecutor(specification);
  let id = 0;
  let tick = Date.parse("2026-09-16T12:00:00.000Z");
  let runner;
  try {
    runner = createWorkflowRunner({
      storageDir,
      storageRoot: storageDir,
      authorizedClientIds: [specification.clientId],
      now: () => new Date(tick += 1).toISOString(),
      idFactory: (prefix = "id") => `${scenario.templateId}-${prefix}-${++id}`,
      modelFactory: () => model,
      toolExecutor: executor.execute,
      agentInvoker: createAgentInvoker(specification, scenario, model, executor.audit),
    });
    executor.setRuntimeReader(() => runner.readRecords({
      clientId: specification.clientId,
      workflowId: `conformance-${scenario.templateId}`,
    }));
    await runner.initialize();
    const started = performance.now();
    const run = await runner.run({
      templateId: scenario.templateId,
      clientId: specification.clientId,
      workflowId: `conformance-${scenario.templateId}`,
      objective: specification.objective,
      idempotencyKey: `${specification.conformanceId}-${scenario.templateId}`,
      budget: structuredClone(specification.budget),
    });
    const wallMs = Math.max(0, +(performance.now() - started).toFixed(3));
    const records = await runner.readRecords({ clientId: specification.clientId, workflowId: run.workflowId });
    const storage = await storageMeasurements(storageDir, records, runner.ledgerPath || join(storageDir, "handoffs.jsonl"));
    const conformance = evaluateConformance(specification, records);
    const agents = agentMeasurements(run, executor.audit);
    const totals = {
      wallMs,
      modelCalls: agents.reduce((sum, agent) => sum + (agent.modelCalls || 0), 0),
      inputTokens: agents.reduce((sum, agent) => sum + (agent.inputTokens || 0), 0),
      outputTokens: agents.reduce((sum, agent) => sum + (agent.outputTokens || 0), 0),
      totalTokens: agents.reduce((sum, agent) => sum + (agent.totalTokens || 0), 0),
      toolCalls: executor.audit.length,
      toolFailureCount: agents.reduce((sum, agent) => sum + agent.toolFailureCount, 0),
      failedStepCount: agents.reduce((sum, agent) => sum + agent.failedStepCount, 0),
      blockedStepCount: agents.reduce((sum, agent) => sum + agent.blockedStepCount, 0),
      repeatedIdenticalToolCallCount: repeatCount(executor.audit),
      completedSteps: agents.filter((agent) => agent.status === "completed").length,
      provenance: {
        wallMs: "measured",
        modelCalls: "measured",
        inputTokens: "synthetic",
        outputTokens: "synthetic",
        totalTokens: "synthetic",
        toolCalls: "measured",
        toolFailureCount: "derived",
        failedStepCount: "derived",
        blockedStepCount: "derived",
        repeatedIdenticalToolCallCount: "derived",
        completedSteps: "derived",
      },
    };
    const missingAgentIds = specification.requiredAgentIds.filter((agentId) => !scenario.agentIds.includes(agentId));
    return {
      recordType: "scenario_conformance",
      conformanceId: specification.conformanceId,
      templateId: scenario.templateId,
      label: scenario.label,
      configuredAgentCount: scenario.agentIds.length,
      configuredAgentCountProvenance: "derived",
      status: run.status,
      duplicate: run.duplicate,
      structuralEligibility: {
        includesAllRequiredRoles: !missingAgentIds.length,
        includedAgentIds: [...scenario.agentIds],
        missingAgentIds,
        interpretation: !missingAgentIds.length
          ? "This template includes every role required by the fixed conformance fixture."
          : "This template is structurally ineligible for full-fixture completion because required roles are absent.",
      },
      conformance,
      agents,
      totals,
      storage: { ...storage, retainedPath: keepStorage ? storageDir : null },
      toolCalls: executor.audit,
      runtimeMetrics: {
        value: run.metrics,
        provenance: {
          modelCalls: "derived",
          toolCalls: "derived",
          inputTokens: "synthetic",
          outputTokens: "synthetic",
          totalTokens: "synthetic",
          durationMs: "measured",
          storedBytes: "measured",
          completedSteps: "derived",
          failedSteps: "derived",
          blockedSteps: "derived",
        },
      },
      measurementNotes: {
        tokens: "Synthetic values emitted by the deterministic fake model; they are not tokenizer or provider measurements.",
        wallTime: "Scenario wall time and per-agent invocation time were measured locally with performance.now().",
        conformance: "Only persisted runtime step evidence, persisted tool audit, and persisted handoff records can pass checks; output prose is ignored.",
        failureScope: "toolFailureCount counts injected executor results with ok:false; failedStepCount and blockedStepCount are separate runtime terminal states.",
        repeatScope: "repeatedIdenticalToolCallCount counts calls by the same agent with identical tool name and canonical arguments within this scenario.",
      },
      deterministicModelInvocations: model.invocationCount,
      deterministicModelInvocationsProvenance: "measured",
    };
  } finally {
    if (typeof runner?.close === "function") await runner.close();
    if (!keepStorage) await rm(storageDir, { recursive: true, force: true });
  }
}

async function reproducibilityMetadata(fixtureBytes) {
  let git = { revision: null, dirty: null, statusAvailable: false };
  try {
    const [{ stdout: revision }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: ROOT, windowsHide: true }),
    ]);
    git = { revision: revision.trim(), dirty: Boolean(status.trim()), statusAvailable: true };
  } catch { /* A copied source tree may not contain Git metadata. */ }
  return {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    git,
    sourceSha256: {
      script: sha256(await readFile(SCRIPT_PATH)),
      fixture: sha256(fixtureBytes),
    },
  };
}

function summaryFor(specification, results, fetchInterceptionAttempts, reproducibility, mutationSelfCheck) {
  return {
    recordType: "conformance_summary",
    schemaVersion: 1,
    conformanceId: specification.conformanceId,
    scope: "Deterministic orchestration conformance only. This report does not measure model quality, production capacity, cost, or team-size superiority.",
    reproducibility,
    fixtureMutationSelfCheck: mutationSelfCheck,
    modelExecution: {
      implementation: "deterministic_fake",
      realModelClientConstructedByHarness: false,
      provenance: "measured",
    },
    fetchInterception: {
      enabledDuringScenarioRuns: true,
      interceptedAttemptCount: fetchInterceptionAttempts,
      provenance: "measured",
      limitation: "This observes calls through globalThis.fetch only; it is not a process-wide proof that every possible network channel was blocked.",
    },
    proposalExpected: {
      monthlyTHB: specification.proposal.expectedMonthly,
      firstMonthTHB: specification.proposal.expectedFirstMonth,
      provenance: "derived",
    },
    comparison: results.map((result) => ({
      templateId: result.templateId,
      agents: result.configuredAgentCount,
      includesAllRequiredRoles: result.structuralEligibility.includesAllRequiredRoles,
      missingAgentIds: result.structuralEligibility.missingAgentIds,
      conformance: `${result.conformance.passedChecks}/${result.conformance.totalChecks}`,
      conformanceCategories: result.conformance.categories,
      wallMs: result.totals.wallMs,
      totalTokens: result.totals.totalTokens,
      toolCalls: result.totals.toolCalls,
      toolFailureCount: result.totals.toolFailureCount,
      failedStepCount: result.totals.failedStepCount,
      blockedStepCount: result.totals.blockedStepCount,
      repeatedIdenticalToolCallCount: result.totals.repeatedIdenticalToolCallCount,
      storageBytes: result.storage.storageBytes,
      recordCount: result.storage.runtimeRecordCount,
      runtimeLedgerSha256: result.storage.runtimeLedgerSha256,
      provenance: {
        agents: "derived",
        includesAllRequiredRoles: "derived",
        conformance: "derived",
        wallMs: "measured",
        totalTokens: "synthetic",
        toolCalls: "measured",
        toolFailureCount: "derived",
        failedStepCount: "derived",
        blockedStepCount: "derived",
        repeatedIdenticalToolCallCount: "derived",
        storageBytes: "measured",
        recordCount: "derived",
        runtimeLedgerSha256: "measured",
      },
    })),
    structuralConclusion: "Only full_department contains all five roles required by this fixed fixture. The one-agent and two-agent templates are structural coverage cases and cannot establish full-objective completion.",
    interpretationLimits: [
      "Passing checks establishes deterministic runtime wiring and evidence persistence for this fixture only.",
      "Synthetic token values cannot support cost, quality, latency, or optimization claims about real models.",
      "The efficiency category checks observability evidence; it does not establish that any team size is more efficient.",
    ],
  };
}

async function writeJsonl(outputPath, records) {
  const summary = records.at(-1);
  summary.reportIntegrity = {
    recordCount: { value: records.length, provenance: "measured" },
    byteCount: { value: 0, provenance: "measured" },
    selfConsistent: { value: true, provenance: "derived" },
  };
  let content = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const bytes = Buffer.byteLength(content, "utf8");
    if (summary.reportIntegrity.byteCount.value === bytes) break;
    summary.reportIntegrity.byteCount.value = bytes;
  }
  content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  const persisted = await readFile(outputPath);
  const persistedLines = persisted.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  if (persisted.byteLength !== summary.reportIntegrity.byteCount.value || persistedLines.length !== summary.reportIntegrity.recordCount.value) {
    throw new Error("The generated report failed its byte/record self-consistency check.");
  }
  for (const line of persistedLines) JSON.parse(line);
  return { bytes: persisted.byteLength, records: persistedLines.length, verified: true };
}

export async function runConformance({
  fixturePath = DEFAULT_FIXTURE,
  outputPath = resolve(ROOT, `artifacts/benchmarks/team-workflow-conformance-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`),
  keepStorage = false,
} = {}) {
  const fixtureBytes = await readFile(fixturePath);
  const specification = validateTeamWorkflowFixture(JSON.parse(fixtureBytes.toString("utf8").replace(/^\uFEFF/, "")));
  const mutationSelfCheck = runFixtureMutationSelfCheck(specification);
  const reproducibility = await reproducibilityMetadata(fixtureBytes);
  const originalFetch = globalThis.fetch;
  let fetchInterceptionAttempts = 0;
  globalThis.fetch = async () => {
    fetchInterceptionAttempts += 1;
    throw new Error("globalThis.fetch is intercepted during deterministic orchestration conformance runs.");
  };
  let results;
  try {
    results = [];
    for (const scenario of specification.scenarios) {
      results.push(await runScenario(specification, scenario, { keepStorage }));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const summary = summaryFor(specification, results, fetchInterceptionAttempts, reproducibility, mutationSelfCheck);
  const reportIntegrity = await writeJsonl(outputPath, [...results, summary]);
  return { outputPath, reportIntegrity, results, summary };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log("Usage: node scripts/team-workflow-benchmark.mjs [--fixture path] [--out path] [--keep-storage] [--self-check]");
    return;
  }
  const fixturePath = resolve(ROOT, option(argv, "--fixture", "test/fixtures/team-workflow-scenarios.json"));
  if (argv.includes("--self-check")) {
    const specification = validateTeamWorkflowFixture(JSON.parse((await readFile(fixturePath, "utf8")).replace(/^\uFEFF/, "")));
    console.log(JSON.stringify({ fixture: fixturePath, ...runFixtureMutationSelfCheck(specification) }));
    return;
  }
  const outputPath = resolve(ROOT, option(argv, "--out", `artifacts/benchmarks/team-workflow-conformance-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  const report = await runConformance({ fixturePath, outputPath, keepStorage: argv.includes("--keep-storage") });
  console.log(JSON.stringify({
    report: report.outputPath,
    reportIntegrity: report.reportIntegrity,
    comparison: report.summary.comparison,
    structuralConclusion: report.summary.structuralConclusion,
  }));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
