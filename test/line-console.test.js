"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");

const {
  buildCustomRichMenuPayload,
  syncDefaultRichMenus,
  inspectLineConsoleReadiness,
  createLineAdminRouter,
} = require("../src/lib/line-console");
const { createLiffRouter, signHs256Jwt } = require("../src/lib/liff-router");
const { NEUROHANDS_PREVIEW_URL } = require("../scripts/setup-richmenu");

const SAMPLE_BUTTONS = [
  { type: "postback", data: "menu=about" },
  { type: "postback", data: "menu=services" },
  { type: "uri", uri: "https://knc-showroom.neurohands.site/catalog" },
  { type: "postback", data: "menu=contact" },
  { type: "postback", data: "menu=updates" },
  { type: "uri", uri: NEUROHANDS_PREVIEW_URL },
];

test("buildCustomRichMenuPayload enforces 6 buttons, 2500x1686 bounds, and strict URI allowlist", () => {
  const built = buildCustomRichMenuPayload({ name: "KNC Glass Menu", chatBarText: "KNC Menu", buttons: SAMPLE_BUTTONS });
  assert.equal(built.size.width, 2500);
  assert.equal(built.size.height, 1686);
  assert.equal(built.areas.length, 6);
  assert.equal(built.areas[2].action.uri, "https://knc-showroom.neurohands.site/catalog");

  assert.throws(() => buildCustomRichMenuPayload({ buttons: SAMPLE_BUTTONS.slice(0, 5) }), /6 Rich Menu/);
  assert.throws(() => {
    const bad = [...SAMPLE_BUTTONS];
    bad[2] = { type: "uri", uri: "https://evil.example/phish" };
    buildCustomRichMenuPayload({ buttons: bad });
  }, /untrusted URI/i);
  assert.throws(() => {
    const outOfBounds = [...SAMPLE_BUTTONS];
    outOfBounds[0] = { type: "postback", data: "menu=about", bounds: { x: 2400, y: 0, width: 200, height: 100 } };
    buildCustomRichMenuPayload({ buttons: outOfBounds });
  }, /bounds exceed/i);
});

test("syncDefaultRichMenus uploads menus, cleans up on image failure, and createLineAdminRouter checks readiness", async (t) => {
  const token = "secret-line-channel-access-token";
  const settings = new Map();
  let nextId = 1;
  const deleted = [];

  const mockFetch = async (url, opts = {}) => {
    assert.equal(opts.headers?.Authorization, `Bearer ${token}`);
    if (url === "https://api.line.me/v2/bot/richmenu" && opts.method === "POST") {
      return new Response(JSON.stringify({ richMenuId: `richmenu-${nextId++}` }), { status: 200 });
    }
    if (url.includes("/content") && opts.method === "POST") {
      return new Response("", { status: 200 });
    }
    if (url.includes("/user/all/richmenu/richmenu-1") && opts.method === "POST") {
      settings.set("default_live_menu", "richmenu-1");
      return new Response("{}", { status: 200 });
    }
    if (url === "https://api.line.me/v2/bot/info") {
      return new Response(JSON.stringify({ basicId: "@neurohands", displayName: "Neurohands" }), { status: 200 });
    }
    if (url === "https://api.line.me/v2/bot/channel/webhook/endpoint") {
      return new Response(JSON.stringify({
        endpoint: "https://neurohands-ai-agent-production.up.railway.app/webhook",
        active: true,
      }), { status: 200 });
    }
    if (url === "https://api.line.me/v2/bot/user/all/richmenu") {
      return new Response(JSON.stringify({ richMenuId: settings.get("default_live_menu") || "" }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  };

  const failingUploadFetch = async (url, opts = {}) => {
    if (url === "https://api.line.me/v2/bot/richmenu" && opts.method === "POST") {
      return new Response(JSON.stringify({ richMenuId: "richmenu-orphan" }), { status: 200 });
    }
    if (url.includes("/content")) return new Response("bad png", { status: 500 });
    if (opts.method === "DELETE") {
      deleted.push(url);
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(() => syncDefaultRichMenus({
    lineChannelAccessToken: token,
    saveSettingFn: async () => {},
    fetchImpl: failingUploadFetch,
  }), /upload rejected \(500\)/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /richmenu-orphan$/);

  const apiKey = "nh-admin-secret-key";
  const adminApp = express();
  adminApp.use("/api/line", createLineAdminRouter({
    apiKey,
    lineChannelSecret: "channel-secret-ok",
    lineChannelAccessToken: token,
    lineLoginChannelId: "",
    liffId: "",
    supabaseJwtSecret: "",
    publicBase: "https://neurohands-ai-agent-production.up.railway.app",
    getSettingFn: async (k, fb) => settings.get(k) ?? fb,
    saveSettingFn: async (k, v) => { settings.set(k, v); },
    fetchImpl: mockFetch,
  }));

  const srv = http.createServer(adminApp);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const baseUrl = `http://127.0.0.1:${srv.address().port}/api/line`;

  const unauth = await fetch(`${baseUrl}/readiness`);
  assert.equal(unauth.status, 401);

  const syncRes = await fetch(`${baseUrl}/richmenu-sync`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });
  assert.equal(syncRes.status, 200);
  const syncData = await syncRes.json();
  assert.equal(syncData.richmenuPublicId, "richmenu-1");
  assert.equal(syncData.richmenuActiveId, "richmenu-2");
  assert.equal(settings.get("richmenu_public_id"), "richmenu-1");

  const readyRes = await fetch(`${baseUrl}/readiness`, { headers: { "x-api-key": apiKey } });
  assert.equal(readyRes.status, 200);
  const report = await readyRes.json();
  assert.equal(report.readyForMessaging, true);
  assert.equal(report.readyForLiff, false);
  assert.equal(report.webhook.matchesExpected, true);
  assert.equal(report.defaultRichMenu.matchesSettings, true);
  assert.equal(JSON.stringify(report).includes(token), false);

  const standaloneCheck = await inspectLineConsoleReadiness({});
  assert.equal(standaloneCheck.readyForMessaging, false);
  assert.ok(standaloneCheck.consoleActions.length >= 2);
});

test("/api/liff/config and /api/liff/richmenu-publish enforce auth, URI policy, and Jarvis approval gate", async (t) => {
  const notes = [];
  const jwtSecret = "super-secret-jwt-key-at-least-16-chars";
  const liffApp = express();
  liffApp.use(express.json());
  liffApp.use("/api/liff", createLiffRouter({
    db: async () => [],
    lineLoginChannelId: "2006551900",
    liffId: "2006551900-nhbuild",
    supabaseJwtSecret: jwtSecret,
    apiKey: "nh-api-secret",
    founderLineId: "Ufounder1234567890abcdef12345678",
    websiteUrl: NEUROHANDS_PREVIEW_URL,
    proposeNote: async (content, category, proposedBy, _t, _a, clientAccountId) => {
      const id = notes.length + 1;
      notes.push({ id, content, category, proposedBy, clientAccountId });
      return id;
    },
  }));

  const srv = http.createServer(liffApp);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const baseUrl = `http://127.0.0.1:${srv.address().port}/api/liff`;

  const cfgRes = await fetch(`${baseUrl}/config`);
  assert.equal(cfgRes.status, 200);
  const cfg = await cfgRes.json();
  assert.equal(cfg.liffEnabled, true);
  assert.equal(cfg.liffId, "2006551900-nhbuild");
  assert.equal(JSON.stringify(cfg).includes(jwtSecret), false);

  const noAuth = await fetch(`${baseUrl}/richmenu-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Tenant Menu", chatBarText: "KNC", buttons: SAMPLE_BUTTONS }),
  });
  assert.equal(noAuth.status, 401);

  const validToken = signHs256Jwt({
    aud: "authenticated",
    role: "authenticated",
    sub: "line:U11111111111111111111111111111111",
    app_metadata: {
      provider: "line",
      line_user_id: "U11111111111111111111111111111111",
      client_account_id: 7,
      client_code: "KNC",
      role: "staff",
    },
    exp: Math.floor(Date.now() / 1000) + 300,
  }, jwtSecret);

  const pubRes = await fetch(`${baseUrl}/richmenu-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
    body: JSON.stringify({ name: "KNC Custom", chatBarText: "KNC", buttons: SAMPLE_BUTTONS }),
  });
  assert.equal(pubRes.status, 202);
  const pubData = await pubRes.json();
  assert.equal(pubData.requires_jarvis_approval, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].clientAccountId, 7);
});

test("20261117000001_dashboard_realtime_telemetry.sql hardens nh_sites RLS to app_metadata and revokes SECURITY DEFINER RPC", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  const files = [
    "fixtures/legacy-schema.sql",
    "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql",
    "../supabase/migrations/20261102000001_per_business_chat_rollup.sql",
    "../supabase/migrations/20261114000001_liff_website_builder.sql",
    "../supabase/migrations/20261117000001_dashboard_realtime_telemetry.sql",
  ];
  for (const rel of files) {
    await db.exec(fs.readFileSync(path.join(__dirname, rel), "utf8"));
  }

  await db.exec(`
    insert into public.client_accounts (id, client_code, company, active)
    overriding system value values (1, 'KNC', 'KNC Glass', true) on conflict (id) do nothing;
  `);

  await db.exec(`
    set local role authenticated;
    select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"provider":"line","client_account_id":1}}', true);
    insert into public.nh_sites (id, client_account_id, created_by_line_user_id, site_slug, title, status)
    values ('33333333-3333-3333-3333-333333333333', 1, 'Ustaff1', 'knc-appmeta-ok', 'KNC Site', 'published');
    reset role;
  `);

  await db.exec("begin; set local role authenticated;");
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"provider":"email"},"user_metadata":{"client_account_id":1}}', true)`);
  const forgedRows = await db.query("select id from public.nh_sites");
  assert.equal(forgedRows.rows.length, 0, "Forged user_metadata JWT must see zero tenant sites after 20261117000001");
  await db.exec("rollback;");

  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(async () => {
      await db.exec(`begin; set local role ${role};`);
      try {
        await db.query("select public.nh_forward_inquiry_to_cases()");
      } finally {
        await db.exec("rollback;");
      }
    }, /permission denied/i);
  }

  await db.exec("begin; set local role anon;");
  await db.query(`
    insert into public.nh_site_inquiries (site_id, client_account_id, customer_name, contact_phone)
    values ('33333333-3333-3333-3333-333333333333', 1, 'Anan', '0812345678')
  `);
  await db.exec("commit; reset role;");

  await db.exec("set local role service_role;");
  const forwarded = await db.query("select subject, client_account_id from public.support_cases");
  await db.exec("reset role;");
  assert.equal(forwarded.rows.length, 1);
  assert.equal(forwarded.rows[0].client_account_id, 1);

  await db.exec("begin; set local role authenticated;");
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"provider":"line","client_account_id":""}}', true)`);
  const blankClaimRows = await db.query("select id from public.nh_sites");
  assert.equal(blankClaimRows.rows.length, 0, "Empty string app_metadata.client_account_id must yield 0 rows without 22P02");
  await db.exec("rollback;");
});

test("Wave 1-2 security guards: URI pinning, rollback/cleanup, weak JWT config, and verify-line-console CLI", async () => {
  const { isValidRichMenuAction } = require("../scripts/setup-richmenu");
  const { spawnSync } = require("node:child_process");

  assert.equal(isValidRichMenuAction({ type: "uri", uri: "https://liff.line.me/2006551900-nhbuild/../steal" }, { allowedLiffId: "2006551900-nhbuild" }), false);
  assert.equal(isValidRichMenuAction({ type: "uri", uri: "https://liff.line.me/9999999999-other/site" }, { allowedLiffId: "2006551900-nhbuild" }), false);
  assert.equal(isValidRichMenuAction({ type: "uri", uri: "https://liff.line.me/2006551900-nhbuild/site" }, { allowedLiffId: "2006551900-nhbuild" }), true);

  assert.throws(() => buildCustomRichMenuPayload({
    buttons: [{ type: "uri", uri: "" }, ...SAMPLE_BUTTONS.slice(1)],
  }), /required/i);
  assert.throws(() => buildCustomRichMenuPayload({
    buttons: [{ type: "uri", uri: "https://other-tenant.neurohands.site/menu" }, ...SAMPLE_BUTTONS.slice(1)],
    allowedClientCode: "KNC",
  }), /untrusted URI/i);
  assert.throws(() => buildCustomRichMenuPayload({
    buttons: [{ type: "uri", uri: "https://kncevil.neurohands.site/menu" }, ...SAMPLE_BUTTONS.slice(1)],
    allowedClientCode: "KNC",
  }), /untrusted URI/i);
  const kncPinned = buildCustomRichMenuPayload({
    buttons: [{ type: "uri", uri: "https://knc.neurohands.site/catalog" }, ...SAMPLE_BUTTONS.slice(1)],
    allowedClientCode: "KNC",
  });
  assert.equal(kncPinned.areas[0].action.uri, "https://knc.neurohands.site/catalog");

  const deleted = [];
  const restored = [];
  let createdCount = 0;
  await assert.rejects(() => syncDefaultRichMenus({
    lineChannelAccessToken: "tok",
    getSettingFn: async (k) => (k === "richmenu_public_id" ? "richmenu-prev-pub" : null),
    saveSettingFn: async () => { throw new Error("DB down"); },
    fetchImpl: async (url, opts = {}) => {
      if (url === "https://api.line.me/v2/bot/richmenu" && opts.method === "POST") {
        createdCount += 1;
        return new Response(JSON.stringify({ richMenuId: `richmenu-new-${createdCount}` }), { status: 200 });
      }
      if (opts.method === "DELETE") { deleted.push(url); return new Response("{}", { status: 200 }); }
      if (url.includes("/user/all/richmenu/richmenu-prev-pub")) { restored.push(url); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    },
  }), /DB down/);
  assert.equal(deleted.length, 2);
  assert.equal(restored.length, 1);

  const superseded = [];
  const savedSettings = new Map();
  let nextMenu = 1;
  const okSync = await syncDefaultRichMenus({
    lineChannelAccessToken: "tok",
    getSettingFn: async (k) => (k === "richmenu_public_id" ? "richmenu-old-pub" : k === "richmenu_active_id" ? "richmenu-old-act" : null),
    saveSettingFn: async (k, v) => { savedSettings.set(k, v); },
    relinkPublicUserIds: ["Ufounder1"],
    relinkActiveUserIds: ["Uclient1"],
    fetchImpl: async (url, opts = {}) => {
      if (url === "https://api.line.me/v2/bot/richmenu" && opts.method === "POST") {
        return new Response(JSON.stringify({ richMenuId: `richmenu-fresh-${nextMenu++}` }), { status: 200 });
      }
      if (opts.method === "DELETE") { superseded.push(url); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(okSync.richmenuPublicId, "richmenu-fresh-1");
  assert.equal(okSync.relinkedUsers, 2);
  assert.equal(superseded.length, 2);
  assert.ok(superseded.some((u) => u.endsWith("/richmenu-old-pub")));
  assert.ok(superseded.some((u) => u.endsWith("/richmenu-old-act")));

  const weakApp = express();
  weakApp.use("/api/liff", createLiffRouter({
    db: async () => [],
    lineLoginChannelId: "2006551900",
    liffId: "2006551900-nhbuild",
    supabaseJwtSecret: "too-short",
  }));
  const weakSrv = http.createServer(weakApp);
  await new Promise((resolve) => weakSrv.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${weakSrv.address().port}/api/liff/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.liffEnabled, false);
  } finally {
    weakSrv.close();
  }

  const cliOk = spawnSync(process.execPath, [require.resolve("../scripts/verify-line-console")], { env: {}, encoding: "utf8", timeout: 5000 });
  assert.equal(cliOk.status, 0);
  const parsed = JSON.parse(cliOk.stdout);
  assert.equal(parsed.readyForMessaging, false);

  const cliStrict = spawnSync(process.execPath, [require.resolve("../scripts/verify-line-console"), "--strict"], { env: {}, encoding: "utf8", timeout: 5000 });
  assert.equal(cliStrict.status, 1);
  assert.doesNotThrow(() => JSON.parse(cliStrict.stdout));
});
