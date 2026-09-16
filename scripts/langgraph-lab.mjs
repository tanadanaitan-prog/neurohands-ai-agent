import { loadEnvFile } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] || "check";
const envFile = resolve(root, ".env.langgraph");
if (existsSync(envFile)) loadEnvFile(envFile);

// Explicit callbacks below trace ONLY the fixed synthetic check. A general
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

async function trace() {
  if (!process.env.LANGSMITH_API_KEY?.trim().startsWith("lsv2_")) {
    console.error("LangSmith key missing. Save it privately after LANGSMITH_API_KEY= in .env.langgraph, then run npm run lab:trace again.");
    process.exitCode = 1;
    return;
  }
  const { Client } = await import("langsmith");
  const { LangChainTracer } = await import("@langchain/core/tracers/tracer_langchain");
  const { graph } = await import("../src/agent/graph.mjs");
  const projectName = process.env.LANGSMITH_PROJECT || "neurohands-local-test";
  const client = new Client({ timeout_ms: 15000, tracingSamplingRate: 1 });
  const tracer = new LangChainTracer({ client, projectName });
  const runId = randomUUID();
  const result = await graph.invoke(input, {
    callbacks: [tracer],
    runId,
    runName: "neurohands-synthetic-connection-check",
    tags: ["synthetic", "no-llm", "local-lab"],
    metadata: { purpose: "connection-check", contains_customer_data: false },
  });
  assert.equal(result.messages.at(-1).content, expected);
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
    console.error("The local graph worked, but its completed LangSmith trace was not verified. Check key expiry, workspace and endpoint in .env.langgraph. No model was called.");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    status: "passed",
    langsmithUpload: "verified by reading the completed run",
    project: projectName,
    runId,
    reply: expected,
    modelCalls: 0,
    inputType: "fixed synthetic message",
  }, null, 2));
}

async function studio() {
  const manifestPath = resolve(root, "node_modules/@langchain/langgraph-cli/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.langgraphjs;
  if (!entry) throw new Error("LangGraph CLI entry is unavailable.");
  console.log("Starting the local test graph on http://127.0.0.1:2024. Automatic tracing is OFF. Use fictional input only; press Ctrl+C to stop.");
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
  else if (mode === "studio") await studio();
  else {
    console.error("Choose check, trace or studio.");
    process.exitCode = 1;
  }
} catch {
  console.error(`The LangGraph ${mode} step failed. Check dependencies and the private .env.langgraph settings. No production workflow was changed.`);
  process.exitCode = 1;
}
