import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ChatOllama } from "@langchain/ollama";

import { getLocalChatConfig } from "../src/agent/chat.mjs";
import { getAgentProfile } from "../src/agent/profiles.mjs";
import { executeLocalSkill } from "../src/agent/skills.mjs";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_STATUSES,
  createWorkflowRunner,
  getWorkflowTemplate,
} from "../src/agent/workflow.mjs";
import { ensureLocalOllama } from "./ollama-local.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_FIXTURE_PATH = resolve(ROOT, "test/fixtures/real-named-workflow-benchmark.json");
const DEFAULT_SUITE_TIMEOUT_MS = 900_000;
const MIN_SUITE_TIMEOUT_MS = 30_000;
const MAX_SUITE_TIMEOUT_MS = 1_800_000;
const EXPECTED_ORDER = Object.freeze([
  "basic-individual",
  "intermediate-pair",
  "advanced-full-department",
]);
const TOPOLOGY_SELECTIONS = Object.freeze({
  all: null,
  individual: "individual",
  basic: "individual",
  pair: "pair",
  intermediate: "pair",
  full_department: "full_department",
  advanced: "full_department",
});
const TRACE_ENV_KEYS = Object.freeze([
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
]);
const SOURCE_PATHS = Object.freeze([
  "scripts/real-named-workflow-benchmark.mjs",
  "test/fixtures/real-named-workflow-benchmark.json",
  "src/agent/workflow.mjs",
  "src/agent/profiles.mjs",
  "src/agent/team.mjs",
  "src/agent/skills.mjs",
  "package-lock.json",
]);
const SIMPLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked"]);
const MAX_DIAGNOSTIC_TOOL_CALLS = 16;
const MAX_DIAGNOSTIC_ARGUMENT_BYTES = 4_096;
const SECRET_FIELD = /(?:authorization|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credential|cookie|private[-_]?key)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${fields.join(", ")}.`);
  }
}

function assertShortText(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a nonempty string of at most ${maximum} characters.`);
  }
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(canonical(value)));
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeError(error, fallback = "The local benchmark could not complete this operation.") {
  const code = typeof error?.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(error.code) ? error.code : null;
  const allowed = [
    /configured local qwen/i,
    /local ollama/i,
    /model is absent/i,
    /suite time limit/i,
    /workflow/i,
    /fixture/i,
    /output path/i,
  ];
  const candidate = typeof error?.message === "string" && error.message.length <= 500 ? error.message : "";
  return { name: error?.name || "Error", code, message: allowed.some((pattern) => pattern.test(candidate)) ? candidate : fallback };
}

export function validateRealBenchmarkFixture(input) {
  assertExactFields(input, ["schemaVersion", "suiteId", "executionOrder", "scope", "scenarios"], "Benchmark fixture");
  if (input.schemaVersion !== 1 || input.suiteId !== "real-local-qwen-named-workflow-v1") {
    throw new Error("Benchmark fixture identity is invalid.");
  }
  if (!exactArray(input.executionOrder, EXPECTED_ORDER)) {
    throw new Error("Benchmark fixture must execute basic, intermediate, and advanced scenarios in the fixed order.");
  }
  assertExactFields(input.scope, ["execution", "network", "comparisonCaution", "grading"], "Benchmark scope");
  for (const [key, value] of Object.entries(input.scope)) assertShortText(value, `Benchmark scope.${key}`, 500);
  if (!/not a fair model-quality comparison/i.test(input.scope.comparisonCaution)
      || !/do not establish optimization/i.test(input.scope.comparisonCaution)) {
    throw new Error("Benchmark scope must explicitly reject fair model-quality and optimization claims.");
  }
  if (!/structural/i.test(input.scope.grading) || !/human review/i.test(input.scope.grading)) {
    throw new Error("Benchmark scope must reserve prose correctness for human review.");
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length !== 3) {
    throw new Error("Benchmark fixture must contain exactly three scenarios.");
  }

  const fixture = structuredClone(input);
  const clientIds = new Set();
  for (const [index, scenario] of fixture.scenarios.entries()) {
    assertExactFields(scenario, ["id", "clientId", "complexity", "topology", "objective", "budget"], `Scenario ${index + 1}`);
    if (scenario.id !== EXPECTED_ORDER[index] || !SIMPLE_ID.test(scenario.id)) throw new Error(`Scenario ${index + 1} has an invalid fixed id.`);
    if (!SIMPLE_ID.test(scenario.clientId) || clientIds.has(scenario.clientId)) throw new Error(`${scenario.id} must have a unique simple clientId.`);
    clientIds.add(scenario.clientId);
    assertShortText(scenario.objective, `${scenario.id}.objective`, WORKFLOW_LIMITS.objectiveCharacters);
    if (!scenario.objective.includes(scenario.clientId) || !/fictional local benchmark/i.test(scenario.objective)) {
      throw new Error(`${scenario.id}.objective must explicitly name its fictional local client scope.`);
    }
    if (!/do not .*external service/i.test(scenario.objective)) throw new Error(`${scenario.id}.objective must prohibit external services.`);

    assertExactFields(scenario.complexity, ["level", "ordinal", "description", "taskDimensions"], `${scenario.id}.complexity`);
    const expectedLevel = ["basic", "intermediate", "advanced"][index];
    if (scenario.complexity.level !== expectedLevel || scenario.complexity.ordinal !== index + 1) throw new Error(`${scenario.id} has invalid complexity ordering.`);
    assertShortText(scenario.complexity.description, `${scenario.id}.complexity.description`, 500);
    if (!Array.isArray(scenario.complexity.taskDimensions) || scenario.complexity.taskDimensions.length < index + 2
        || scenario.complexity.taskDimensions.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
      throw new Error(`${scenario.id} must describe its task dimensions explicitly.`);
    }

    assertExactFields(scenario.topology, ["templateId", "agentCount", "sequential", "agentIds", "stepIds", "edges"], `${scenario.id}.topology`);
    const template = getWorkflowTemplate(scenario.topology.templateId);
    const expectedAgents = template.steps.map((step) => step.agentId);
    const expectedSteps = template.steps.map((step) => step.stepId);
    const expectedEdges = template.steps.slice(0, -1).map((step, edgeIndex) => ({
      fromAgentId: step.agentId,
      toAgentId: template.steps[edgeIndex + 1].agentId,
    }));
    if (scenario.topology.sequential !== true || scenario.topology.agentCount !== expectedAgents.length
        || !exactArray(scenario.topology.agentIds, expectedAgents)
        || !exactArray(scenario.topology.stepIds, expectedSteps)
        || !exactArray(scenario.topology.edges, expectedEdges)) {
      throw new Error(`${scenario.id}.topology does not match the fixed workflow template.`);
    }

    assertExactFields(scenario.budget, ["maxModelCalls", "maxToolCalls", "maxTokens", "maxDurationMs", "maxStoredBytes"], `${scenario.id}.budget`);
    for (const [key, value] of Object.entries(scenario.budget)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${scenario.id}.budget.${key} must be a positive safe integer.`);
    }
    if (scenario.budget.maxDurationMs > MAX_SUITE_TIMEOUT_MS) throw new Error(`${scenario.id} exceeds the suite duration ceiling.`);
    if (scenario.budget.maxModelCalls < expectedAgents.length || scenario.budget.maxToolCalls < expectedAgents.length) {
      throw new Error(`${scenario.id} budgets cannot execute its fixed topology.`);
    }
  }
  return deepFreeze(fixture);
}

export async function readRealBenchmarkFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  const text = (await readFile(fixturePath, "utf8")).replace(/^\uFEFF/, "");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("The real named-workflow benchmark fixture is not valid JSON."); }
  return { fixture: validateRealBenchmarkFixture(value), text };
}

export function parseRealBenchmarkArgs(argv = []) {
  const options = { dryRun: false, topology: "all", suiteTimeoutMs: DEFAULT_SUITE_TIMEOUT_MS, output: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--dry-run", "--check", "check"].includes(argument)) options.dryRun = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--topology") options.topology = argv[++index];
    else if (argument === "--suite-timeout-ms") options.suiteTimeoutMs = Number(argv[++index]);
    else if (argument === "--out") options.output = argv[++index];
    else throw new Error(`Unknown benchmark argument: ${argument}`);
  }
  if (!Object.hasOwn(TOPOLOGY_SELECTIONS, options.topology)) {
    throw new Error("Use --topology all, individual, pair, or full_department.");
  }
  if (!Number.isSafeInteger(options.suiteTimeoutMs)
      || options.suiteTimeoutMs < MIN_SUITE_TIMEOUT_MS
      || options.suiteTimeoutMs > MAX_SUITE_TIMEOUT_MS) {
    throw new Error(`--suite-timeout-ms must be an integer from ${MIN_SUITE_TIMEOUT_MS} to ${MAX_SUITE_TIMEOUT_MS}.`);
  }
  if (options.output !== null && (typeof options.output !== "string" || !options.output.trim())) throw new Error("--out requires a file path.");
  return Object.freeze(options);
}

function loadLabEnvironment() {
  const file = resolve(ROOT, ".env.langgraph");
  if (existsSync(file)) loadEnvFile(file);
}

function disableExternalTracing(env = process.env) {
  for (const key of TRACE_ENV_KEYS) env[key] = "false";
  return Object.fromEntries(TRACE_ENV_KEYS.map((key) => [key, false]));
}

function validateConfiguredModel(env = process.env) {
  const settings = getLocalChatConfig(env);
  if (!/qwen/i.test(settings.model)) throw new Error("The configured local Qwen model is required for this benchmark.");
  return settings;
}

async function provenance(fixtureText) {
  const entries = await Promise.all(SOURCE_PATHS.map(async (sourcePath) => {
    const bytes = await readFile(resolve(ROOT, sourcePath));
    return [sourcePath, sha256(bytes)];
  }));
  const sourceSha256 = Object.fromEntries(entries);
  return {
    fixtureSha256: sha256(fixtureText),
    sourceSha256,
    provenanceSha256: sha256(sourceSha256),
  };
}

function machineEnvironment(settings) {
  const cpuList = cpus();
  const value = {
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpuModel: cpuList[0]?.model || null,
    logicalCores: cpuList.length,
    totalRamBytes: totalmem(),
    nodeVersion: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    ollamaOrigin: settings.baseUrl,
  };
  return { ...value, environmentSha256: sha256(value) };
}

function selectedScenarios(fixture, selection) {
  const templateId = TOPOLOGY_SELECTIONS[selection];
  return templateId ? fixture.scenarios.filter((scenario) => scenario.topology.templateId === templateId) : [...fixture.scenarios];
}

export async function buildRealBenchmarkDryRun({ topology = "all", env = process.env } = {}) {
  if (!Object.hasOwn(TOPOLOGY_SELECTIONS, topology)) throw new Error("Use topology all, individual, pair, or full_department.");
  const { fixture, text } = await readRealBenchmarkFixture();
  const settings = validateConfiguredModel(env);
  const selected = selectedScenarios(fixture, topology);
  if (!selected.length) throw new Error("The requested benchmark topology is absent from the fixed fixture.");
  const source = await provenance(text);
  return {
    schemaVersion: 1,
    status: "validated",
    mode: "dry-run",
    modelInference: false,
    networkRequests: 0,
    writesPerformed: 0,
    configuredModel: settings.model,
    ollamaOrigin: settings.baseUrl,
    executionMode: "sequential",
    suiteTimeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
    selectedTopology: topology,
    executionOrder: selected.map((scenario) => scenario.id),
    topology: selected.map((scenario) => ({
      scenarioId: scenario.id,
      complexity: scenario.complexity,
      topology: scenario.topology,
      budget: scenario.budget,
    })),
    isolation: {
      authorizedClientIdsPerRunner: selected.map((scenario) => [scenario.clientId]),
      storage: "a distinct ephemeral directory per scenario",
      runnerCloseRequired: true,
    },
    restrictions: {
      localhostOllamaOnly: true,
      productionServices: false,
      externalConnectors: false,
      langsmithUpload: false,
      secretsInFixture: false,
      networkEnforcement: "Validated loopback Ollama base URL, same-origin request wrapper, fixed local tools, and tracing forced off.",
    },
    limitations: [
      "Loopback-only access is enforced by benchmark application checks and tracing-off settings; this is not a process-wide network sandbox or operating-system firewall.",
      "The three topologies have different duties and task complexity, so their outputs are not a fair model-quality comparison or evidence of optimization.",
      "Model prose is preserved for human review and is not automatically graded for semantic correctness.",
      "Provider token metadata may be absent, and process CPU/RAM sampling is approximate when the real benchmark runs.",
    ],
    grading: {
      automatic: "deterministic structural checks only",
      semanticCorrectness: "not automatically graded",
      humanReview: null,
    },
    comparisonCaution: fixture.scope.comparisonCaution,
    provenance: source,
  };
}

function contentCharacters(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

function numericMetadata(value) {
  if (!isPlainObject(value)) return null;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) output[key] = item;
    else if (isPlainObject(item)) {
      const nested = numericMetadata(item);
      if (nested && Object.keys(nested).length) output[key] = nested;
    }
  }
  return Object.keys(output).length ? output : null;
}

function ollamaResponseMetadata(value) {
  if (!isPlainObject(value)) return null;
  const allowed = [
    "model", "created_at", "done", "done_reason", "total_duration", "load_duration",
    "prompt_eval_count", "prompt_eval_duration", "eval_count", "eval_duration",
  ];
  const output = {};
  for (const key of allowed) {
    const item = value[key];
    if (typeof item === "string" || typeof item === "boolean"
        || (typeof item === "number" && Number.isFinite(item) && item >= 0)) output[key] = item;
  }
  return Object.keys(output).length ? output : null;
}

function boundedDiagnosticArguments(input) {
  const state = { nodes: 0, truncated: false, seen: new WeakSet() };
  const visit = (value, key = "", depth = 0) => {
    if (SECRET_FIELD.test(key)) return "[redacted]";
    state.nodes += 1;
    if (state.nodes > 128 || depth > 6) {
      state.truncated = true;
      return "[truncated]";
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length <= 512) return value;
      state.truncated = true;
      return `${value.slice(0, 512)}[truncated]`;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") return value.toString();
    if (["undefined", "function", "symbol"].includes(typeof value)) {
      state.truncated = true;
      return null;
    }
    if (state.seen.has(value)) {
      state.truncated = true;
      return "[circular]";
    }
    state.seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 32) state.truncated = true;
      return value.slice(0, 32).map((item) => visit(item, "", depth + 1));
    }
    const output = Object.create(null);
    let entries;
    try { entries = Object.entries(value); }
    catch {
      state.truncated = true;
      return "[unavailable]";
    }
    if (entries.length > 32) state.truncated = true;
    for (const [childKey, child] of entries.slice(0, 32)) output[childKey.slice(0, 120)] = visit(child, childKey, depth + 1);
    return output;
  };
  let value = visit(input);
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch {
    return { value: { diagnostic: "arguments_unavailable" }, truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_DIAGNOSTIC_ARGUMENT_BYTES) {
    state.truncated = true;
    value = {
      diagnostic: "arguments_truncated",
      redactedSha256: sha256(serialized),
      redactedExcerpt: serialized.slice(0, 2_048),
    };
  } else {
    value = JSON.parse(serialized);
  }
  return { value, truncated: state.truncated };
}

export function safeDiagnosticToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return { toolCalls: [], truncated: false };
  const selected = toolCalls.slice(0, MAX_DIAGNOSTIC_TOOL_CALLS);
  const safe = selected.map((toolCall) => {
    const rawName = typeof toolCall?.name === "string" ? toolCall.name : "unknown";
    const name = rawName.length <= 120 ? rawName : `${rawName.slice(0, 120)}[truncated]`;
    const args = boundedDiagnosticArguments(toolCall?.args ?? null);
    return { name, args: args.value, argumentsTruncated: args.truncated };
  });
  return { toolCalls: safe, truncated: toolCalls.length > selected.length };
}

export function recordOllamaResponseDiagnostics(call, response) {
  call.outputCharacters = contentCharacters(response?.content);
  const rawToolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
  call.toolCallCount = rawToolCalls.length;
  const diagnostic = safeDiagnosticToolCalls(rawToolCalls);
  call.toolCalls = diagnostic.toolCalls;
  call.toolCallsTruncated = diagnostic.truncated;
  call.usageMetadata = numericMetadata(response?.usage_metadata);
  call.responseMetadata = ollamaResponseMetadata(response?.response_metadata);
  return call;
}

function instrumentedModelFactory(scenario) {
  const sessions = [];
  const factory = (options) => {
    const step = getWorkflowTemplate(scenario.topology.templateId).steps[sessions.length];
    if (!step) throw new Error("Workflow created more model sessions than its fixed topology permits.");
    const session = {
      stepId: step.stepId,
      agentId: step.agentId,
      modelSessionStartedAtMs: Date.now(),
      modelSessionFinishedAtMs: null,
      boundToolNames: [],
      calls: [],
    };
    sessions.push(session);
    const wrap = (runnable) => ({
      bindTools(definitions) {
        session.boundToolNames = definitions.map((definition) => definition?.function?.name).filter((name) => typeof name === "string");
        return wrap(runnable.bindTools(definitions));
      },
      async invoke(messages, config) {
        const startedAtMs = Date.now();
        const call = {
          callIndex: session.calls.length + 1,
          startedAt: new Date(startedAtMs).toISOString(),
          startedAtMs,
          finishedAtMs: null,
          wallMs: null,
          inputMessageCount: Array.isArray(messages) ? messages.length : null,
          inputCharacters: Array.isArray(messages) ? messages.reduce((sum, message) => sum + contentCharacters(message?.content), 0) : null,
          outputCharacters: null,
          toolCallCount: null,
          toolCalls: [],
          toolCallsTruncated: false,
          usageMetadata: null,
          responseMetadata: null,
          error: null,
        };
        session.calls.push(call);
        try {
          const response = await runnable.invoke(messages, config);
          recordOllamaResponseDiagnostics(call, response);
          return response;
        } catch (error) {
          call.error = safeError(error, "The local Ollama call failed.");
          throw error;
        } finally {
          call.finishedAtMs = Date.now();
          call.wallMs = call.finishedAtMs - startedAtMs;
          session.modelSessionFinishedAtMs = call.finishedAtMs;
        }
      },
    });
    return wrap(new ChatOllama(options));
  };
  return { factory, sessions };
}

async function fetchLoopbackJson(baseUrl, pathname, options = {}) {
  const destination = new URL(pathname, baseUrl);
  if (destination.origin !== baseUrl) throw new Error("A local Ollama benchmark request attempted to leave its loopback origin.");
  const response = await fetch(destination, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw new Error("The local Ollama preflight request failed.");
  return response.json();
}

async function localModelIdentity(settings) {
  await ensureLocalOllama(settings.baseUrl, ROOT);
  const [tags, version] = await Promise.all([
    fetchLoopbackJson(settings.baseUrl, "/api/tags"),
    fetchLoopbackJson(settings.baseUrl, "/api/version"),
  ]);
  const entry = tags.models?.find((item) => item?.name === settings.model || item?.model === settings.model);
  if (!entry) throw new Error("The configured local Qwen model is absent from this Ollama server. No benchmark inference was run.");
  const model = {
    configuredName: settings.model,
    reportedName: entry.name || entry.model || null,
    artifactDigest: typeof entry.digest === "string" ? entry.digest : null,
    sizeBytes: Number.isFinite(entry.size) ? entry.size : null,
    modifiedAt: typeof entry.modified_at === "string" ? entry.modified_at : null,
    details: isPlainObject(entry.details) ? canonical(entry.details) : null,
    ollamaVersion: typeof version.version === "string" ? version.version : null,
  };
  return { ...model, modelMetadataSha256: sha256(model) };
}

async function startModelProcessSampler() {
  const samples = [];
  if (process.platform !== "win32") {
    return { samples, available: false, intervalMs: 500, reason: "The bundled process sampler currently supports Windows only.", stop() {} };
  }
  const command = "$ErrorActionPreference='SilentlyContinue'; while ($true) { $p=@(Get-Process -Name ollama,llama-server -ErrorAction SilentlyContinue); $m=($p | Measure-Object -Property WorkingSet64 -Sum).Sum; $c=($p | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum; @{time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ramBytes=$m; cpuSeconds=$c; count=$p.Count} | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 500 }";
  let child;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { samples, available: false, intervalMs: 500, reason: "The local model process sampler could not start.", stop() {} };
  }
  let buffer = "";
  let failed = false;
  child.on("error", () => { failed = true; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let lineEnd;
    while ((lineEnd = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      try {
        const sample = JSON.parse(line);
        if (Number.isFinite(sample.time) && Number.isFinite(sample.ramBytes)
            && Number.isFinite(sample.cpuSeconds) && Number.isFinite(sample.count)) samples.push(sample);
      } catch { /* An unavailable sample is recorded as missing, never as zero. */ }
    }
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
  return {
    samples,
    available: !failed,
    intervalMs: 500,
    reason: failed ? "The local model process sampler failed after startup." : null,
    stop() { if (!child.killed) child.kill(); },
  };
}

function resourceWindow(samples, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { sampleCount: 0, peakSampledRamBytes: null, cpuSecondsSampled: null, averageCpuPercentOfMachine: null };
  }
  const inside = samples.filter((sample) => sample.time >= startMs && sample.time <= endMs && sample.count > 0);
  const first = inside[0];
  const last = inside.at(-1);
  const cpuSeconds = first && last && last.time > first.time && last.cpuSeconds >= first.cpuSeconds
    ? last.cpuSeconds - first.cpuSeconds : null;
  return {
    sampleCount: inside.length,
    peakSampledRamBytes: inside.length ? Math.max(...inside.map((sample) => sample.ramBytes)) : null,
    cpuSecondsSampled: cpuSeconds === null ? null : Number(cpuSeconds.toFixed(3)),
    averageCpuPercentOfMachine: cpuSeconds === null ? null
      : Number((cpuSeconds / ((last.time - first.time) / 1000) / Math.max(1, cpus().length) * 100).toFixed(2)),
  };
}

function check(id, passed, detail) {
  return { id, status: passed ? "pass" : "fail", detail };
}

function unavailableCheck(id, detail) {
  return { id, status: "not_available", detail };
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

export function evaluateRealBenchmarkStructure({ scenario, result, records, ledgerBytes, modelSessions }) {
  const checks = [];
  const template = getWorkflowTemplate(scenario.topology.templateId);
  const expectedAgents = template.steps.map((step) => step.agentId);
  const expectedSteps = template.steps.map((step) => step.stepId);
  const actualAgents = result?.steps?.map((step) => step.agentId) || [];
  const actualSteps = result?.steps?.map((step) => step.stepId) || [];
  checks.push(check("result_identity", result?.templateId === scenario.topology.templateId && result?.clientId === scenario.clientId,
    "Result template and client must match the fixed scenario."));
  checks.push(check("fixed_topology", exactArray(actualAgents, expectedAgents) && exactArray(actualSteps, expectedSteps),
    "Step and named-agent order must match the fixed runtime template."));
  checks.push(check("terminal_step_states", result?.steps?.length === expectedSteps.length
    && result.steps.every((step) => TERMINAL_STATUSES.has(step.status)),
  "Every fixed step must end in completed, failed, or blocked state."));
  checks.push(check("authorized_client_scope", records.length > 0 && records.every((record) => record.clientId === scenario.clientId),
    "Every ledger record must remain inside the runner's single authorized client."));
  checks.push(check("workflow_scope", records.length > 0 && new Set(records.map((record) => record.workflowId)).size === 1
    && records.every((record) => record.workflowId === result?.workflowId),
  "Every ledger record must belong to the reported workflow."));
  checks.push(check("jsonl_storage_accounting", Number.isSafeInteger(ledgerBytes) && ledgerBytes > 0
    && result?.metrics?.storedBytes === ledgerBytes,
  "Measured JSONL bytes must equal the runtime's stored-byte total."));
  checks.push(check("jsonl_records_parseable", records.length > 0
    && records.every((record) => isPlainObject(record) && record.schemaVersion === 1 && WORKFLOW_STATUSES.includes(record.status)),
  "Every nonempty JSONL line must parse as a versioned workflow record."));

  const expectedEdges = scenario.topology.edges.map((edge) => `${edge.fromAgentId}->${edge.toAgentId}`);
  const actualEdges = (result?.handoffs || []).map((handoff) => `${handoff.fromAgentId}->${handoff.toAgentId}`);
  checks.push(check("fixed_handoff_chain", result?.status === "completed"
    ? exactArray(actualEdges, expectedEdges)
    : actualEdges.every((edge) => expectedEdges.includes(edge)),
  "Completed workflows require the exact chain; incomplete workflows may contain only its valid prefix."));

  const toolAuditValid = (result?.steps || []).every((step) => {
    const allowed = getAgentProfile(step.agentId).allowedTools;
    return Array.isArray(step.toolAudit) && step.toolAudit.every((entry) => typeof entry?.name === "string"
      && allowed.includes(entry.name) && typeof entry.ok === "boolean");
  });
  checks.push(check("tool_audit_shape", toolAuditValid,
    "Every recorded tool call must name a tool allowed for that fixed agent and expose a boolean outcome."));

  const sessionPairs = modelSessions.map((session) => `${session.stepId}:${session.agentId}`);
  const expectedPairs = template.steps.map((step) => `${step.stepId}:${step.agentId}`);
  checks.push(check("model_session_attribution", result?.status === "completed"
    ? exactArray(sessionPairs, expectedPairs)
    : sessionPairs.every((pair, index) => pair === expectedPairs[index]),
  "Model sessions must map to the fixed step order without extra agents."));

  const calls = modelSessions.flatMap((session) => session.calls);
  const reportedUsage = calls.filter((call) => call.usageMetadata);
  if (!reportedUsage.length) {
    checks.push(unavailableCheck("provider_token_metadata", "Ollama/LangChain did not expose usage metadata for these calls."));
  } else {
    const validUsage = reportedUsage.every((call) => {
      const usage = call.usageMetadata;
      return Object.values(usage).every((value) => typeof value === "number" || isPlainObject(value));
    });
    checks.push(check("provider_token_metadata", validUsage,
      "Available provider token metadata must contain nonnegative numeric values only."));
  }

  return {
    policy: "Deterministic structure only; no model-prose or business-correctness grading.",
    checks,
    summary: countBy(checks.map((item) => item.status)),
  };
}

function aggregateUsage(modelSessions) {
  const calls = modelSessions.flatMap((session) => session.calls);
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let providerReportedCallCount = 0;
  for (const call of calls) {
    const usage = call.usageMetadata;
    if (!usage) continue;
    providerReportedCallCount += 1;
    totals.inputTokens += usage.input_tokens || 0;
    totals.outputTokens += usage.output_tokens || 0;
    totals.totalTokens += usage.total_tokens || 0;
  }
  return {
    callCount: calls.length,
    providerReportedCallCount,
    providerMissingCallCount: calls.length - providerReportedCallCount,
    totals: providerReportedCallCount ? totals : null,
  };
}

function toolSummary(steps) {
  const audits = steps.flatMap((step) => step.toolAudit || []);
  return {
    callCount: audits.length,
    successfulCallCount: audits.filter((entry) => entry.ok === true).length,
    failedCallCount: audits.filter((entry) => entry.ok !== true).length,
    callsByName: countBy(audits.map((entry) => entry.name || "unknown")),
  };
}

function scenarioReport({ scenario, result, records, ledgerBuffer, modelSessions, sampler, startedAtMs, finishedAtMs, effectiveBudget }) {
  const structure = evaluateRealBenchmarkStructure({
    scenario,
    result,
    records,
    ledgerBytes: ledgerBuffer.byteLength,
    modelSessions,
  });
  const sessionByStep = new Map(modelSessions.map((session) => [session.stepId, session]));
  const steps = result.steps.map((step) => {
    const session = sessionByStep.get(step.stepId);
    return {
      stepId: step.stepId,
      agentId: step.agentId,
      departmentId: step.departmentId,
      status: step.status,
      error: step.error,
      answer: step.output,
      evidence: step.evidence,
      toolAudit: step.toolAudit,
      measurements: {
        workflowStepWallMs: step.metrics.durationMs,
        modelCalls: step.metrics.modelCalls,
        toolCalls: step.metrics.toolCalls,
        inputTokens: step.metrics.inputTokens,
        outputTokens: step.metrics.outputTokens,
        totalTokens: step.metrics.totalTokens,
        toolFailureCount: step.toolAudit.filter((entry) => entry.ok !== true).length,
        modelProcess: resourceWindow(sampler.samples, session?.modelSessionStartedAtMs, session?.modelSessionFinishedAtMs),
      },
      ollamaCalls: session?.calls || [],
    };
  });
  return {
    scenarioId: scenario.id,
    complexity: scenario.complexity,
    topology: scenario.topology,
    objective: scenario.objective,
    clientId: scenario.clientId,
    authorizedClientIds: [scenario.clientId],
    status: result.status,
    workflowId: result.workflowId,
    effectiveBudget,
    execution: {
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      sequential: true,
      isolatedStorage: true,
      runnerClosed: false,
      ephemeralStorageRemoved: false,
    },
    measurements: {
      workflowWallMs: finishedAtMs - startedAtMs,
      summedStepWallMs: result.steps.reduce((sum, step) => sum + step.metrics.durationMs, 0),
      durationNote: "Workflow wall time is measured end to end; summed step wall time is reported separately and is not substituted for it.",
      runtime: result.metrics,
      tools: toolSummary(result.steps),
      ollamaTokenMetadata: aggregateUsage(modelSessions),
      modelProcess: resourceWindow(sampler.samples, startedAtMs, finishedAtMs),
      storage: {
        format: "JSONL",
        bytes: ledgerBuffer.byteLength,
        recordCount: records.length,
        recordsByType: countBy(records.map((record) => record.recordType)),
        recordsByStatus: countBy(records.map((record) => record.status)),
      },
    },
    steps,
    handoffs: result.handoffs,
    answerAndEvidenceReview: "Preserved verbatim below each step; not semantically graded.",
    structuralChecks: structure,
    humanReview: null,
  };
}

async function runScenario({ scenario, remainingSuiteMs, sampler, env }) {
  const effectiveBudget = { ...scenario.budget, maxDurationMs: Math.max(1, Math.min(scenario.budget.maxDurationMs, remainingSuiteMs)) };
  const storageDir = await mkdtemp(join(tmpdir(), `neurohands-${scenario.id}-`));
  const template = getWorkflowTemplate(scenario.topology.templateId);
  const collector = instrumentedModelFactory(scenario);
  const localState = { memory: Object.create(null), tasks: [] };
  const lifecycle = await withIsolatedWorkflowLifecycle({
    storageDir,
    createRunner: () => createWorkflowRunner({
      storageDir,
      authorizedClientIds: [scenario.clientId],
      env,
      modelFactory: collector.factory,
      async toolExecutor(name, args, context) {
        context.signal.throwIfAborted();
        return executeLocalSkill(name, args, {
          clientId: context.clientId,
          memory: localState.memory,
          tasks: localState.tasks,
          signal: context.signal,
        });
      },
    }),
  }, async (runner) => {
    await runner.initialize();
    const workflowId = `${scenario.id}-workflow`;
    const startedAtMs = Date.now();
    const result = await runner.run({
      templateId: template.templateId,
      clientId: scenario.clientId,
      workflowId,
      objective: scenario.objective,
      idempotencyKey: `${scenario.id}-request`,
      budget: effectiveBudget,
    });
    const finishedAtMs = Date.now();
    const records = await runner.readRecords({ clientId: scenario.clientId, workflowId });
    const ledgerBuffer = await readFile(runner.ledgerPath);
    return scenarioReport({ scenario, result, records, ledgerBuffer, modelSessions: collector.sessions, sampler, startedAtMs, finishedAtMs, effectiveBudget });
  });
  const report = lifecycle.value;
  report.execution.runnerClosed = lifecycle.runnerClosed;
  report.execution.ephemeralStorageRemoved = lifecycle.storageRemoved;
  return report;
}

export async function withIsolatedWorkflowLifecycle({ storageDir, createRunner, removeStorage = (target) => rm(target, { recursive: true, force: true }) }, action) {
  if (typeof storageDir !== "string" || typeof createRunner !== "function" || typeof removeStorage !== "function" || typeof action !== "function") {
    throw new Error("Workflow lifecycle inputs are invalid.");
  }
  let runner;
  let value;
  let primaryError;
  let cleanupError;
  let runnerClosed = false;
  let storageRemoved = false;
  try {
    runner = createRunner();
    value = await action(runner);
  } catch (error) {
    primaryError = error;
  } finally {
    if (runner) {
      try {
        await runner.close();
        runnerClosed = true;
      } catch (error) {
        cleanupError ||= error;
      }
    }
    try {
      await removeStorage(storageDir);
      storageRemoved = true;
    } catch (error) {
      cleanupError ||= error;
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return { value, runnerClosed, storageRemoved };
}

function skippedScenario(scenario, reason) {
  return {
    scenarioId: scenario.id,
    complexity: scenario.complexity,
    topology: scenario.topology,
    objective: scenario.objective,
    clientId: scenario.clientId,
    authorizedClientIds: [scenario.clientId],
    status: "not_run_suite_timeout",
    reason,
    steps: [],
    handoffs: [],
    humanReview: null,
  };
}

async function saveReport(outputPath, report) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(ROOT, `artifacts/benchmarks/${timestamp}-real-named-workflow.json`);
}

function resolveOutputPath(value) {
  const outputPath = value ? (isAbsolute(value) ? resolve(value) : resolve(ROOT, value)) : defaultOutputPath();
  if (dirname(outputPath) === outputPath) throw new Error("The benchmark output path must name a file.");
  return outputPath;
}

export async function runRealNamedWorkflowBenchmark({ topology = "all", suiteTimeoutMs = DEFAULT_SUITE_TIMEOUT_MS, output = null, env = process.env, onProgress = () => {} } = {}) {
  if (!Object.hasOwn(TOPOLOGY_SELECTIONS, topology)) throw new Error("Use topology all, individual, pair, or full_department.");
  if (!Number.isSafeInteger(suiteTimeoutMs) || suiteTimeoutMs < MIN_SUITE_TIMEOUT_MS || suiteTimeoutMs > MAX_SUITE_TIMEOUT_MS) {
    throw new Error(`Suite time limit must be an integer from ${MIN_SUITE_TIMEOUT_MS} to ${MAX_SUITE_TIMEOUT_MS} milliseconds.`);
  }
  disableExternalTracing(process.env);
  if (env !== process.env) disableExternalTracing(env);
  const { fixture, text } = await readRealBenchmarkFixture();
  const settings = validateConfiguredModel(env);
  const selected = selectedScenarios(fixture, topology);
  if (!selected.length) throw new Error("The requested benchmark topology is absent from the fixed fixture.");
  const outputPath = resolveOutputPath(output);
  const source = await provenance(text);
  const model = await localModelIdentity(settings);
  const machine = machineEnvironment(settings);
  const sampler = await startModelProcessSampler();
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + suiteTimeoutMs;
  const report = {
    schemaVersion: 1,
    benchmarkId: `${fixture.suiteId}-${new Date(startedAtMs).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    scope: fixture.scope,
    selectedTopology: topology,
    executionOrder: selected.map((scenario) => scenario.id),
    executionMode: "sequential",
    suiteTimeoutMs,
    environment: machine,
    model,
    generation: {
      temperature: 0.2,
      seed: 42,
      contextTokens: 4096,
      outputTokensPerCall: 256,
      think: false,
    },
    restrictions: {
      network: "loopback Ollama only",
      productionServices: false,
      externalConnectors: false,
      langsmithUpload: false,
      tracingEnvironmentForcedOff: Object.fromEntries(TRACE_ENV_KEYS.map((key) => [key, env[key] === "false"])),
      fixtureContainsOnlySyntheticData: true,
      networkEnforcement: "Validated loopback Ollama base URL, same-origin request wrapper, fixed local tools, and tracing forced off.",
    },
    processSampling: {
      available: sampler.available,
      intervalMs: sampler.intervalMs,
      scope: "All local ollama and llama-server processes; excludes runner and whole-machine peaks.",
      reason: sampler.reason,
    },
    provenance: source,
    grading: {
      automatic: "deterministic structural checks only",
      semanticCorrectness: "not automatically graded from model prose",
      humanReview: null,
    },
    comparisonCaution: fixture.scope.comparisonCaution,
    limitations: [
      "Loopback-only access is enforced by benchmark application checks and tracing-off settings; this is not a process-wide network sandbox or operating-system firewall.",
      "The three topologies have different duties and task complexity, so their outputs are not a fair model-quality comparison or evidence of optimization.",
      "Model prose is preserved for human review and is not automatically graded for semantic correctness.",
      "Ollama/LangChain may omit token metadata; absent values remain null or not_available.",
      "CPU and RAM are sampled for all local Ollama model processes, so short calls may have no sample and concurrent local inference can affect measurements.",
    ],
    scenarios: [],
    humanReview: null,
  };
  await saveReport(outputPath, report);
  try {
    for (const scenario of selected) {
      const remainingSuiteMs = deadlineMs - Date.now();
      if (remainingSuiteMs < 1_000) {
        report.scenarios.push(skippedScenario(scenario, "The bounded suite duration was exhausted before this scenario started."));
        await saveReport(outputPath, report);
        continue;
      }
      onProgress({ event: "scenario_started", scenarioId: scenario.id, remainingSuiteMs });
      try {
        const entry = await runScenario({ scenario, remainingSuiteMs, sampler, env });
        report.scenarios.push(entry);
        onProgress({ event: "scenario_finished", scenarioId: scenario.id, status: entry.status, wallMs: entry.measurements.workflowWallMs });
      } catch (error) {
        report.scenarios.push({
          ...skippedScenario(scenario, "The local runtime failed before a complete scenario report could be built."),
          status: "runner_error",
          error: safeError(error),
        });
        onProgress({ event: "scenario_finished", scenarioId: scenario.id, status: "runner_error" });
      }
      await saveReport(outputPath, report);
    }
  } finally {
    sampler.stop();
    report.status = "finished";
    report.finishedAt = new Date().toISOString();
    report.measurements = {
      suiteWallMs: Date.now() - startedAtMs,
      scenarioCount: report.scenarios.length,
      executedScenarioCount: report.scenarios.filter((scenario) => !scenario.status.startsWith("not_run")).length,
    };
    await saveReport(outputPath, report);
  }
  return { report, outputPath };
}

function helpText() {
  return [
    "Real local Qwen named-agent workflow benchmark",
    "",
    "Validation only (no model inference, network request, or artifact write):",
    "  node scripts/real-named-workflow-benchmark.mjs --dry-run",
    "  node scripts/real-named-workflow-benchmark.mjs check",
    "",
    "Run all fixed topologies sequentially:",
    "  node scripts/real-named-workflow-benchmark.mjs",
    "",
    "Run one topology:",
    "  node scripts/real-named-workflow-benchmark.mjs --topology individual",
    "  node scripts/real-named-workflow-benchmark.mjs --topology pair",
    "  node scripts/real-named-workflow-benchmark.mjs --topology full_department",
    "",
    "Options: --suite-timeout-ms 900000 --out artifacts/benchmarks/report.json",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), io = console) {
  const options = parseRealBenchmarkArgs(argv);
  if (options.help) {
    io.log(helpText());
    return { mode: "help" };
  }
  loadLabEnvironment();
  disableExternalTracing(process.env);
  if (options.dryRun) {
    const result = await buildRealBenchmarkDryRun({ topology: options.topology, env: process.env });
    io.log(JSON.stringify(result, null, 2));
    return result;
  }
  const result = await runRealNamedWorkflowBenchmark({
    topology: options.topology,
    suiteTimeoutMs: options.suiteTimeoutMs,
    output: options.output,
    env: process.env,
    onProgress: (event) => io.log(JSON.stringify(event)),
  });
  io.log(JSON.stringify({ event: "benchmark_finished", report: relative(ROOT, result.outputPath), scenarios: result.report.scenarios.length }));
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", error: safeError(error) })}\n`);
    process.exitCode = 1;
  });
}
