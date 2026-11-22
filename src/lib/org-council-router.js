"use strict";

const express = require("express");
const { equalSecret, extractApiKey } = require("./security");
const { OrgStoreError, createOrgLearningService } = require("./org-learning-store");
const { FLEX_BRAND, buildReportFlexCard } = require("./line-flex-cards");

const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;
const LINE_GROUP_ID_RE = /^[CR][0-9a-f]{32}$/;
const LINE_TARGET_ID_RE = /^[UCR][0-9a-f]{32}$/;

function validateChannelTarget(channel, rawTarget, founderLineId = "") {
  const target = String(rawTarget || "").trim();
  if (channel === "founder") {
    if (target && (!founderLineId || target !== founderLineId)) {
      throw new OrgStoreError(400, "founder reports are pinned to FOUNDER_LINE_ID and cannot be redirected", "FOUNDER_TARGET_LOCKED");
    }
    return founderLineId || "";
  }
  if (channel === "line_user") {
    if (!target) return "";
    if (!LINE_USER_ID_RE.test(target)) {
      throw new OrgStoreError(400, "line_user targetLineId must be a LINE user ID starting with U", "INVALID_LINE_TARGET");
    }
    return target;
  }
  if (channel === "line_group") {
    if (!target) return "";
    if (!LINE_GROUP_ID_RE.test(target)) {
      throw new OrgStoreError(400, "line_group targetLineId must be a LINE group/room ID starting with C or R", "INVALID_LINE_TARGET");
    }
    return target;
  }
  if (target) {
    throw new OrgStoreError(400, `targetLineId is not accepted for channel '${channel}'`, "INVALID_LINE_TARGET");
  }
  return "";
}

function createOrgCouncilRouter({
  service = null,
  db = null,
  apiKey = "",
  pushToLine = null,
  founderLineId = "",
  isAllowedLineTarget = null,
  publicBase = FLEX_BRAND.defaultPublicBase,
  traceHook = null,
  getRuntimeHealth = null,
  reportRateLimitMax = 20,
  now = () => Date.now(),
} = {}) {
  const org = service || createOrgLearningService({ db, traceHook });
  const router = express.Router();
  const reportHits = new Map();

  function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  }

  function requireOrgOperator(req, res, next) {
    res.set("Cache-Control", "no-store");
    if (!apiKey || String(apiKey).trim().length < 8) {
      return res.status(503).json({ error: "Organization operator API key is not configured", code: "ORG_API_NOT_CONFIGURED" });
    }
    const provided = extractApiKey(req);
    if (!equalSecret(provided, apiKey)) {
      return res.status(401).json({ error: "Operator API key required", code: "UNAUTHORIZED" });
    }
    return next();
  }

  function enforceReportRateLimit(req) {
    const key = String(req.ip || "operator");
    const cutoff = now() - 60_000;
    const recent = (reportHits.get(key) || []).filter((ts) => ts > cutoff);
    if (recent.length >= reportRateLimitMax) {
      throw new OrgStoreError(429, "Report dispatch rate limit exceeded", "RATE_LIMITED");
    }
    recent.push(now());
    reportHits.set(key, recent);
  }

  router.get("/roster", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...org.getPublicRosterSummary() });
  });

  router.get("/roster/full", requireOrgOperator, (_req, res) => {
    res.json({ ok: true, ...org.getRosterSummary() });
  });

  router.post("/council/plan", requireOrgOperator, asyncHandler(async (req, res) => {
    const plan = await org.planCentralCouncilTask({
      command: req.body?.command,
      requestedBy: req.body?.requestedBy || "founder",
      targetChannel: req.body?.targetChannel || "founder",
    });
    res.status(201).json({ ok: true, plan });
  }));

  router.get("/learning/individual/:agentId", requireOrgOperator, asyncHandler(async (req, res) => {
    const data = await org.listIndividualLearning(req.params.agentId, {
      limit: req.query.limit,
      query: req.query.q || "",
    });
    res.json({ ok: true, ...data });
  }));

  router.post("/learning/individual/:agentId", requireOrgOperator, asyncHandler(async (req, res) => {
    const record = await org.recordIndividualLearning(req.params.agentId, req.body || {});
    res.status(201).json({ ok: true, record });
  }));

  router.get("/learning/team/:teamId", requireOrgOperator, asyncHandler(async (req, res) => {
    const data = await org.listTeamLearning(req.params.teamId, {
      limit: req.query.limit,
      query: req.query.q || "",
    });
    res.json({ ok: true, ...data });
  }));

  router.post("/learning/team/:teamId", requireOrgOperator, asyncHandler(async (req, res) => {
    const record = await org.recordTeamLearning(req.params.teamId, req.body || {});
    res.status(201).json({ ok: true, record });
  }));

  router.get("/reports", requireOrgOperator, asyncHandler(async (req, res) => {
    const data = await org.listOrgReports({
      channel: String(req.query.channel || "").trim(),
      teamId: String(req.query.teamId || "").trim(),
      limit: req.query.limit,
    });
    res.json({ ok: true, ...data });
  }));

  router.post("/reports", requireOrgOperator, asyncHandler(async (req, res) => {
    enforceReportRateLimit(req);
    const channel = String(req.body?.channel || "founder").trim();
    const dispatchTarget = validateChannelTarget(channel, req.body?.targetLineId, founderLineId);

    if (dispatchTarget && channel !== "founder" && typeof isAllowedLineTarget === "function") {
      const allowed = await isAllowedLineTarget(channel, dispatchTarget);
      if (!allowed) {
        throw new OrgStoreError(403, "LINE target is not registered as an authorized staff user or active bound group", "UNREGISTERED_LINE_TARGET");
      }
    }

    const audience = channel === "founder" ? "operator" : "external";
    const deliver = typeof pushToLine === "function" && dispatchTarget
      ? async (report) => {
          const card = buildReportFlexCard(report, { publicBase, audience });
          await pushToLine(dispatchTarget, card);
          return true;
        }
      : null;

    const report = await org.createOrgReport({
      title: req.body?.title,
      summary: req.body?.summary,
      teamId: req.body?.teamId || "central-command",
      authorAgentId: req.body?.authorAgentId || "cmd-synthesizer",
      channel,
      metrics: req.body?.metrics || {},
      deliver,
    });
    res.status(201).json({ ok: true, report });
  }));

  router.get("/governance/audit", requireOrgOperator, asyncHandler(async (_req, res) => {
    const runtimeHealth = typeof getRuntimeHealth === "function" ? await getRuntimeHealth() : null;
    const audit = await org.runGovernanceAudit({ runtimeHealth, persist: false });
    res.json({ ok: true, audit });
  }));

  router.post("/governance/audit", requireOrgOperator, asyncHandler(async (_req, res) => {
    const runtimeHealth = typeof getRuntimeHealth === "function" ? await getRuntimeHealth() : null;
    const audit = await org.runGovernanceAudit({ runtimeHealth, persist: true });
    res.status(201).json({ ok: true, audit });
  }));

  router.use((err, _req, res, _next) => {
    if (err instanceof OrgStoreError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if ((Number.isInteger(err?.httpStatus) && err.httpStatus >= 500) || /database_/i.test(String(err?.code || err?.classification || ""))) {
      return res.status(503).json({ error: "Upstream organization database unavailable", code: "ORG_UPSTREAM_UNAVAILABLE" });
    }
    return res.status(500).json({ error: "Organization service error", code: "ORG_INTERNAL_ERROR" });
  });

  return router;
}

module.exports = {
  LINE_USER_ID_RE,
  LINE_GROUP_ID_RE,
  LINE_TARGET_ID_RE,
  validateChannelTarget,
  createOrgCouncilRouter,
};
