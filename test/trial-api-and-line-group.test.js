"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");
const { createTrialRouter, createLangSmithTraceHook } = require("../src/lib/trial-router");

const PRIVATE = "fixture-secret-never-print-this-1234";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function createMockTrialDb() {
  const tables = {
    client_accounts: [
      { id: 1, client_code: "KNC", company: "KNC Glass", active: true },
    ],
    nh_tenant_trials: [
      {
        client_account_id: 1,
        plan_code: "trial_free",
        status: "active",
        trial_starts_at: new Date(Date.now() - 3600000).toISOString(),
        trial_expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
        max_messages: 3,
        used_messages: 0,
        max_actions: 1,
        used_actions: 0,
        spending_cap_usd: 0,
        spent_usd: 0,
      },
    ],
    nh_agent_workflows: [],
    nh_line_group_bindings: [],
    nh_conversation_states: [],
    activation_codes: [],
    glass_types: [
      { product_code: "TMP-CLR-10", glass_name: "Tempered Clear 10mm", thickness_mm: 10, price_per_sqft: 120, active: true, client_account_id: 1 },
    ],
    settings: [{ key: "default_lead_time_days", value: "7" }],
    messages: [],
    escalations: [],
    jarvis_notes: [],
    staff_activations: [{ id: 1, line_user_id: "Ufounder1", role: "admin", active: true }],
    client_agent_bindings: [],
    clients: [],
    agent_registry: [],
  };

  function filterRows(rows, searchParams) {
    return rows.filter((row) => {
      for (const [k, v] of searchParams.entries()) {
        if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
        if (v.startsWith("eq.") && String(row[k]) !== v.slice(3)) return false;
      }
      return true;
    });
  }

  async function db(pathStr, options = {}) {
    const [resource, qs = ""] = pathStr.split("?");
    const params = new URLSearchParams(qs);
    const method = (options.method || "GET").toUpperCase();

    if (resource === "rpc/nh_consume_trial_allowance") {
      const { p_client_account_id, p_messages = 0, p_actions = 0, p_cost_usd = 0, p_now } = options.body;
      const row = tables.nh_tenant_trials.find((r) => Number(r.client_account_id) === Number(p_client_account_id));
      if (!row) return [{ allowed: false, reason: "trial_not_found", status: "paused", remaining_messages: 0, remaining_actions: 0, remaining_budget_usd: 0 }];
      if (Date.parse(p_now) >= Date.parse(row.trial_expires_at)) {
        row.status = "expired";
        return [{ allowed: false, reason: "trial_expired", status: "expired", remaining_messages: row.max_messages - row.used_messages, remaining_actions: row.max_actions - row.used_actions, remaining_budget_usd: 0 }];
      }
      if (row.used_messages + p_messages > row.max_messages) {
        row.status = "quota_exceeded";
        return [{ allowed: false, reason: "message_limit_reached", status: "quota_exceeded", remaining_messages: row.max_messages - row.used_messages, remaining_actions: row.max_actions - row.used_actions, remaining_budget_usd: 0 }];
      }
      if (row.used_actions + p_actions > row.max_actions) {
        row.status = "quota_exceeded";
        return [{ allowed: false, reason: "action_limit_reached", status: "quota_exceeded", remaining_messages: row.max_messages - row.used_messages, remaining_actions: row.max_actions - row.used_actions, remaining_budget_usd: 0 }];
      }
      row.used_messages += p_messages;
      row.used_actions += p_actions;
      row.spent_usd += p_cost_usd;
      return [{
        allowed: true,
        reason: "ok",
        status: "active",
        remaining_messages: row.max_messages - row.used_messages,
        remaining_actions: row.max_actions - row.used_actions,
        remaining_budget_usd: row.spending_cap_usd - row.spent_usd,
        trial_expires_at: row.trial_expires_at,
      }];
    }

    if (resource === "rpc/nh_claim_activation_code") {
      const code = tables.activation_codes.find((c) => c.code_hash === options.body.p_code_hash && c.status === "active" && c.used_count < c.max_uses);
      if (!code) return [];
      code.used_count += 1;
      return [{ id: code.id, client_account_id: code.client_account_id, department: code.department }];
    }

    const list = tables[resource];
    if (!list) return [];

    if (method === "GET") {
      const matched = filterRows(list, params);
      const limit = Number(params.get("limit") || 0);
      return limit ? matched.slice(0, limit) : matched;
    }
    if (method === "POST") {
      const body = { ...options.body };
      const conflict = params.get("on_conflict");
      if (conflict) {
        const keys = conflict.split(",");
        const existing = list.find((r) => keys.every((k) => String(r[k]) === String(body[k])));
        if (existing) {
          if (String(options.headers?.Prefer || "").includes("ignore-duplicates")) return [existing];
          Object.assign(existing, body);
          return [existing];
        }
      }
      if (!body.id) {
        body.id = resource === "nh_agent_workflows" ? crypto.randomUUID() : (list.length + 1);
      }
      list.push(body);
      return [body];
    }
    if (method === "PATCH") {
      const matched = filterRows(list, params);
      for (const r of matched) Object.assign(r, options.body);
      return matched;
    }
    return [];
  }

  return { db, tables };
}

test("Full customer-trial HTTP journey: signup -> build -> website test -> publish -> takeover -> tenant isolation -> lessons", async (t) => {
  const { db, tables } = createMockTrialDb();
  const langsmithCalls = [];
  const traceHook = createLangSmithTraceHook({
    apiKey: "ls-test-key",
    project: "neurohands-test",
    fetchImpl: async (url, opts) => {
      langsmithCalls.push({ url, body: JSON.parse(opts.body) });
      return json({ ok: true }, 200);
    },
  });

  const app = express();
  app.use(express.json());
  app.use("/api/trial", createTrialRouter({
    db,
    supabaseJwtSecret: PRIVATE,
    founderLineId: "Ufounder1",
    proposeNote: async (content, cat, proposer, toolName, toolArgs, accountId) => {
      const id = tables.jarvis_notes.length + 1;
      tables.jarvis_notes.push({ id, content, toolName, toolArgs, client_account_id: accountId });
      return id;
    },
    traceHook,
  }));

  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/trial`;

  const catRes = await fetch(`${base}/catalog`);
  assert.equal(catRes.status, 200);
  const cat = await catRes.json();
  assert.equal(cat.defaultTrialLimits.durationDays, 14);
  assert.equal(cat.defaultTrialLimits.maxMessages, 200);

  const s1Res = await fetch(`${base}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessName: "Alpha Glass Co", email: "owner@alpha.example" }),
  });
  assert.equal(s1Res.status, 201);
  const s1 = await s1Res.json();
  assert.ok(s1.token);
  assert.match(s1.activationCode, /^NH-/);
  assert.equal(s1.trial.remainingMessages, 200);

  tables.glass_types.push({
    product_code: "ALP-TMP-10",
    glass_name: "Alpha Tempered 10mm",
    thickness_mm: 10,
    price_per_sqft: 150,
    active: true,
    client_account_id: s1.tenant.clientAccountId,
  });

  const saveRes = await fetch(`${base}/workflows/ARIA`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.token}` },
    body: JSON.stringify({
      name: "Alpha Aria",
      role: "Aria — Customer Service & Quotes",
      instructions: "Quote from Alpha price list only.",
      blocks: ["instructions", "knowledge", "decisions", "quote", "approval_gate", "human_handoff", "reply"],
      allowedTools: ["get_product_info", "create_task", "request_human"],
      approvalRequiredTools: ["create_task"],
      groupPolicy: { mode: "mention_only", keywords: ["quote"] },
    }),
  });
  assert.equal(saveRes.status, 200);

  const testQuoteRes = await fetch(`${base}/workflows/ARIA/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.token}` },
    body: JSON.stringify({ message: "Quote 10mm tempered glass 2x3m", threadId: "web-alpha-1" }),
  });
  assert.equal(testQuoteRes.status, 200);
  const testQuote = await testQuoteRes.json();
  assert.match(testQuote.result.text, /Alpha Tempered 10mm/);
  assert.equal(testQuote.trial.remainingMessages, 199);
  assert.equal(langsmithCalls.length, 1);
  assert.equal(JSON.stringify(langsmithCalls[0].body).includes("owner@alpha.example"), false);

  const pubRes = await fetch(`${base}/workflows/ARIA/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.token}` },
    body: JSON.stringify({}),
  });
  assert.equal(pubRes.status, 200);
  const pub = await pubRes.json();
  assert.equal(pub.workflow.status, "published");
  assert.match(pub.lineDeploy.groupChat, /one OA per group/);

  const pauseRes = await fetch(`${base}/threads/handover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.token}` },
    body: JSON.stringify({ channelType: "web", threadId: "web-alpha-1", action: "takeover", reason: "Owner replying" }),
  });
  assert.equal(pauseRes.status, 200);
  assert.equal((await pauseRes.json()).thread.state, "human_takeover");

  const silencedRes = await fetch(`${base}/workflows/ARIA/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.token}` },
    body: JSON.stringify({ message: "Hello again", threadId: "web-alpha-1" }),
  });
  const silenced = await silencedRes.json();
  assert.equal(silenced.result.suppressed, true);
  assert.equal(silenced.trial.remainingMessages, 199);

  const resumeRes = await fetch(`${base}/threads/handover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s1.token}` },
    body: JSON.stringify({ channelType: "web", threadId: "web-alpha-1", action: "resume" }),
  });
  assert.equal(resumeRes.status, 200);

  const s2Res = await fetch(`${base}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessName: "Beta Glass Co", email: "owner@beta.example" }),
  });
  const s2 = await s2Res.json();
  const betaMe = await (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${s2.token}` } })).json();
  assert.equal(betaMe.workflows.every((w) => w.client_account_id === s2.tenant.clientAccountId), true);
  assert.equal(betaMe.threads.length, 0);

  const dupSignup = await fetch(`${base}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessName: "Alpha Duplicate", email: "owner@alpha.example" }),
  });
  assert.equal(dupSignup.status, 409);

  const anonLessons = await fetch(`${base}/lessons?q=gemini`);
  assert.equal(anonLessons.status, 401);

  const lessonsRes = await fetch(`${base}/lessons?q=gemini`, { headers: { Authorization: `Bearer ${s1.token}` } });
  assert.equal(lessonsRes.status, 200);
  const lessonsData = await lessonsRes.json();
  assert.ok(lessonsData.count >= 1);
  assert.equal(lessonsData.lessons[0].id, "LES-001");
});

test("LINE group webhook supports join, bind NH-CODE, mention_only silence, @mention quote, and Jarvis pause/resume", async (t) => {
  const previous = {
    LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    WEBHOOK_ENCRYPTION_KEY: process.env.WEBHOOK_ENCRYPTION_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    FOUNDER_LINE_ID: process.env.FOUNDER_LINE_ID,
    GEMINI_ENABLED: process.env.GEMINI_ENABLED,
  };
  Object.assign(process.env, {
    LINE_CHANNEL_SECRET: PRIVATE,
    LINE_CHANNEL_ACCESS_TOKEN: PRIVATE,
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    SUPABASE_URL: "https://group-test.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_fixture-only",
    FOUNDER_LINE_ID: "Ufounder1",
    GEMINI_ENABLED: "false",
  });
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[require.resolve("../src/server")];
  });

  const { db, tables } = createMockTrialDb();
  const bindCode = "NH-GROUPTEST123456";
  tables.activation_codes.push({
    id: 1,
    code_hash: crypto.createHash("sha256").update(bindCode).digest("hex"),
    client_account_id: 1,
    department: "sales",
    status: "active",
    max_uses: 5,
    used_count: 0,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });

  const lineReplies = [];
  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(String(address));
    if (url.hostname === "api.line.me") {
      lineReplies.push(JSON.parse(options.body));
      return json({});
    }
    if (url.hostname === "group-test.invalid" && url.pathname.startsWith("/rest/v1/")) {
      const resource = url.pathname.slice("/rest/v1/".length) + url.search;
      const out = await db(resource, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      return json(out, (options.method || "GET") === "POST" ? 201 : 200);
    }
    return json({}, 404);
  });

  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");
  const groupId = "Cgroup1234567890abcdef1234567890";

  await gateway.handleEvent({ type: "join", replyToken: "rt-join", source: { type: "group", groupId } });
  assert.match(lineReplies.at(-1).messages[0].text, /bind NH-YOUR-CODE/);

  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-bind",
    source: { type: "group", groupId, userId: "Uowner1" },
    message: { type: "text", text: `bind ${bindCode}` },
  });
  assert.match(lineReplies.at(-1).messages[0].text, /Connected this LINE group to KNC/);
  assert.equal(tables.nh_line_group_bindings.length, 1);

  const hijackCode = "NH-HIJACK999999";
  tables.client_accounts.push({ id: 2, client_code: "EVL", company: "Other", active: true });
  tables.activation_codes.push({
    id: 2,
    code_hash: crypto.createHash("sha256").update(hijackCode).digest("hex"),
    client_account_id: 2,
    department: "sales",
    status: "active",
    max_uses: 1,
    used_count: 0,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-hijack",
    source: { type: "group", groupId, userId: "Uattacker" },
    message: { type: "text", text: `bind ${hijackCode}` },
  });
  assert.match(lineReplies.at(-1).messages[0].text, /already connected to another workspace/);
  assert.equal(tables.nh_line_group_bindings[0].client_account_id, 1);

  const countBeforeChatter = lineReplies.length;
  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-chatter",
    source: { type: "group", groupId, userId: "Umember1" },
    message: { type: "text", text: "Lunch at 12?" },
  });
  assert.equal(lineReplies.length, countBeforeChatter, "Unmentioned chatter must not receive AI reply");
  assert.equal(tables.nh_tenant_trials[0].used_messages, 0);

  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-mention",
    source: { type: "group", groupId, userId: "Umember1" },
    message: {
      type: "text",
      text: "@Neurohands Quote 10mm tempered glass 2x3m",
      mention: { mentionees: [{ index: 0, length: 11, type: "user", isSelf: true }] },
    },
  });
  assert.match(lineReplies.at(-1).messages[0].text, /Tempered Clear 10mm/);
  assert.equal(tables.nh_tenant_trials[0].used_messages, 1);

  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-pause",
    source: { type: "user", userId: "Ufounder1" },
    message: { type: "text", text: `pause: KNC ${groupId}` },
  });
  assert.match(lineReplies.at(-1).messages[0].text, /is now paused/);

  const repliesAfterPause = lineReplies.length;
  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-silenced",
    source: { type: "group", groupId, userId: "Umember1" },
    message: {
      type: "text",
      text: "@Neurohands what is the lead time?",
      mention: { mentionees: [{ index: 0, length: 11, type: "user", isSelf: true }] },
    },
  });
  assert.equal(lineReplies.slice(repliesAfterPause).some((p) => p.replyToken === "rt-silenced"), false);

  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-resume",
    source: { type: "user", userId: "Ufounder1" },
    message: { type: "text", text: `resume: KNC ${groupId}` },
  });
  assert.match(lineReplies.at(-1).messages[0].text, /is now ai_active/);

  await gateway.handleEvent({
    type: "message",
    replyToken: "rt-resumed-q",
    source: { type: "group", groupId, userId: "Umember1" },
    message: {
      type: "text",
      text: "@Neurohands what is the lead time?",
      mention: { mentionees: [{ index: 0, length: 11, type: "user", isSelf: true }] },
    },
  });
  assert.match(lineReplies.at(-1).messages[0].text, /7 days/);
});

test("neurohands-builder.html compiles cleanly with responsive breakpoints, trial UI controls, and zero code leaks", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "../assets/neurohands-builder.html"), "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, "Inline script block must exist");
  assert.doesNotThrow(() => new Function(scriptMatch[1]), "Inline builder JS must parse cleanly");
  for (const token of [
    "trial-workspace",
    "trial-allowance-bar",
    "trial-signup-form",
    "tw-group-mode",
    "handover-pause",
    "handover-takeover",
    "handover-resume",
    "/api/trial",
    "@media (max-width:900px)",
    "@media (max-width:760px)",
    "one Official Account per group",
  ]) {
    assert.ok(html.includes(token), `Missing required UI token: ${token}`);
  }
  assert.doesNotMatch(html, /tanadanaitan|supabase\.co|railway\.app|server\.js/i);
});
