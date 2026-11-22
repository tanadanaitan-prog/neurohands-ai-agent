"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { signHs256Jwt, verifyHs256Jwt } = require("./liff-router");
const { equalSecret, extractApiKey } = require("./security");
const { createHandoverStore, CHANNEL_TYPES } = require("./conversation-handover");
const { DEFAULT_TRIAL_LIMITS, createTrialQuotaService } = require("./trial-quota");
const { GROUP_MODES, normalizeGroupPolicy } = require("./line-group-router");
const {
  BLOCK_CATALOG,
  DEFAULT_ARIA_WORKFLOW,
  ROLE_WORKFLOW_PRESETS,
  resolveRolePreset,
  validateWorkflowSpec,
  executeWorkflowTurn,
} = require("./workflow-runtime");

const LESSONS_FILE = path.join(__dirname, "../../docs/DEV_LESSONS_LEDGER.json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class TrialHttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function resolveSigningSecret({ supabaseJwtSecret = "", fallbackSecret = "" } = {}) {
  if (typeof supabaseJwtSecret === "string" && supabaseJwtSecret.length >= 16) {
    return supabaseJwtSecret;
  }
  if (typeof fallbackSecret === "string" && fallbackSecret.length >= 16) {
    return crypto.createHmac("sha256", fallbackSecret).update("neurohands-trial-session-v1").digest("hex");
  }
  return "";
}

function createLangSmithTraceHook({ apiKey = "", project = "neurohands-trial", endpoint = "https://api.smith.langchain.com/runs", fetchImpl = globalThis.fetch } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return null;
  return async (receipt) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const isOrgEvent = Boolean(receipt?.kind);
    const runName = isOrgEvent ? `neurohands.org_${String(receipt.kind).replace(/[^a-z0-9_]/gi, "")}` : "neurohands.workflow_turn";
    const inputs = isOrgEvent
      ? {
          kind: String(receipt.kind),
          team_id: String(receipt.teamId || "central-command"),
          agent_id: String(receipt.agentId || receipt.curatedBy || "cmd-director"),
          channel: String(receipt.channel || "founder"),
        }
      : {
          channel_type: String(receipt?.channelType || "web"),
          agent_code: String(receipt?.agentCode || "ARIA"),
          intent: String(receipt?.intent || "general"),
        };
    const outputs = isOrgEvent
      ? {
          status: String(receipt.outcome || receipt.deliveryStatus || "recorded"),
          storage: String(receipt.storage || "supabase"),
          ref: String(receipt.caseKey || receipt.patternKey || receipt.reportCode || receipt.taskId || "-"),
        }
      : {
          status: String(receipt?.status || "completed"),
          elapsed_ms: Number(receipt?.elapsedMs || 0),
        };
    try {
      await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          name: runName,
          run_type: "chain",
          project_name: project || "neurohands-trial",
          inputs,
          outputs,
          start_time: new Date(Date.now() - Number(receipt?.elapsedMs || 0)).toISOString(),
          end_time: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function loadDevLessons(query = "", lessonsPath = LESSONS_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
    const items = Array.isArray(raw?.lessons) ? raw.lessons : [];
    const q = String(query || "").trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.id} ${item.error_signature} ${item.root_cause} ${item.approved_fix} ${item.regression_test}`.toLowerCase().includes(q)
    );
  } catch {
    return [];
  }
}

function createTrialRouter({
  db,
  apiKey = "",
  supabaseJwtSecret = "",
  fallbackSecret = "",
  founderLineId = "",
  publicBase = "https://neurohands-ai-agent-production.up.railway.app",
  proposeNote = null,
  askModel = null,
  notifyHuman = null,
  traceHook = null,
  defaultLeadTimeDays = 7,
  now = () => Date.now(),
  lessonsPath = LESSONS_FILE,
  signupRateLimitMax = 10,
} = {}) {
  const router = express.Router();
  const signingSecret = resolveSigningSecret({ supabaseJwtSecret, fallbackSecret });
  const handoverStore = createHandoverStore({ db });
  const trialService = createTrialQuotaService({ db, now });
  const signupHits = new Map();

  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function checkSignupRateLimit(ip) {
    const key = String(ip || "unknown");
    const ts = now();
    if (signupHits.size > 1000) {
      for (const [k, stamps] of signupHits.entries()) {
        const fresh = stamps.filter((t) => ts - t < 15 * 60 * 1000);
        if (fresh.length) signupHits.set(k, fresh);
        else signupHits.delete(k);
      }
      if (signupHits.size > 1000) signupHits.clear();
    }
    const recent = (signupHits.get(key) || []).filter((t) => ts - t < 15 * 60 * 1000);
    if (recent.length >= signupRateLimitMax) {
      throw new TrialHttpError(429, "Too many trial signup requests. Please wait a few minutes.", "RATE_LIMITED");
    }
    recent.push(ts);
    signupHits.set(key, recent);
  }

  async function requireTrialTenant(req) {
    if (!signingSecret) throw new TrialHttpError(503, "Trial authentication is not configured");
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) throw new TrialHttpError(401, "Missing Bearer token");
    let payload;
    try {
      payload = verifyHs256Jwt(token, signingSecret);
    } catch {
      throw new TrialHttpError(401, "Invalid or expired trial session");
    }
    const appMeta = payload?.app_metadata;
    if (!appMeta || !["trial_web", "line"].includes(appMeta.provider)) {
      throw new TrialHttpError(401, "Invalid tenant provider claim");
    }
    const clientAccountId = Number(appMeta.client_account_id);
    if (!Number.isSafeInteger(clientAccountId) || clientAccountId <= 0) {
      throw new TrialHttpError(401, "Invalid tenant scope");
    }
    const rows = await db(`client_accounts?id=eq.${encodeURIComponent(clientAccountId)}&active=eq.true&select=id,client_code,company,active&limit=1`);
    const account = rows?.[0];
    if (!account || account.active !== true) {
      throw new TrialHttpError(403, "Trial account is inactive or unavailable");
    }
    return {
      clientAccountId: account.id,
      clientCode: account.client_code,
      company: account.company,
      email: typeof appMeta.email === "string" ? appMeta.email : null,
      operatorLineUserId: founderLineId || null,
    };
  }

  async function loadTenantCatalog(clientAccountId) {
    const rows = await db(`glass_types?active=eq.true&client_account_id=eq.${encodeURIComponent(clientAccountId)}&order=product_code&limit=30`);
    return Array.isArray(rows) ? rows : [];
  }

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/catalog", (_req, res) => {
    res.json({
      ok: true,
      blocks: BLOCK_CATALOG,
      defaultWorkflow: DEFAULT_ARIA_WORKFLOW,
      rolePresets: ROLE_WORKFLOW_PRESETS,
      defaultTrialLimits: DEFAULT_TRIAL_LIMITS,
      groupModes: GROUP_MODES,
      lineNote: "LINE Official Account group chats require Group Access enabled in LINE Official Account Manager, and LINE allows only one Official Account per group.",
    });
  });

  router.get("/lessons", route(async (req, res) => {
    const hasApiKey = Boolean(apiKey && equalSecret(apiKey, extractApiKey(req)));
    if (!hasApiKey) await requireTrialTenant(req);
    const lessons = loadDevLessons(req.query.q, lessonsPath);
    res.json({ ok: true, count: lessons.length, lessons });
  }));

  router.post("/signup", route(async (req, res) => {
    if (!signingSecret) throw new TrialHttpError(503, "Trial authentication is not configured");
    checkSignupRateLimit(req.ip);
    const businessName = typeof req.body?.businessName === "string" ? req.body.businessName.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = typeof req.body?.role === "string" && req.body.role.trim()
      ? req.body.role.trim().slice(0, 80)
      : DEFAULT_ARIA_WORKFLOW.role;
    if (businessName.length < 2 || businessName.length > 100) {
      throw new TrialHttpError(400, "businessName must be between 2 and 100 characters");
    }
    if (!EMAIL_RE.test(email) || email.length > 160) {
      throw new TrialHttpError(400, "A valid email address is required");
    }

    const existingEmail = await db(`nh_tenant_trials?owner_email=eq.${encodeURIComponent(email)}&select=client_account_id&limit=1`);
    if (existingEmail?.[0]) {
      throw new TrialHttpError(409, "A trial workspace has already been provisioned for this email address", "TRIAL_EMAIL_EXISTS");
    }

    const clientCode = `TRL-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const createdAcc = await db("client_accounts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { client_code: clientCode, company: businessName, active: true },
    });
    const account = createdAcc?.[0];
    if (!account?.id) throw new TrialHttpError(503, "Could not provision trial account");

    const trial = await trialService.provisionTrial(account.id, { ...DEFAULT_TRIAL_LIMITS, ownerEmail: email });
    const preset = resolveRolePreset(role);
    const initialSpec = validateWorkflowSpec({ ...preset, role });
    const createdWf = await db("nh_agent_workflows", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        client_account_id: account.id,
        agent_code: initialSpec.agentCode,
        name: initialSpec.name,
        role: initialSpec.role,
        status: "draft",
        version: 1,
        workflow_spec: initialSpec,
        created_by: email,
      },
    });

    const activationCode = `NH-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
    const codeHash = crypto.createHash("sha256").update(activationCode).digest("hex");
    await db("activation_codes", {
      method: "POST",
      body: {
        code_hash: codeHash,
        code_hint: `NH-…${activationCode.slice(-6)}`,
        client_account_id: account.id,
        department: "sales",
        status: "active",
        max_uses: 5,
        used_count: 0,
        expires_at: trial.trialExpiresAt,
        created_by: email,
      },
    });

    const exp = Math.floor(Date.parse(trial.trialExpiresAt) / 1000);
    const token = signHs256Jwt({
      aud: "authenticated",
      role: "authenticated",
      sub: `trial:${account.id}`,
      app_metadata: {
        provider: "trial_web",
        client_account_id: account.id,
        client_code: clientCode,
        role: "owner",
        email,
      },
      exp,
    }, signingSecret);

    res.status(201).json({
      ok: true,
      token,
      tenant: { clientAccountId: account.id, clientCode, company: businessName, email },
      trial,
      workflow: createdWf?.[0] || { agent_code: initialSpec.agentCode, status: "draft", workflow_spec: initialSpec },
      activationCode,
      lineConnect: {
        oneToOne: `activate ${activationCode}`,
        groupChat: `bind ${activationCode}`,
        webhookUrl: `${String(publicBase).replace(/\/+$/, "")}/webhook`,
      },
    });
  }));

  router.get("/me", route(async (req, res) => {
    const tenant = await requireTrialTenant(req);
    const [trial, workflows, groups, threads] = await Promise.all([
      trialService.getAllowance(tenant.clientAccountId),
      db(`nh_agent_workflows?client_account_id=eq.${encodeURIComponent(tenant.clientAccountId)}&select=*&order=updated_at.desc`),
      db(`nh_line_group_bindings?client_account_id=eq.${encodeURIComponent(tenant.clientAccountId)}&select=*&order=updated_at.desc`),
      handoverStore.listThreads(tenant.clientAccountId, 30),
    ]);
    res.json({ ok: true, tenant, trial, workflows: workflows || [], groups: groups || [], threads: threads || [] });
  }));

  router.put("/workflows/:agentCode", route(async (req, res) => {
    const tenant = await requireTrialTenant(req);
    let spec;
    try {
      spec = validateWorkflowSpec({ ...(req.body || {}), agentCode: req.params.agentCode });
    } catch (err) {
      throw new TrialHttpError(400, err.message);
    }
    const saved = await db("nh_agent_workflows?on_conflict=client_account_id,agent_code", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: {
        client_account_id: tenant.clientAccountId,
        agent_code: spec.agentCode,
        name: spec.name,
        role: spec.role,
        workflow_spec: spec,
        updated_at: new Date(now()).toISOString(),
      },
    });
    res.json({ ok: true, workflow: saved?.[0] || { agent_code: spec.agentCode, workflow_spec: spec } });
  }));

  router.post("/workflows/:agentCode/test", route(async (req, res) => {
    const tenant = await requireTrialTenant(req);
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const threadId = typeof req.body?.threadId === "string" && req.body.threadId.trim()
      ? req.body.threadId.trim().slice(0, 120)
      : `web-${tenant.clientCode}`;
    if (!message || message.length > 1000) {
      throw new TrialHttpError(400, "message must be between 1 and 1,000 characters");
    }

    let spec;
    if (req.body?.spec) {
      try {
        spec = validateWorkflowSpec({ ...req.body.spec, agentCode: req.params.agentCode });
      } catch (err) {
        throw new TrialHttpError(400, err.message);
      }
    } else {
      const code = String(req.params.agentCode || "ARIA").trim().toUpperCase();
      const rows = await db(`nh_agent_workflows?client_account_id=eq.${encodeURIComponent(tenant.clientAccountId)}&agent_code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
      spec = validateWorkflowSpec(rows?.[0]?.workflow_spec || DEFAULT_ARIA_WORKFLOW);
    }

    const catalogRows = await loadTenantCatalog(tenant.clientAccountId);
    const result = await executeWorkflowTurn({
      spec,
      tenant,
      channelType: "web",
      threadId,
      message,
      catalogRows,
      defaultLeadTimeDays,
      handoverStore,
      trialService,
      proposeNote,
      askModel,
      notifyHuman,
      traceHook,
    });
    const trial = await trialService.getAllowance(tenant.clientAccountId);
    res.json({ ok: true, result, trial });
  }));

  router.post("/workflows/:agentCode/publish", route(async (req, res) => {
    const tenant = await requireTrialTenant(req);
    const code = String(req.params.agentCode || "ARIA").trim().toUpperCase();
    const existing = (await db(`nh_agent_workflows?client_account_id=eq.${encodeURIComponent(tenant.clientAccountId)}&agent_code=eq.${encodeURIComponent(code)}&select=*&limit=1`))?.[0];
    let spec;
    try {
      spec = validateWorkflowSpec({ ...(req.body?.spec || existing?.workflow_spec || DEFAULT_ARIA_WORKFLOW), agentCode: code });
    } catch (err) {
      throw new TrialHttpError(400, err.message);
    }
    const publishedAt = new Date(now()).toISOString();
    const saved = await db("nh_agent_workflows?on_conflict=client_account_id,agent_code", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: {
        client_account_id: tenant.clientAccountId,
        agent_code: spec.agentCode,
        name: spec.name,
        role: spec.role,
        status: "published",
        version: (Number(existing?.version) || 0) + 1,
        workflow_spec: spec,
        published_spec: spec,
        published_at: publishedAt,
        updated_at: publishedAt,
      },
    });
    const wf = saved?.[0];
    await db(`nh_line_group_bindings?client_account_id=eq.${encodeURIComponent(tenant.clientAccountId)}&active=eq.true`, {
      method: "PATCH",
      body: {
        response_mode: spec.groupPolicy.mode,
        trigger_keywords: spec.groupPolicy.keywords,
        ...(wf?.id ? { workflow_id: wf.id } : {}),
        updated_at: publishedAt,
      },
    });
    res.json({
      ok: true,
      workflow: wf || { agent_code: spec.agentCode, status: "published", published_spec: spec, published_at: publishedAt },
      lineDeploy: {
        oneToOne: "Send 'activate <YOUR-NH-CODE>' in a 1:1 chat with the Neurohands LINE Official Account.",
        groupChat: "Enable group chats in LINE Official Account Manager, invite the Official Account (one OA per group), and send 'bind <YOUR-NH-CODE>'.",
        groupPolicy: spec.groupPolicy,
      },
    });
  }));

  router.patch("/groups/:groupId", route(async (req, res) => {
    const tenant = await requireTrialTenant(req);
    const groupId = String(req.params.groupId || "").trim();
    if (!groupId || groupId.length > 128) throw new TrialHttpError(400, "Invalid groupId");
    const policy = normalizeGroupPolicy({ mode: req.body?.responseMode ?? req.body?.mode, keywords: req.body?.triggerKeywords ?? req.body?.keywords });
    const body = {
      response_mode: policy.mode,
      trigger_keywords: policy.keywords,
      ...(typeof req.body?.active === "boolean" ? { active: req.body.active } : {}),
      updated_at: new Date(now()).toISOString(),
    };
    const updated = await db(`nh_line_group_bindings?client_account_id=eq.${encodeURIComponent(tenant.clientAccountId)}&line_group_id=eq.${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body,
    });
    if (!updated?.[0]) throw new TrialHttpError(404, "LINE group binding not found for this tenant");
    res.json({ ok: true, group: updated[0] });
  }));

  router.post("/threads/handover", route(async (req, res) => {
    const tenant = await requireTrialTenant(req);
    const channelType = String(req.body?.channelType || "web").trim();
    const threadId = String(req.body?.threadId || "").trim();
    const action = String(req.body?.action || "").trim();
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : null;
    if (!CHANNEL_TYPES.includes(channelType)) throw new TrialHttpError(400, "Invalid channelType");
    if (!threadId || threadId.length > 160) throw new TrialHttpError(400, "threadId is required");
    let stateRow;
    try {
      stateRow = await handoverStore.transition(tenant.clientAccountId, channelType, threadId, action, {
        actor: tenant.email || `tenant:${tenant.clientCode}`,
        reason,
      });
    } catch (err) {
      throw new TrialHttpError(400, err.message);
    }
    res.json({ ok: true, thread: stateRow });
  }));

  router.use((error, _req, res, _next) => {
    if (error instanceof TrialHttpError) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    console.error("Trial router error:", error?.name || "Error");
    return res.status(503).json({ error: "Trial service temporarily unavailable" });
  });

  return router;
}

module.exports = {
  createTrialRouter,
  createLangSmithTraceHook,
  resolveSigningSecret,
  loadDevLessons,
  TrialHttpError,
};
