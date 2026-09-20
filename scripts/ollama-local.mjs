import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

// Start only a local, cloud-disabled model server. No credentials are required.
export async function ensureLocalOllama(baseUrl, root) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The model lab requires a local Ollama address.");
  }
  const ready = async () => {
    try {
      const response = await fetch(new URL("/api/version", url), { signal: AbortSignal.timeout(1500) });
      return response.ok && typeof (await response.json()).version === "string";
    } catch { return false; }
  };
  if (await ready()) return;

  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.LAB_OLLAMA_EXE,
    localAppData && join(localAppData, "Programs", "Ollama", "ollama.exe"),
    localAppData && join(localAppData, "Neurohands", "ollama-0.34.1", "ollama.exe"),
  ].filter(Boolean);
  const executable = candidates.find((file) => existsSync(file)) || "ollama";
  const logDir = join(root, ".tmp");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, "ollama-local.log"), "a");
  const modelDir = localAppData && join(localAppData, "Neurohands", "models");
  const child = spawn(executable, ["serve"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      OLLAMA_HOST: `${url.hostname}:${url.port || "80"}`,
      OLLAMA_NO_CLOUD: "1",
      OLLAMA_NUM_PARALLEL: "1",
      OLLAMA_MAX_LOADED_MODELS: "1",
      ...(executable.includes("Neurohands") && modelDir ? { OLLAMA_MODELS: modelDir } : {}),
    },
  });
  closeSync(log);
  let failed = false;
  child.on("error", () => { failed = true; });
  child.unref();
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (failed) break;
    if (await ready()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("Ollama did not start. Install Ollama or set LAB_OLLAMA_EXE in .env.langgraph, then run lab:studio again.");
}
