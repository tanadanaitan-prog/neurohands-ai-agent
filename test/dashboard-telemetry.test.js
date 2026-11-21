"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");

const {
  hashActor,
  scrubPii,
  createDashboardTelemetry,
  createDashboardTelemetryRouter,
} = require("../src/lib/dashboard-telemetry");

test("nh_messages_telemetry PostgreSQL view hashes actors, masks PII, and denies anon", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  const sqlFiles = [
    "fixtures/legacy-schema.sql",
    "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql",
    "../supabase/migrations/20261102000001_per_business_chat_rollup.sql",
    "../supabase/migrations/20261117000001_dashboard_realtime_telemetry.sql",
  ];
  for (const relPath of sqlFiles) {
    await db.exec(fs.readFileSync(path.join(__dirname, relPath), "utf8"));
  }

  const rawUser = "Udeadbeef1234567890abcdef12345678";
  await db.query(
    `insert into public.messages(line_user_id, direction, text_content, answered_by, question_type, status)
     values ($1, 'in', $2, 'agent:ARIA', 'support', 'sent'), ($1, 'out', $3, 'agent:ARIA', 'support', 'sent')`,
    [
      rawUser,
      "Customer ID 1100501234567 formatted 1-1005-01234-56-7 phone 038-123-456 email 0812345678@knc-glass.co.th",
      `Ref ${rawUser} mobile +66 081-234-5678`,
    ],
  );

  await db.exec("set local role service_role;");
  const res = await db.query("select * from public.nh_messages_telemetry order by id asc");
  await db.exec("reset role;");

  assert.equal(res.rows.length, 2);
  const [row1, row2] = res.rows;
  assert.equal(row1.line_user_hash, hashActor(rawUser));
  assert.equal("line_user_id" in row1, false);
  assert.equal("text_content" in row1, false);
  assert.match(row1.masked_text, /\[EMAIL-REDACTED\]/);
  assert.match(row1.masked_text, /\[ID-REDACTED\].*\[ID-REDACTED\]/);
  assert.match(row1.masked_text, /\[PHONE-REDACTED\]/);
  assert.doesNotMatch(row1.masked_text, /1100501234567|1-1005-01234-56-7|038-123-456|0812345678|knc-glass/);
  assert.match(row2.masked_text, /\[LINE-ID-REDACTED\]/);
  assert.match(row2.masked_text, /\[PHONE-REDACTED\]/);
  assert.doesNotMatch(row2.masked_text, /Udeadbeef|081-234-5678|5678/);

  await assert.rejects(async () => {
    await db.exec("begin; set local role anon;");
    try {
      await db.query("select * from public.nh_messages_telemetry");
    } finally {
      await db.exec("rollback;");
    }
  }, /permission denied/i);
});

test("createDashboardTelemetry scrubs PII, tracks 2.5s Race SLA, and enforces rolling 60s window", () => {
  let clock = 1_700_000_000_000;
  const store = createDashboardTelemetry({
    maxEvents: 50,
    maxAgeMs: 60_000,
    raceSlaMs: 2500,
    now: () => clock,
  });

  const msg = store.recordMessage({
    lineUserId: "U99999",
    direction: "in",
    text: "Call +66 089-123-4567 or 038-123-456 ID 1-2345-67890-12-3 0812345678@example.com Uabcdef0123456789abcdef0123456789",
  });
  assert.equal(msg.actorHash, hashActor("U99999"));
  assert.doesNotMatch(msg.preview, /1-2345|038-123|0812345678|example\.com|89-123|Uabcdef/);
  assert.equal(scrubPii("x".repeat(200)).length, 140);
  assert.equal(store.snapshot().stats.slaCompliancePct, null);

  store.recordRun({ runId: 101, agentCode: "ARIA", department: "support", status: "completed", iterations: 1, latencyMs: 1200 });
  store.recordRun({ runId: 102, agentCode: "SURI", department: "sales", status: "completed", iterations: 2, latencyMs: 2480 });
  store.recordRaceOutcome({ runId: 102, racedToChecking: true, latencyMs: 2540, lane: "agent:SURI", ok: true });

  const snap = store.snapshot({ providers: { gemini: "ok" } });
  assert.equal(snap.stats.totalRuns, 2);
  assert.equal(snap.stats.completedRuns, 2);
  assert.equal(snap.stats.checkingRaces, 1);
  assert.equal(snap.stats.slaCompliancePct, 50);
  assert.equal(snap.stats.p95LatencyMs, 2540);
  assert.equal(snap.providers.gemini, "ok");

  clock += 65_000;
  assert.equal(store.eventsSince(0).length, 0);
  assert.equal(store.snapshot().stats.totalRuns, 0);
  assert.equal(store.snapshot().stats.slaCompliancePct, null);
});

test("dashboard telemetry router enforces x-api-key and streams SSE with Last-Event-ID replay", async (t) => {
  const store = createDashboardTelemetry({ maxEvents: 50, maxAgeMs: 60_000 });
  const unconfiguredApp = express();
  unconfiguredApp.use("/api/dashboard", createDashboardTelemetryRouter({ telemetry: store, apiKey: "" }));
  const s1 = http.createServer(unconfiguredApp);
  await new Promise((resolve) => s1.listen(0, "127.0.0.1", resolve));
  t.after(() => s1.close());
  const port1 = s1.address().port;
  const res503 = await fetch(`http://127.0.0.1:${port1}/api/dashboard/snapshot`);
  assert.equal(res503.status, 503);

  const apiKey = "nh-test-dashboard-secret";
  const app = express();
  app.use("/api/dashboard", createDashboardTelemetryRouter({
    telemetry: store,
    apiKey,
    heartbeatMs: 500,
    getProviderStatus: () => ({ gemini: "ok", fallback: "disabled" }),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauth = await fetch(`${baseUrl}/api/dashboard/snapshot`, { headers: { "x-api-key": "wrong" } });
  assert.equal(unauth.status, 401);

  const e1 = store.recordMessage({ lineUserId: "U1", direction: "in", text: "Hello ARIA" });
  const e2 = store.recordRun({ runId: 7, agentCode: "ARIA", status: "completed", latencyMs: 900 });
  assert.ok(e2.id > e1.id);

  const snapRes = await fetch(`${baseUrl}/api/dashboard/snapshot`, { headers: { "x-api-key": apiKey } });
  assert.equal(snapRes.status, 200);
  const snapBody = await snapRes.json();
  assert.equal(snapBody.telemetry.stats.completedRuns, 1);
  assert.equal(snapBody.telemetry.providers.gemini, "ok");

  const controller = new AbortController();
  const streamRes = await fetch(`${baseUrl}/api/dashboard/stream`, {
    headers: { "x-api-key": apiKey, "last-event-id": String(e1.id) },
    signal: controller.signal,
  });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get("content-type") || "", /text\/event-stream/i);

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  const pushLiveTimer = setTimeout(() => {
    store.recordMessage({ lineUserId: "U2", direction: "out", answeredBy: "agent:ARIA", text: "Quote ready" });
  }, 50);
  t.after(() => clearTimeout(pushLiveTimer));

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !collected.includes("Quote ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    collected += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(collected, /event: snapshot/);
  assert.match(collected, /"runId":7/);
  assert.match(collected, /Quote ready/);

  const landlineRes = scrubPii("Bangkok desk 021234567 and mobile 0812345678");
  assert.doesNotMatch(landlineRes, /021234567|4567|0812345678/);
  assert.equal((landlineRes.match(/\[PHONE-REDACTED\]/g) || []).length, 2);
});
