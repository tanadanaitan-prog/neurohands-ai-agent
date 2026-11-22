import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");
const { createTrialRouter } = require("../src/lib/trial-router");
const { createOrgLearningService } = require("../src/lib/org-learning-store");
const { createOrgCouncilRouter } = require("../src/lib/org-council-router");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, "..");
const BUILDER_HTML = path.join(PLATFORM_DIR, "assets", "neurohands-builder.html");

const ALLOWED_TABLES = new Set([
  "client_accounts",
  "nh_tenant_trials",
  "nh_agent_workflows",
  "nh_line_group_bindings",
  "nh_conversation_states",
  "nh_dev_lessons",
  "activation_codes",
  "glass_types",
  "settings",
  "jarvis_notes",
]);

const JSONB_COLUMNS = new Set(["workflow_spec", "published_spec", "group_policy", "metadata"]);

function assertIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}

async function bootPglite() {
  const pg = new PGlite();
  await pg.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  const migrations = [
    "test/fixtures/legacy-schema.sql",
    "supabase/migrations/20260907123525_phase1_gateway_recovery.sql",
    "supabase/migrations/20261102000001_per_business_chat_rollup.sql",
    "supabase/migrations/20261114000001_liff_website_builder.sql",
    "supabase/migrations/20261117000001_dashboard_realtime_telemetry.sql",
    "supabase/migrations/20261122000001_customer_trial_release.sql",
  ];
  for (const rel of migrations) {
    await pg.exec(fs.readFileSync(path.join(PLATFORM_DIR, rel), "utf8"));
  }
  await pg.exec("set role service_role;");
  return pg;
}

function createPgliteRestBridge(pg) {
  function encodeVal(col, val) {
    if (val === undefined) return null;
    if (JSONB_COLUMNS.has(col) && val !== null && typeof val === "object") {
      return JSON.stringify(val);
    }
    return val;
  }

  return async function db(pathStr, options = {}) {
    const [resource, qs = ""] = String(pathStr).split("?");
    const params = new URLSearchParams(qs);
    const method = (options.method || "GET").toUpperCase();

    if (resource === "rpc/nh_consume_trial_allowance") {
      const b = options.body || {};
      const res = await pg.query(
        "select * from public.nh_consume_trial_allowance($1::bigint, $2::integer, $3::integer, $4::numeric, $5::timestamptz)",
        [Number(b.p_client_account_id), Number(b.p_messages || 0), Number(b.p_actions || 0), Number(b.p_cost_usd || 0), b.p_now || new Date().toISOString()]
      );
      return res.rows;
    }

    if (resource === "rpc/nh_claim_activation_code") {
      const b = options.body || {};
      const res = await pg.query("select * from public.nh_claim_activation_code($1::text)", [String(b.p_code_hash || "")]);
      return res.rows;
    }

    if (!ALLOWED_TABLES.has(resource)) {
      throw new Error(`Unsupported table in pilot bridge: ${resource}`);
    }
    const table = assertIdent(resource);

    if (method === "GET") {
      const where = [];
      const values = [];
      for (const [k, v] of params.entries()) {
        if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
        const col = assertIdent(k);
        if (v.startsWith("eq.")) {
          values.push(v.slice(3));
          where.push(`"${col}" = $${values.length}`);
        } else if (v.startsWith("ilike.")) {
          values.push(v.slice(6));
          where.push(`lower("${col}") = lower($${values.length})`);
        }
      }
      let sql = `select * from public."${table}"`;
      if (where.length) sql += ` where ${where.join(" and ")}`;
      const order = params.get("order");
      if (order) {
        const [ocol, odir] = order.split(".");
        sql += ` order by "${assertIdent(ocol)}" ${odir === "desc" ? "desc" : "asc"}`;
      }
      const limit = Number(params.get("limit") || 0);
      if (Number.isInteger(limit) && limit > 0) sql += ` limit ${Math.min(limit, 500)}`;
      return (await pg.query(sql, values)).rows;
    }

    if (method === "POST") {
      const body = options.body || {};
      const cols = Object.keys(body).map(assertIdent);
      const vals = cols.map((c) => encodeVal(c, body[c]));
      const placeholders = cols.map((c, i) => (JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
      let sql = `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(", ")}) values (${placeholders.join(", ")})`;
      const conflict = params.get("on_conflict");
      if (conflict) {
        const cCols = conflict.split(",").map((c) => `"${assertIdent(c.trim())}"`).join(", ");
        const prefer = String(options.headers?.Prefer || "");
        if (prefer.includes("ignore-duplicates")) {
          sql += ` on conflict (${cCols}) do nothing`;
        } else {
          const updates = cols.map((c) => `"${c}" = excluded."${c}"`).join(", ");
          sql += ` on conflict (${cCols}) do update set ${updates}`;
        }
      }
      sql += " returning *";
      return (await pg.query(sql, vals)).rows;
    }

    if (method === "PATCH") {
      const body = options.body || {};
      const setCols = Object.keys(body).map(assertIdent);
      const values = setCols.map((c) => encodeVal(c, body[c]));
      const setSql = setCols.map((c, i) => `"${c}" = $${i + 1}${JSONB_COLUMNS.has(c) ? "::jsonb" : ""}`).join(", ");
      const where = [];
      for (const [k, v] of params.entries()) {
        if (["select", "order", "limit"].includes(k)) continue;
        const col = assertIdent(k);
        if (v.startsWith("eq.")) {
          values.push(v.slice(3));
          where.push(`"${col}" = $${values.length}`);
        }
      }
      if (!where.length) throw new Error(`Refusing unfiltered PATCH on ${table}`);
      const sql = `update public."${table}" set ${setSql} where ${where.join(" and ")} returning *`;
      return (await pg.query(sql, values)).rows;
    }

    throw new Error(`Unsupported HTTP method: ${method}`);
  };
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No Chrome/Edge binary found for headless pilot verification");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (e) {
      lastErr = e;
    }
    await sleep(80);
  }
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

async function withChrome(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nh-pilot-"));
  const profile = path.join(scratch, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise((r) => chrome.once("exit", r));

  let ws = null;
  try {
    const port = await until(() => {
      const file = path.join(profile, "DevToolsActivePort");
      if (!fs.existsSync(file)) return null;
      const num = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
      return Number.isInteger(num) && num > 0 ? num : null;
    }, "DevToolsActivePort");

    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === "page");
    }, "page target");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.text);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        consoleErrors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim());
      }
    };

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };

    for (const domain of ["Page", "Runtime", "Network", "Log"]) await send(`${domain}.enable`);
    return await fn({ send, evaluate, consoleErrors });
  } finally {
    if (ws) {
      try {
        ws.onmessage = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {}
    }
    await sleep(50);
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      chrome.kill("SIGKILL");
    }
    await Promise.race([exited, sleep(1500)]);
    await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}

async function runDeviceJourney({ send, evaluate, consoleErrors }, url, device) {
  consoleErrors.length = 0;
  await send("Emulation.setDeviceMetricsOverride", {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.scale,
    mobile: device.mobile,
  });

  await send("Page.navigate", { url });
  await until(() => evaluate("document.readyState === 'complete' && !!document.getElementById('trial-signup-form')"), `${device.name} ready`);
  await evaluate("sessionStorage.clear(); localStorage.clear();");
  await send("Page.reload", { ignoreCache: true });
  await until(() => evaluate("document.readyState === 'complete' && !document.getElementById('trial-signup-card').hidden"), `${device.name} clean reload`);

  const overflowBefore = await evaluate("document.documentElement.scrollWidth - window.innerWidth");
  assert.ok(overflowBefore <= 1, `${device.name} overflow before signup: ${overflowBefore}px`);

  const paletteWorks = await evaluate(`(() => {
    const btn = document.querySelector('.pblock');
    if (!btn) return false;
    btn.click();
    return document.querySelectorAll('.chip').length >= 1;
  })()`);
  assert.equal(paletteWorks, true, `${device.name} drag/tap block interaction failed`);

  await evaluate(`(() => {
    document.getElementById('ts-biz').value = ${JSON.stringify(`Pilot ${device.name} Glass Co`)};
    document.getElementById('ts-email').value = ${JSON.stringify(`pilot-${device.name}@example.com`)};
    document.getElementById('ts-submit').click();
  })()`);
  await until(() => evaluate("!document.getElementById('trial-console').hidden"), `${device.name} trial console visible`);

  const overflowAfter = await evaluate("document.documentElement.scrollWidth - window.innerWidth");
  assert.ok(overflowAfter <= 1, `${device.name} overflow after signup: ${overflowAfter}px`);

  const initMsgs = await evaluate("document.getElementById('tm-msgs').textContent");
  assert.equal(initMsgs, "Messages: 200 / 200");

  await evaluate(`(() => {
    document.getElementById('tw-knowledge').value = 'Pilot Tempered 10mm | 150 | Approved custom pilot glass';
    document.getElementById('tw-group-mode').value = 'keyword';
    document.getElementById('tw-save').click();
  })()`);
  await until(() => evaluate("document.getElementById('tw-chat-log').textContent.includes('saved')"), `${device.name} workflow saved`);

  await evaluate(`(() => {
    document.getElementById('tw-test-input').value = 'Quote Pilot Tempered 10mm 2x3m';
    document.getElementById('tw-test-send').click();
  })()`);
  await until(() => evaluate("document.getElementById('tw-chat-log').textContent.includes('9,687 THB')"), `${device.name} custom KB quote reply`);
  assert.equal(await evaluate("document.getElementById('tm-msgs').textContent"), "Messages: 199 / 200");

  await evaluate(`document.querySelector('[data-tprompt="Give 15% discount and create order task"]').click()`);
  await until(() => evaluate("!document.getElementById('tw-approval-bar').hidden"), `${device.name} approval bar shown`);
  assert.equal(await evaluate("document.getElementById('tm-state').textContent"), "Thread: Awaiting Approval");
  assert.equal(await evaluate("document.getElementById('tm-acts').textContent"), "Actions: 49 / 50");

  await evaluate(`document.querySelector('[data-testid="handover-approve"]').click()`);
  await until(() => evaluate("document.getElementById('tw-approval-bar').hidden && document.getElementById('tm-state').textContent === 'Thread: AI Active'"), `${device.name} approved action`);

  await evaluate(`document.querySelector('[data-testid="handover-takeover"]').click()`);
  await until(() => evaluate("document.getElementById('tm-state').textContent === 'Thread: Human Takeover'"), `${device.name} human takeover`);

  await evaluate(`(() => {
    document.getElementById('tw-test-input').value = 'Hello while human owns thread';
    document.getElementById('tw-test-send').click();
  })()`);
  await until(() => evaluate("document.getElementById('tw-chat-log').textContent.includes('AI reply suppressed')"), `${device.name} AI suppressed`);
  assert.equal(await evaluate("document.getElementById('tm-msgs').textContent"), "Messages: 198 / 200");

  await evaluate(`document.querySelector('[data-testid="handover-resume"]').click()`);
  await until(() => evaluate("document.getElementById('tm-state').textContent === 'Thread: AI Active'"), `${device.name} resume AI`);

  await evaluate(`(() => {
    document.getElementById('tw-perm-lead').checked = false;
    document.getElementById('tw-save').click();
  })()`);
  await until(() => evaluate("(document.getElementById('tw-chat-log').textContent.match(/LINE group rules saved/g) || []).length >= 2"), `${device.name} permission workflow saved`);
  await evaluate(`document.querySelector('[data-tprompt="What is the lead time?"]').click()`);
  await until(() => evaluate("document.getElementById('tm-msgs').textContent === 'Messages: 197 / 200'"), `${device.name} permission-checked lead time`);
  const lastBotMsg = await evaluate("Array.from(document.querySelectorAll('#tw-chat-log .trial-msg.b')).pop().textContent");
  assert.equal(lastBotMsg.includes("7 days"), false, `${device.name} disabled lead-time permission leaked`);

  await evaluate("document.getElementById('tw-publish').click()");
  await until(() => evaluate("!document.getElementById('tw-deploy-box').hidden && document.getElementById('tw-code-group').textContent.startsWith('bind NH-')"), `${device.name} LINE publish codes`);

  const checkboxAudit = await evaluate(`(() => {
    const ids = ['tw-perm-quote','tw-perm-lead','tw-perm-task','tw-perm-human','tw-require-approval'];
    return ids.every((id) => {
      const box = document.getElementById(id);
      if (!box) return false;
      const r = box.getBoundingClientRect();
      return r.width > 0 && r.width <= 24 && r.height > 0 && r.height <= 24;
    });
  })()`);
  assert.equal(checkboxAudit, true, `${device.name} checkbox alignment check failed`);

  const journeyVisible = await evaluate("!!document.querySelector('[data-testid=\"trial-journey-steps\"]') && !!document.getElementById('step-ind-4')");
  assert.equal(journeyVisible, true, `${device.name} 4-step journey progress bar missing`);

  const copyOk = await evaluate(`(() => {
    const btn = document.querySelector('[data-copy-target="tw-code-1to1"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  assert.equal(copyOk, true, `${device.name} 1-click copy button missing`);

  await evaluate("document.getElementById('tw-card-step4')?.scrollIntoView({ behavior: 'instant', block: 'start' })");
  await until(() => evaluate(`(() => {
    const imgs = Array.from(document.querySelectorAll('#tw-card-step4 img[src*="/assets/guides/"]'));
    return imgs.length === 3 && imgs.every((img) => img.complete && img.naturalWidth === 1200);
  })()`), `${device.name} Step 4 visual guide PNGs loaded`);

  if (process.env.PILOT_SHOTS_DIR) {
    fs.mkdirSync(process.env.PILOT_SHOTS_DIR, { recursive: true });
    await evaluate(`(() => {
      const skip = Array.from(document.querySelectorAll('button')).find((b) => /skip tour/i.test(b.textContent));
      if (skip) skip.click();
      document.getElementById('trial-workspace').scrollIntoView({ behavior: 'instant', block: 'start' });
    })()`);
    await sleep(250);
    const shot1 = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.PILOT_SHOTS_DIR, `v2_pilot_${device.name}_workspace.png`), Buffer.from(shot1.data, "base64"));
    if (device.name === "laptop") {
      await evaluate("document.getElementById('top').scrollIntoView({ behavior: 'instant', block: 'start' })");
      await sleep(200);
      const shotHero = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.PILOT_SHOTS_DIR, "v2_pilot_laptop_hero.png"), Buffer.from(shotHero.data, "base64"));
      await evaluate("document.getElementById('tw-card-step4').scrollIntoView({ behavior: 'instant', block: 'start' })");
      await sleep(200);
      const shotStep4 = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.PILOT_SHOTS_DIR, "v2_pilot_laptop_step4_guides.png"), Buffer.from(shotStep4.data, "base64"));
    }
  }

  await evaluate(`(() => {
    document.getElementById('tw-lessons-q').value = 'quota';
    document.getElementById('tw-lessons-btn').click();
  })()`);
  await until(() => evaluate("document.querySelectorAll('#tw-lessons-list .trial-lesson-item').length >= 1"), `${device.name} lessons search`);
  const lessonCardText = await evaluate("document.querySelector('#tw-lessons-list .trial-lesson-item').textContent");
  assert.match(lessonCardText, /LES-007:.*Fix: \S+.*Check: \S+/, `${device.name} lesson card missing fields: ${lessonCardText}`);

  await until(() => evaluate("document.querySelectorAll('#org-teams-grid .org-team-card').length === 11"), `${device.name} 11-team AI org hub`);
  const orgAudit = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('#org-teams-grid .org-team-card'));
    const ids = cards.map((c) => c.getAttribute('data-team-id'));
    const roleOptions = Array.from(document.querySelectorAll('#ts-role option')).map((o) => o.value);
    return {
      count: cards.length,
      hasAfterService: ids.includes('after-service'),
      hasCustomerService: ids.includes('customer-service'),
      hasGovernance: ids.includes('health-monitor') && ids.includes('security-guard') && ids.includes('audit-compliance'),
      teamLabel: document.getElementById('org-team-count')?.textContent,
      agentLabel: document.getElementById('org-agent-count')?.textContent,
      roleOptionCount: roleOptions.length,
      hasAfterServiceRoleOption: roleOptions.some((v) => v.includes('After-Service')),
    };
  })()`);
  assert.equal(orgAudit.count, 11, `${device.name} expected 11 org team cards`);
  assert.equal(orgAudit.hasAfterService, true, `${device.name} missing separate after-service team card`);
  assert.equal(orgAudit.hasCustomerService, true, `${device.name} missing customer-service team card`);
  assert.equal(orgAudit.hasGovernance, true, `${device.name} missing 3 governance team cards`);
  assert.equal(orgAudit.teamLabel, "11 Specialized Teams");
  assert.equal(orgAudit.agentLabel, "32 Role-Isolated Agents");
  assert.equal(orgAudit.hasAfterServiceRoleOption, true, `${device.name} missing After-Service role option`);

  await send("Page.reload", { ignoreCache: true });
  await until(() => evaluate("!document.getElementById('trial-console').hidden && document.getElementById('tw-group-mode').value === 'keyword' && document.getElementById('tw-perm-lead').checked === false"), `${device.name} state hydrated after reload`);
  assert.equal(await evaluate("document.getElementById('tm-msgs').textContent"), "Messages: 197 / 200");
  assert.equal(consoleErrors.length, 0, `${device.name} console errors: ${consoleErrors.join(" | ")}`);

  return {
    device: device.name,
    viewport: `${device.width}x${device.height}`,
    overflowBeforePx: overflowBefore,
    overflowAfterPx: overflowAfter,
    remainingMessages: 197,
    remainingActions: 49,
    consoleErrors: consoleErrors.length,
    passed: true,
  };
}

async function main() {
  const pg = await bootPglite();
  const db = createPgliteRestBridge(pg);
  const jwtSecret = crypto.randomBytes(32).toString("hex");
  const proposals = [];

  const app = express();
  app.use(express.json());
  app.get("/neurohands", (_req, res) => res.type("html").send(fs.readFileSync(BUILDER_HTML, "utf8")));
  app.get("/assets/guides/:file", (req, res) => {
    const file = String(req.params.file || "");
    if (!/^[a-z0-9-]+\.png$/.test(file)) return res.status(404).end();
    const full = path.join(PLATFORM_DIR, "assets", "guides", file);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.type("png").send(fs.readFileSync(full));
  });
  app.get("/api/liff/config", (_req, res) => res.json({ liffEnabled: false, liffId: "" }));
  app.use("/api/org", createOrgCouncilRouter({
    service: createOrgLearningService(),
    apiKey: ["pilot", "org", "test", "123456"].join("-"),
    founderLineId: "UfounderPilot",
  }));
  app.use("/api/trial", createTrialRouter({
    db,
    supabaseJwtSecret: jwtSecret,
    founderLineId: "UfounderPilot",
    proposeNote: async (content, cat, proposer, toolName, toolArgs, accountId) => {
      const id = proposals.length + 1;
      proposals.push({ id, content, toolName, accountId });
      return id;
    },
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/neurohands`;

  const devices = [
    { name: "phone", width: 390, height: 844, scale: 2, mobile: true },
    { name: "tablet", width: 768, height: 1024, scale: 2, mobile: true },
    { name: "laptop", width: 1440, height: 900, scale: 1, mobile: false },
  ];

  try {
    const results = await withChrome(async (cdp) => {
      const out = [];
      for (const dev of devices) {
        out.push(await runDeviceJourney(cdp, url, dev));
      }
      return out;
    });

    const trials = (await pg.query("select client_account_id, owner_email from public.nh_tenant_trials order by client_account_id asc")).rows;
    assert.equal(trials.length, 3, "Expected 3 isolated trial tenants");

    await pg.exec("reset role;");
    for (const trialRow of trials) {
      const accountId = Number(trialRow.client_account_id);
      await pg.exec("begin; set local role authenticated;");
      await pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", app_metadata: { provider: "trial_web", client_account_id: accountId } })]);
      const wfRows = (await pg.query("select client_account_id from public.nh_agent_workflows")).rows;
      const thRows = (await pg.query("select client_account_id from public.nh_conversation_states")).rows;
      await pg.exec("rollback;");
      assert.equal(wfRows.length, 1, `Expected 1 isolated workflow for tenant ${accountId}, got ${wfRows.length}`);
      assert.equal(Number(wfRows[0].client_account_id), accountId);
      assert.equal(thRows.length, 1, `Expected 1 isolated thread for tenant ${accountId}, got ${thRows.length}`);
      assert.equal(Number(thRows[0].client_account_id), accountId);
    }

    console.log(JSON.stringify({
      ok: true,
      postgres: "PGlite PostgreSQL 17",
      devices: results,
      rlsIsolationVerified: true,
      tenantsTested: trials.length,
      stagedProposals: proposals.length,
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pg.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
