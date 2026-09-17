import { loadEnvFile } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import admissionControl from "../src/lib/admission-control.js";
import passportTools from "../src/lib/software-passports.js";

const { admitPassportAction, createInMemoryCapacityStore } = admissionControl;
const { loadPassportRegister } = passportTools;

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] || "check";
const envFile = resolve(root, ".env.langgraph");
if (existsSync(envFile)) loadEnvFile(envFile);

// Explicit callbacks below trace ONLY the fixed synthetic checks. A general
// environment setting must not turn offline or interactive lab runs into uploads.
process.env.LANGSMITH_TRACING = "false";
process.env.LANGSMITH_TRACING_V2 = "false";
process.env.LANGCHAIN_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
process.env.LANGGRAPH_CLI_NO_ANALYTICS = "1";

const sample = "Hello Neurohands test";
const expected = `Neurohands LangGraph received: ${sample}`;
const input = { messages: [{ role: "user", content: sample }] };
const chatInput = { messages: [{ role: "user", content: "A fictional shop sold three notebooks at 40 baht each. What is the total? Answer in one short sentence." }] };
const agentInput = { messages: [{ role: "user", content: "Use your order tool to check the status of fictional order DEMO-ORDER-001, then tell me the status and expected ship date." }] };

async function prepareChat() {
  const { graph, readChatConfig } = await import("../src/agent/chat.mjs");
  const { ensureLocalOllama } = await import("./ollama-local.mjs");
  const settings = readChatConfig();
  await ensureLocalOllama(settings.baseUrl, root);
  return { graph, settings };
}

function chatReport(result, durationMs, model) {
  const reply = result.messages.at(-1);
  return {
    status: "completed",
    test: "one local LLM answer; not a business-agent acceptance test",
    model,
    reply: reply.content,
    durationMs: Math.round(durationMs),
    usage: reply.usage_metadata || null,
    modelCalls: 1,
    modelApiCost: 0,
  };
}

async function chat() {
  const { graph, settings } = await prepareChat();
  const start = performance.now();
  const result = await graph.invoke(chatInput, { runName: "neurohands-local-model-check" });
  console.log(JSON.stringify({ ...chatReport(result, performance.now() - start, settings.model), langsmithUpload: false }, null, 2));
}

async function check() {
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("Network access is disabled in the offline lab check.");
  };
  try {
    const { graph } = await import("../src/agent/graph.mjs");
    const start = performance.now();
    const result = await graph.invoke(input, { runName: "neurohands-offline-check" });
    assert.equal(result.messages.at(-1).content, expected);
    assert.equal(networkAttempts, 0, "The offline test attempted a network request.");
    console.log(JSON.stringify({
      status: "passed",
      test: "local workflow connection only; no LLM",
      reply: result.messages.at(-1).content,
      durationMs: Math.round(performance.now() - start),
      modelCalls: 0,
      networkRequests: networkAttempts,
      langsmithUpload: false,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function trace(useModel = false, useAgent = false) {
  if (!process.env.LANGSMITH_API_KEY?.trim().startsWith("lsv2_")) {
    console.error("LangSmith key missing. Save it privately after LANGSMITH_API_KEY= in .env.langgraph, then run npm run lab:trace again.");
    process.exitCode = 1;
    return;
  }
  const register = loadPassportRegister();
  const gate = await admitPassportAction({
    serviceId: "langsmith",
    actionKey: `langsmith-synthetic-trace-${new Date().toISOString().slice(0, 10)}`,
    operation: "export_synthetic_trace",
    workflow: "langsmith_synthetic_trial",
    workload: "experiment",
  }, {
    register,
    capacityStore: createInMemoryCapacityStore(),
    trustedContext: {
      trustSource: "fixed_internal_cli", actor: "founder", dataClass: "synthetic",
      workload: "experiment", workflow: "langsmith_synthetic_trial", goalRelevant: true,
    },
  });
  if (!gate.allowed) {
    console.error(`LangSmith trace blocked by Software Passport admission: ${gate.code}. Verify the private account allowance before another upload.`);
    process.exitCode = 1;
    return;
  }
  const dispatched = await gate.markDispatched();
  if (!dispatched.ok) {
    console.error("LangSmith trace blocked because its capacity reservation could not be marked dispatched.");
    process.exitCode = 1;
    return;
  }
  try {
    await runTraceExport(useModel, useAgent);
    await gate.settle({ outcome: process.exitCode ? "transport_uncertain" : "completed" });
  } catch (error) {
    await gate.settle({ outcome: "transport_uncertain" });
    throw error;
  }
}

async function runTraceExport(useModel = false, useAgent = false) {
  const { Client } = await import("langsmith");
  const { LangChainTracer } = await import("@langchain/core/tracers/tracer_langchain");
  const prepared = useModel
    ? await prepareChat()
    : await import("../src/agent/graph.mjs");
  const settings = prepared.settings;
  const graph = useAgent ? (await import("../src/agent/team.mjs")).ariaGraph : prepared.graph;
  const projectName = process.env.LANGSMITH_PROJECT || "neurohands-local-test";
  const client = new Client({ timeout_ms: 15000, tracingSamplingRate: 1 });
  const tracer = new LangChainTracer({ client, projectName });
  const runId = randomUUID();
  const start = performance.now();
  const result = await graph.invoke(useAgent ? agentInput : useModel ? chatInput : input, {
    callbacks: [tracer],
    runId,
    runName: useAgent ? "neurohands-local-aria-tool-check" : useModel ? "neurohands-local-model-check" : "neurohands-synthetic-connection-check",
    tags: ["synthetic", useModel ? "local-llm" : "no-llm", "local-lab"],
    metadata: { purpose: "connection-check", contains_customer_data: false },
  });
  const durationMs = performance.now() - start;
  if (useAgent && (result.metrics?.stoppedReason !== "completed" || !result.toolAudit?.some((item) => item.name === "get_order_status" && item.ok))) {
    throw new Error("The local agent tool test did not complete successfully.");
  }
  if (!useModel) assert.equal(result.messages.at(-1).content, expected);
  await client.awaitPendingTraceBatches();

  // A local answer is not proof of upload. Read this exact trace back.
  let saved;
  const project = await client.readProject({ projectName });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const candidate = await client.runs.retrieve(runId, {
        project_id: project.id,
        selects: ["ID", "END_TIME", "OUTPUTS", "ERROR"],
      });
      if (candidate.end_time && candidate.outputs) {
        saved = candidate;
        break;
      }
    } catch {
      // Briefly allow for trace ingestion; never print credentials or raw errors.
    }
    if (attempt < 3) await new Promise((done) => setTimeout(done, 1000));
  }
  if (!saved || saved.error) {
    console.error("The local graph worked, but its completed LangSmith trace was not verified. Check key expiry, workspace and endpoint in .env.langgraph.");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ...(useModel ? chatReport(result, durationMs, settings.model) : { status: "passed", reply: expected, modelCalls: 0 }),
    ...(useAgent ? { test: "one local Aria tool workflow with fictional data", modelCalls: result.metrics.modelCalls, usage: { input_tokens: result.metrics.inputTokens, output_tokens: result.metrics.outputTokens, total_tokens: result.metrics.totalTokens }, toolAudit: result.toolAudit } : {}),
    langsmithUpload: "verified by reading the completed run",
    project: projectName,
    runId,
    inputType: "fixed synthetic message",
  }, null, 2));
}

async function studio() {
  await prepareChat();
  const manifestPath = resolve(root, "node_modules/@langchain/langgraph-cli/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.langgraphjs;
  if (!entry) throw new Error("LangGraph CLI entry is unavailable.");
  console.log("Starting Studio on http://127.0.0.1:2024. Select neurohands_concierge, neurohands_aria or neurohands_jarvis for local agent tools; neurohands_chat for plain chat; neurohands_test for echo. Automatic tracing is OFF. Use fictional input; press Ctrl+C to stop Studio.");
  // Run the CLI in this process so its own server shutdown handlers receive
  // Ctrl+C on Windows, instead of killing only an intermediate process.
  process.chdir(root);
  const cliPath = resolve(dirname(manifestPath), entry);
  process.argv = [process.execPath, cliPath, "dev",
    "--host", "127.0.0.1", "--port", "2024", "--no-browser",
  ];
  await import(pathToFileURL(cliPath).href);
}

try {
  if (mode === "check") await check();
  else if (mode === "trace") await trace();
  else if (mode === "chat") await chat();
  else if (mode === "chat-trace") await trace(true);
  else if (mode === "agent-trace") await trace(true, true);
  else if (mode === "studio") await studio();
  else {
    console.error("Choose check, trace, chat, chat-trace, agent-trace or studio.");
    process.exitCode = 1;
  }
} catch (error) {
  // These prefixes are application-authored messages, never raw SDK responses.
  const safeLocalError = /^(Cannot reach Ollama|The local model|Ollama did not start|LAB_OLLAMA|This lab only accepts|The model lab requires|Keep each new message|Add a nonempty|Add a Human|This test conversation|This conversation lab)/;
  console.error(safeLocalError.test(error?.message || "")
    ? error.message
    : `The LangGraph ${mode} step failed. Check dependencies and the private .env.langgraph settings. No production workflow was changed.`);
  process.exitCode = 1;
}
