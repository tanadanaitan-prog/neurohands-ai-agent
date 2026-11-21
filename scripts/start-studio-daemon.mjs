import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { getLocalChatConfig } from "../src/agent/chat.mjs";
import { ensureLocalOllama } from "./ollama-local.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = resolve(root, ".env.langgraph");
if (existsSync(envFile)) loadEnvFile(envFile);

const STUDIO_HOST = "127.0.0.1";
const STUDIO_PORT = 2024;
const REQUIRED_GRAPHS = ["neurohands_test", "neurohands_chat", "neurohands_concierge", "neurohands_aria", "neurohands_jarvis"];

async function probeOllama(baseUrl) {
  try {
    const res = await fetch(new URL("/api/version", baseUrl), { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.version === "string";
  } catch {
    return false;
  }
}

export function resolveLangGraphCliPath() {
  const manifestPath = resolve(root, "node_modules/@langchain/langgraph-cli/package.json");
  if (!existsSync(manifestPath)) throw new Error("LangGraph CLI package is missing.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.langgraphjs;
  if (!entry) throw new Error("LangGraph CLI entry is unavailable.");
  return resolve(dirname(manifestPath), entry);
}

export async function inspectStudioDaemonReadiness() {
  const config = getLocalChatConfig();
  const configPath = resolve(root, "langgraph.json");
  if (!existsSync(configPath)) throw new Error("langgraph.json is missing.");
  const manifest = JSON.parse(readFileSync(configPath, "utf8"));
  const graphs = manifest?.graphs && typeof manifest.graphs === "object" ? Object.keys(manifest.graphs) : [];
  const missingGraphs = REQUIRED_GRAPHS.filter((name) => !graphs.includes(name));
  if (missingGraphs.length > 0) {
    throw new Error(`Missing LangGraph definitions: ${missingGraphs.join(", ")}`);
  }
  resolveLangGraphCliPath();
  const ollamaReachable = await probeOllama(config.baseUrl);
  return {
    ok: true,
    mode: "check",
    host: STUDIO_HOST,
    port: STUDIO_PORT,
    ollamaBaseUrl: config.baseUrl,
    ollamaModel: config.model,
    ollamaReachable,
    graphs,
  };
}

export async function startStudioDaemon() {
  const config = getLocalChatConfig();
  await ensureLocalOllama(config.baseUrl, root);
  const cliPath = resolveLangGraphCliPath();
  // Tracing disables come AFTER ...process.env so caller shell variables cannot send local dev telemetry externally.
  const env = {
    ...process.env,
    LANGSMITH_TRACING: "false",
    LANGSMITH_TRACING_V2: "false",
    LANGCHAIN_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
    LANGCHAIN_CALLBACKS_BACKGROUND: "false",
    LANGGRAPH_CLI_NO_ANALYTICS: "1",
  };
  // Spawn node directly on the CLI JS entrypoint because Windows Node 24 rejects .cmd shims without a shell.
  const child = spawn(process.execPath, [cliPath, "dev", "--host", STUDIO_HOST, "--port", String(STUDIO_PORT), "--no-browser"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  child.on("error", (err) => {
    console.error(`Failed to start local Studio daemon: ${err?.message || "spawn error"}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  return child;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("start-studio-daemon.mjs")) {
  const isCheck = process.argv.includes("--check");
  if (isCheck) {
    const status = await inspectStudioDaemonReadiness();
    console.log(JSON.stringify(status, null, 2));
  } else {
    await startStudioDaemon();
  }
}
