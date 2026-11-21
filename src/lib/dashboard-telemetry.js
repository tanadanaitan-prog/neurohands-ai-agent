"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { equalSecret, extractApiKey } = require("./security");

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_RACE_SLA_MS = 2_500;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_LISTENERS = 50;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const THAI_ID_RE = /\b(?:\d{13}|\d[- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d)\b/g;
const LINE_ID_RE = /\bU[0-9a-fA-F]{32}\b/g;
const THAI_PHONE_RE = /(?:\+?66[-\s]*(?:\(0\)|0)?|0[2-9])[0-9\-\s]{6,13}[0-9]/g;

function hashActor(actorId) {
  const value = typeof actorId === "string" ? actorId.trim() : "";
  if (!value) return "anon";
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function scrubPii(text, maxLength = 140) {
  const raw = typeof text === "string" ? text : String(text || "");
  if (!raw) return "";
  // Emails and 13-digit Thai IDs must run before phones so email local-parts and ID prefixes (e.g. 08/02) are masked whole.
  const masked = raw
    .replace(EMAIL_RE, "[EMAIL-REDACTED]")
    .replace(THAI_ID_RE, "[ID-REDACTED]")
    .replace(LINE_ID_RE, "[LINE-ID-REDACTED]")
    .replace(THAI_PHONE_RE, "[PHONE-REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return masked.slice(0, Math.max(1, maxLength));
}

function computePercentile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

function createDashboardTelemetry({
  maxEvents = DEFAULT_MAX_EVENTS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  raceSlaMs = DEFAULT_RACE_SLA_MS,
  now = () => Date.now(),
} = {}) {
  const events = [];
  const listeners = new Set();
  let seq = 0;

  function prune(currentMs) {
    const cutoff = currentMs - maxAgeMs;
    while (events.length > 0 && (events[0].createdMs < cutoff || events.length > maxEvents)) {
      events.shift();
    }
  }

  function appendEvent(type, payload) {
    const currentMs = now();
    const entry = {
      id: ++seq,
      type,
      createdAt: new Date(currentMs).toISOString(),
      createdMs: currentMs,
      ...payload,
    };
    events.push(entry);
    prune(currentMs);
    for (const listener of listeners) {
      try { listener(entry); }
      catch { listeners.delete(listener); }
    }
    return entry;
  }

  function sanitizeEvent(entry) {
    const { createdMs: _ignored, ...wire } = entry;
    return wire;
  }

  function recordMessage(fields = {}) {
    return appendEvent("message", {
      clientAccountId: fields.clientAccountId ?? fields.client_account_id ?? null,
      runId: fields.runId ?? fields.run_id ?? null,
      direction: fields.direction === "out" ? "out" : "in",
      answeredBy: fields.answeredBy ?? fields.answered_by ?? null,
      questionType: fields.questionType ?? fields.question_type ?? null,
      status: fields.status || "received",
      actorHash: hashActor(fields.lineUserId ?? fields.line_user_id),
      preview: scrubPii(fields.text ?? fields.text_content),
    });
  }

  function recordRun(fields = {}) {
    const status = fields.status || "completed";
    const latencyMs = Number.isFinite(fields.latencyMs) ? Math.max(0, Math.round(fields.latencyMs)) : null;
    const racedToChecking = fields.racedToChecking === true;
    const slaMet = typeof fields.slaMet === "boolean"
      ? fields.slaMet
      : (latencyMs !== null ? latencyMs <= raceSlaMs && !racedToChecking : null);

    return appendEvent("run", {
      runId: fields.runId ?? null,
      clientAccountId: fields.clientAccountId ?? null,
      agentCode: fields.agentCode ?? null,
      department: fields.department ?? null,
      status,
      iterations: Number.isFinite(fields.iterations) ? fields.iterations : 0,
      latencyMs,
      slaMet,
      racedToChecking,
      error: fields.error ? scrubPii(fields.error, 120) : null,
    });
  }

  function recordRaceOutcome(fields = {}) {
    const latencyMs = Number.isFinite(fields.latencyMs) ? Math.max(0, Math.round(fields.latencyMs)) : null;
    const racedToChecking = fields.racedToChecking === true;
    const slaMet = latencyMs !== null ? latencyMs <= raceSlaMs && !racedToChecking : !racedToChecking;
    if (fields.runId != null) {
      const matchingRun = events.findLast((ev) => ev.type === "run" && ev.runId === fields.runId);
      if (matchingRun) {
        matchingRun.racedToChecking = racedToChecking;
        matchingRun.slaMet = slaMet;
        if (latencyMs !== null) matchingRun.latencyMs = latencyMs;
      }
    }
    return appendEvent("race", {
      runId: fields.runId ?? null,
      lane: fields.lane || "agent",
      latencyMs,
      racedToChecking,
      slaMet,
      ok: fields.ok !== false,
    });
  }

  function eventsSince(lastEventId) {
    prune(now());
    const parsed = Number.parseInt(String(lastEventId ?? ""), 10);
    const minId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
    return events.filter((entry) => entry.id > minId).map(sanitizeEvent);
  }

  function snapshot(extra = {}) {
    prune(now());
    const recentEvents = events.slice(-40).map(sanitizeEvent);
    const runEvents = events.filter((entry) => entry.type === "run");
    const completedRuns = runEvents.filter((entry) => entry.status === "completed").length;
    const erroredRuns = runEvents.filter((entry) => entry.status === "error").length;
    const latencies = events
      .filter((entry) => (entry.type === "run" || entry.type === "race") && Number.isFinite(entry.latencyMs))
      .map((entry) => entry.latencyMs);
    const racedRunIds = new Set(runEvents.filter((entry) => entry.racedToChecking).map((entry) => entry.runId).filter((v) => v != null));
    const standaloneChecking = events.filter(
      (entry) => entry.type === "race" && entry.racedToChecking && (entry.runId == null || !racedRunIds.has(entry.runId)),
    ).length;
    const checkingRaces = runEvents.filter((entry) => entry.racedToChecking).length + standaloneChecking;
    const slaEvaluable = runEvents.filter((entry) => typeof entry.slaMet === "boolean");
    const slaMetRuns = slaEvaluable.filter((entry) => entry.slaMet === true).length;
    const slaCompliancePct = slaEvaluable.length > 0
      ? Math.round((slaMetRuns / slaEvaluable.length) * 1000) / 10
      : null;

    return {
      generatedAt: new Date(now()).toISOString(),
      latestEventId: seq,
      windowMs: maxAgeMs,
      raceSlaMs,
      stats: {
        totalRuns: runEvents.length,
        completedRuns,
        erroredRuns,
        checkingRaces,
        slaCompliancePct,
        p95LatencyMs: computePercentile(latencies, 95),
      },
      providers: extra.providers || {},
      recentEvents,
    };
  }

  function subscribe(listener, maxSubscribers = DEFAULT_MAX_LISTENERS) {
    if (listeners.size >= maxSubscribers) return null;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    recordMessage,
    recordRun,
    recordRaceOutcome,
    eventsSince,
    snapshot,
    subscribe,
  };
}

function writeSseFrame(res, { event, id, data }) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    const lines = [];
    if (id !== undefined && id !== null) lines.push(`id: ${id}`);
    if (event) lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    res.write(`${lines.join("\n")}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function createDashboardTelemetryRouter({
  db,
  apiKey = "",
  telemetry,
  getProviderStatus = () => ({}),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxListeners = DEFAULT_MAX_LISTENERS,
} = {}) {
  if (!telemetry) throw new Error("telemetry store is required");
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!apiKey) return res.status(503).json({ error: "Telemetry API key is not configured" });
    const supplied = extractApiKey(req);
    if (!equalSecret(apiKey, supplied)) return res.status(401).json({ error: "Unauthorized" });
    next();
  });

  router.get("/snapshot", async (_req, res) => {
    const live = telemetry.snapshot({ providers: getProviderStatus() });
    let dbTelemetry = null;
    let dbRuns = null;
    let warning = null;
    if (typeof db === "function") {
      try {
        const [msgRows, runRows] = await Promise.all([
          db("nh_messages_telemetry?select=id,client_account_id,run_id,direction,answered_by,question_type,status,created_at,line_user_hash,masked_text&order=created_at.desc&limit=25"),
          db("agent_runs?select=id,client_account_id,agent_code,department,status,iterations,created_at,completed_at&order=created_at.desc&limit=25"),
        ]);
        dbTelemetry = Array.isArray(msgRows) ? msgRows : [];
        dbRuns = Array.isArray(runRows) ? runRows : [];
      } catch {
        warning = "Telemetry SQL view unavailable; serving in-process buffer only.";
      }
    }
    res.json({ telemetry: live, dbTelemetry, dbRuns, ...(warning ? { warning } : {}) });
  });

  router.get("/stream", (req, res) => {
    let cleaned = false;
    let heartbeat = null;
    let unsubscribe = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    };

    unsubscribe = telemetry.subscribe((entry) => {
      const { createdMs: _ignored, ...wire } = entry;
      if (!writeSseFrame(res, { event: "telemetry", id: wire.id, data: wire })) cleanup();
    }, maxListeners);
    if (!unsubscribe) return res.status(503).json({ error: "Telemetry stream capacity reached" });

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    res.on("error", cleanup);

    if (req.destroyed || res.destroyed || res.writableEnded) {
      cleanup();
      return;
    }

    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const snap = telemetry.snapshot({ providers: getProviderStatus() });
    if (!writeSseFrame(res, { event: "snapshot", id: snap.latestEventId, data: snap })) {
      cleanup();
      return;
    }

    const lastEventId = req.headers["last-event-id"];
    if (lastEventId) {
      for (const missed of telemetry.eventsSince(lastEventId)) {
        if (!writeSseFrame(res, { event: "telemetry", id: missed.id, data: missed })) {
          cleanup();
          return;
        }
      }
    }

    heartbeat = setInterval(() => {
      if (cleaned || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try { res.write(": heartbeat\n\n"); }
      catch { cleanup(); }
    }, Math.max(200, heartbeatMs));
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  });

  return router;
}

module.exports = {
  hashActor,
  scrubPii,
  createDashboardTelemetry,
  createDashboardTelemetryRouter,
};
