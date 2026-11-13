const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createStudioRouter } = require("../src/platform/router");

async function fetchStudioConfig(t, options) {
  const app = express();
  app.use("/api/studio", createStudioRouter(options));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/studio/config`);
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

test("GET /api/studio/config defaults runtimeConnected to false with no-store caching", async (t) => {
  const { status, cacheControl, body } = await fetchStudioConfig(t, { environment: {} });
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(body.configured, false);
  assert.equal(body.runtimeConnected, false);
});

test("GET /api/studio/config reflects async probeRuntime readiness without failing on errors", async (t) => {
  const environment = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  };

  const connected = await fetchStudioConfig(t, {
    environment,
    probeRuntime: async () => "ready",
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.configured, true);
  assert.equal(connected.body.runtimeConnected, true);

  const offline = await fetchStudioConfig(t, {
    environment,
    probeRuntime: async () => false,
  });
  assert.equal(offline.status, 200);
  assert.equal(offline.body.runtimeConnected, false);

  const failing = await fetchStudioConfig(t, {
    environment,
    probeRuntime: async () => {
      throw new Error("probe unavailable");
    },
  });
  assert.equal(failing.status, 200);
  assert.equal(failing.body.runtimeConnected, false);
});

async function fetchServerStudioConfig(t, envOverrides) {
  const serverPath = require.resolve("../src/server");
  const snapshot = { ...process.env };
  delete require.cache[serverPath];
  Object.assign(process.env, envOverrides);
  t.after(() => {
    delete require.cache[serverPath];
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  });

  const { app } = require(serverPath);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/studio/config`);
  return { status: response.status, body: await response.json() };
}

test("server ENABLE_STUDIO=true aligns runtimeConnected with publicConfiguration and in-process runtime", async (t) => {
  const gatewayOnly = await fetchServerStudioConfig(t, {
    ENABLE_STUDIO: "true",
    SOFTWARE_ADMISSION_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_KEY: "sb_secret_fixture",
    SUPABASE_PUBLISHABLE_KEY: "",
  });
  assert.equal(gatewayOnly.status, 200);
  assert.equal(gatewayOnly.body.configured, false);
  assert.equal(gatewayOnly.body.runtimeConnected, false);

  const studioConfigured = await fetchServerStudioConfig(t, {
    ENABLE_STUDIO: "true",
    SOFTWARE_ADMISSION_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_KEY: "",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  });
  assert.equal(studioConfigured.status, 200);
  assert.equal(studioConfigured.body.configured, true);
  assert.equal(studioConfigured.body.runtimeConnected, true);
});
