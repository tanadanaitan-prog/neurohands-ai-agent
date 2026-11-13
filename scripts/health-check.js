"use strict";

const http = require("node:http");

async function probeEndpoint(baseUrl, pathname, timeoutMs = 5000, fetchImpl = globalThis.fetch) {
  const target = new URL(pathname, baseUrl).toString();
  const res = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function runHealthCheck({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) {
    throw new TypeError("A valid http(s) baseUrl is required");
  }
  const root = await probeEndpoint(baseUrl, "/", timeoutMs, fetchImpl);
  const version = await probeEndpoint(baseUrl, "/version", timeoutMs, fetchImpl);
  const ready = await probeEndpoint(baseUrl, "/ready", timeoutMs, fetchImpl);

  const checks = {
    gateway_alive: root.status === 200 && root.text.includes("Neurohands"),
    version_ok: version.status === 200 && typeof version.json?.version === "string",
    readiness_ok: ready.status === 200 && ready.json?.ready === true,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    checkedAt: new Date().toISOString(),
    version: version.json?.version || null,
    checks,
    statuses: { root: root.status, version: version.status, ready: ready.status },
  };
}

// Self-contained deliberate failure drill (TASK-035 / G7): spins up an isolated
// local HTTP probe server, verifies healthy pass -> injected 503 failure detection -> recovery.
async function runDeliberateFailureDrill() {
  let injectOutage = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Neurohands v3.10 agent gateway is running");
      return;
    }
    if (req.url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "3.10.0", commit: "drill-local" }));
      return;
    }
    if (req.url === "/ready") {
      const code = injectOutage ? 503 : 200;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: !injectOutage }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await runHealthCheck({ baseUrl });
    injectOutage = true;
    const duringOutage = await runHealthCheck({ baseUrl });
    injectOutage = false;
    const recovered = await runHealthCheck({ baseUrl });

    const drillPassed = before.ok === true && duringOutage.ok === false &&
      duringOutage.statuses.ready === 503 && recovered.ok === true;
    return {
      drillPassed,
      phases: {
        baseline_healthy: before.ok,
        outage_detected: !duringOutage.ok && duringOutage.statuses.ready === 503,
        recovery_confirmed: recovered.ok,
      },
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--drill")) {
      const drill = await runDeliberateFailureDrill();
      process.stdout.write(`${JSON.stringify(drill)}\n`);
      process.exitCode = drill.drillPassed ? 0 : 1;
      return;
    }
    const baseUrl = process.env.NEUROHANDS_HEALTH_URL || args[0] || "http://127.0.0.1:3000";
    const result = await runHealthCheck({ baseUrl });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  })().catch(() => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "health_probe_unreachable" })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runHealthCheck, runDeliberateFailureDrill };
