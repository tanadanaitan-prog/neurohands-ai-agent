"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const {
  validateSiteAst,
  calculateEdgingCost,
  compileSiteHtml,
  buildLineProposalFlexMessage,
  verifyLiffIdTokenAndMintJwt,
} = require("../src/lib/liff-builder");
const http = require("node:http");
const { isValidRichMenuAction, loadMenu, NEUROHANDS_PREVIEW_URL } = require("../scripts/setup-richmenu");
const { app, BRAND_COPY, DEFAULT_PUBLIC_UPDATES, normalizeGeminiModelName } = require("../src/server");
const express = require("express");
const { createLiffRouter, signHs256Jwt } = require("../src/lib/liff-router");

const SAMPLE_AST = {
  version: "1.0.0",
  siteSlug: "knc-architectural-glass",
  title: "KNC Tempered & Laminated Glass Catalog",
  theme: {
    primaryColor: "#0284C7",
    borderRadius: "md",
    fontFamily: "Inter",
  },
  blocks: [
    {
      id: "hero-1",
      type: "HeroBannerBlock",
      props: { heading: "KNC Architectural Glass", subheading: "ISO-Certified Tempering & Edging" },
    },
    {
      id: "catalog-1",
      type: "GlassCatalogBlock",
      props: { displayCategories: ["tempered_exterior", "decorative_interior"], showPrices: true },
    },
    {
      id: "calc-1",
      type: "EdgingCalculatorBlock",
      props: { defaultEdgingType: "EDG-FP", allowCustomDimensions: true },
    },
    {
      id: "lead-1",
      type: "LeadInquiryBlock",
      props: { targetDepartment: "sales", successMessage: "We will reply on LINE shortly." },
    },
    {
      id: "line-1",
      type: "LineContactBlock",
      props: { lineOaId: "@kncglass", buttonText: "Request Instant Quote on LINE" },
    },
  ],
};

test("SiteAST validator, edging calculator, HTML5 compiler, and Flex proposal builder enforce Milestone 4 contracts", () => {
  assert.deepEqual(validateSiteAst(SAMPLE_AST), { valid: true, errors: [] });
  assert.equal(validateSiteAst({ ...SAMPLE_AST, siteSlug: "INVALID SLUG!" }).valid, false);
  assert.equal(
    validateSiteAst({
      ...SAMPLE_AST,
      blocks: [
        { id: "dup", type: "HeroBannerBlock", props: { heading: "A" } },
        { id: "dup", type: "HeroBannerBlock", props: { heading: "B" } },
      ],
    }).valid,
    false
  );

  const calc = calculateEdgingCost({ widthCm: 120, heightCm: 240, ratePerMeter: 45 });
  assert.deepEqual(calc, { perimeterMeters: 7.2, totalBaht: 324 });
  assert.throws(() => calculateEdgingCost({ widthCm: 0, heightCm: 100, ratePerMeter: 45 }), RangeError);

  const html = compileSiteHtml(SAMPLE_AST, { clientCode: "KNC" });
  assert.match(html, /https:\/\/knc-knc-architectural-glass\.neurohands\.site/);
  assert.match(html, /overscroll-behavior-y: contain/);
  assert.match(html, /touch-action: none/);
  assert.match(html, /window\.visualViewport/);
  assert.equal(html.includes("<script>alert"), false);

  const flex = buildLineProposalFlexMessage(SAMPLE_AST, {
    liveUrl: "https://knc-knc-architectural-glass.neurohands.site",
    liffId: "2006551900-kncbuild",
  });
  assert.equal(flex.type, "flex");
  assert.equal(
    flex.contents.footer.contents[1].action.uri,
    "https://liff.line.me/2006551900-kncbuild?site=knc-architectural-glass"
  );
});

test("verifyLiffIdTokenAndMintJwt validates LINE JWKS claims and mints tenant-scoped Supabase JWTs", async () => {
  const validLineUserId = "U" + "a1b2c3d4".repeat(4);
  const nowSec = 1_760_000_000;
  const minted = await verifyLiffIdTokenAndMintJwt({
    idToken: "eyJ.synthetic.token",
    channelId: "2006551900",
    nowSec,
    verifySignature: async () => ({
      iss: "https://access.line.me",
      aud: "2006551900",
      exp: nowSec + 1800,
      sub: validLineUserId,
    }),
    resolveBinding: async (sub) => ({
      line_user_id: sub,
      client_account_id: 1,
      client_code: "KNC",
      role: "staff",
      active: true,
    }),
    signSupabaseJwt: async (payload) => `sb-jwt:${payload.user_metadata.client_account_id}:${payload.exp}`,
  });

  assert.equal(minted.ok, true);
  assert.equal(minted.status, 200);
  assert.equal(minted.supabaseToken, `sb-jwt:1:${nowSec + 3600}`);
  assert.equal(minted.claims.user_metadata.client_account_id, 1);

  const expired = await verifyLiffIdTokenAndMintJwt({
    idToken: "eyJ.expired",
    channelId: "2006551900",
    nowSec,
    verifySignature: async () => ({
      iss: "https://access.line.me",
      aud: "2006551900",
      exp: nowSec - 1,
      sub: validLineUserId,
    }),
    resolveBinding: async () => assert.fail("Expired token must not query bindings"),
    signSupabaseJwt: async () => assert.fail("Expired token must not mint JWT"),
  });
  assert.deepEqual(expired, { ok: false, status: 401, code: "TOKEN_EXPIRED" });
});

test("Rich Menu validator, BRAND_COPY, and /neurohands website hide personal names and internal code", async (t) => {
  assert.equal(NEUROHANDS_PREVIEW_URL, "https://neurohands-ai-agent-production.up.railway.app/neurohands");
  assert.equal(isValidRichMenuAction({ type: "postback", data: "menu=products" }), true);
  assert.equal(
    isValidRichMenuAction({ type: "uri", uri: "https://liff.line.me/2006551900-kncbuild?site=knc-catalog" }),
    true
  );
  assert.equal(
    isValidRichMenuAction({ type: "uri", uri: NEUROHANDS_PREVIEW_URL }),
    true
  );
  assert.equal(
    isValidRichMenuAction({ type: "uri", uri: "https://neurohands-ai-agent-production.up.railway.app/website#builder" }),
    true
  );
  assert.equal(
    isValidRichMenuAction({ type: "uri", uri: "https://tanadanaitan-prog.github.io/neurohands-preview/" }),
    false
  );
  assert.equal(isValidRichMenuAction({ type: "uri", uri: "http://liff.line.me/insecure" }), false);
  assert.equal(isValidRichMenuAction({ type: "uri", uri: "https://evil.example.com/phish" }), false);
  const publicMenu = loadMenu("public").menu;
  assert.ok(publicMenu.areas.length > 0);
  assert.ok(
    publicMenu.areas.some((area) => area.action?.type === "uri" && area.action?.uri === NEUROHANDS_PREVIEW_URL),
    "Public Rich Menu must include a URI action pointing to https://neurohands-ai-agent-production.up.railway.app/neurohands"
  );
  assert.ok(loadMenu("active").menu.areas.length > 0);
  for (const key of ["about", "services", "projects", "activate"]) {
    assert.ok(BRAND_COPY[key].includes(NEUROHANDS_PREVIEW_URL), `BRAND_COPY.${key} must link to ${NEUROHANDS_PREVIEW_URL}`);
    assert.doesNotMatch(BRAND_COPY[key], /tanadanaitan|prototype/i);
  }
  assert.match(BRAND_COPY.about, /private hardware/i);
  assert.match(BRAND_COPY.about, /(?:automatic|encrypted) backup/i);
  assert.ok(DEFAULT_PUBLIC_UPDATES.includes(NEUROHANDS_PREVIEW_URL));
  assert.match(DEFAULT_PUBLIC_UPDATES, /private hardware/i);
  assert.doesNotMatch(DEFAULT_PUBLIC_UPDATES, /tanadanaitan|prototype/i);
  assert.doesNotMatch(BRAND_COPY.contact, /your-domain/i);
  assert.equal(normalizeGeminiModelName("gemini-3.6-flash"), "gemini-3.6-flash");
  assert.equal(normalizeGeminiModelName(" gemini-3.8-flash "), "gemini-3.8-flash");

  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const port = srv.address().port;
  for (const routePath of ["/neurohands", "/website", "/preview"]) {
    const res = await fetch(`http://127.0.0.1:${port}${routePath}`);
    assert.equal(res.status, 200, `GET ${routePath} should return 200`);
    const body = await res.text();
    assert.match(body, /<title>Neurohands<\/title>/);
    assert.doesNotMatch(
      body,
      /tanadanaitan|GEMINI_API_KEY|secret_environment_variables|TOOLMAP|POST \/webhook|window\.NH|Prototype/i,
      `GET ${routePath} must not expose personal name or internal code`
    );
  }
});

test("20261114000001_liff_website_builder.sql enforces tenant RLS isolation and forwards anonymous web inquiries into support_cases", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, "fixtures/legacy-schema.sql"), "utf8"));
  await db.exec(
    fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql"), "utf8")
  );
  await db.exec(
    fs.readFileSync(path.join(__dirname, "../supabase/migrations/20261114000001_liff_website_builder.sql"), "utf8")
  );

  await db.exec(`
    insert into public.client_accounts (id, client_code, company, active)
    overriding system value
    values (1, 'KNC', 'KNC Glass', true), (2, 'OTH', 'Other Glass', true)
    on conflict (id) do nothing;
  `);

  await db.exec(`
    set local role authenticated;
    select set_config('request.jwt.claims', '{"role":"authenticated","user_metadata":{"client_account_id":1}}', true);
    insert into public.nh_sites (id, client_account_id, created_by_line_user_id, site_slug, title, status)
    values
      ('11111111-1111-1111-1111-111111111111', 1, 'Ustaff1', 'knc-published', 'KNC Published Site', 'published'),
      ('22222222-2222-2222-2222-222222222222', 1, 'Ustaff1', 'knc-draft', 'KNC Private Draft', 'draft');
    reset role;
  `);

  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"role":"authenticated","user_metadata":{"client_account_id":2}}', true);`);
  const crossTenantSites = await db.query("select site_slug from public.nh_sites");
  assert.equal(crossTenantSites.rows.length, 0, "Tenant 2 must not see Tenant 1 sites");
  await assert.rejects(
    db.query(`
      insert into public.nh_sites (client_account_id, created_by_line_user_id, site_slug, title)
      values (1, 'Ustaff2', 'spoof-tenant-1', 'Spoof')
    `),
    /row-level security/i
  );
  await db.exec("reset role;");

  await db.exec("set role anon;");
  const anonSites = await db.query("select site_slug from public.nh_sites");
  assert.deepEqual(anonSites.rows, [{ site_slug: "knc-published" }], "Anon visitors only see published sites");

  await db.query(`
    insert into public.nh_site_inquiries (site_id, client_account_id, customer_name, contact_phone, product_interest, specifications)
    values ('11111111-1111-1111-1111-111111111111', 1, 'Somchai Builder', '0812345678', 'Tempered 10mm', '{"qty":12}'::jsonb)
  `);
  await assert.rejects(
    db.query(`
      insert into public.nh_site_inquiries (site_id, client_account_id, customer_name, contact_phone)
      values ('22222222-2222-2222-2222-222222222222', 1, 'Draft Spammer', '0899999999')
    `),
    /row-level security/i
  );
  await db.exec("reset role;");

  const cases = await db.query(
    "select client_account_id, line_user_id, department, subject, urgency, status from public.support_cases"
  );
  assert.deepEqual(cases.rows, [
    {
      client_account_id: 1,
      line_user_id: null,
      department: "sales",
      subject: "Website Lead: Somchai Builder",
      urgency: "high",
      status: "open",
    },
  ]);
});


test("createLiffRouter handles LIFF auth, SiteAST persistence, inquiry leads, demo-request support_cases, and Jarvis-gated config-import", async (t) => {
  const validLineUserId = "U1234567890abcdef1234567890abcdef";
  const tables = {
    client_agent_bindings: [{ client_account_id: 11, line_user_id: validLineUserId, department: "sales", status: "active", activated_at: "2026-11-17T00:00:00Z", client_accounts: { client_code: "KNC", active: true } }],
    nh_sites: [],
    nh_site_inquiries: [],
    support_cases: [],
    jarvis_notes: [],
  };
  const ownerNotices = [];
  const fakeDb = async (queryPath, opts = {}) => {
    const [rawTable, rawQs] = queryPath.split("?");
    const method = opts.method || "GET";
    const params = new URLSearchParams(rawQs || "");
    if (method === "GET") {
      const rows = (tables[rawTable] || []).filter((row) => {
        for (const [k, v] of params.entries()) {
          if (["select", "order", "limit"].includes(k)) continue;
          if (v.startsWith("eq.")) {
            const expected = v.slice(3);
            if (k.includes(".")) {
              const [rel, col] = k.split(".");
              if (String(row[rel]?.[col]) !== expected) return false;
            } else if (String(row[k]) !== expected) {
              return false;
            }
          }
        }
        return true;
      });
      return rows;
    }
    if (method === "POST") {
      const row = { id: rawTable === "nh_sites" ? `site-${tables.nh_sites.length + 1}` : (tables[rawTable].length + 1), ...opts.body };
      tables[rawTable].push(row);
      return [row];
    }
    if (method === "PATCH") {
      const id = params.get("id")?.slice(3);
      const row = tables[rawTable].find((r) => String(r.id) === id);
      if (row) Object.assign(row, opts.body);
      return row ? [row] : [];
    }
    return [];
  };

  const routerApp = express();
  routerApp.use(express.json());
  routerApp.use("/api/liff", createLiffRouter({
    db: fakeDb,
    lineLoginChannelId: "2006551900",
    liffId: "2006551900-kncbuild",
    supabaseJwtSecret: "fixture-jwt-secret-at-least-16-chars",
    apiKey: "test-nh-api-key",
    founderLineId: validLineUserId,
    verifySignature: async () => ({ iss: "https://access.line.me", aud: "2006551900", exp: Math.floor(Date.now() / 1000) + 300, sub: validLineUserId }),
    proposeNote: async (content, category, proposer) => {
      const id = tables.jarvis_notes.length + 1;
      tables.jarvis_notes.push({ id, content, category, proposed_by: proposer, status: "pending" });
      return id;
    },
    notifyOwner: async (msg) => { ownerNotices.push(msg); },
  }));

  const srv = http.createServer(routerApp);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const base = `http://127.0.0.1:${srv.address().port}/api/liff`;

  const authResp = await fetch(`${base}/auth/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: "valid-line-token" }),
  });
  assert.equal(authResp.status, 200);
  const authData = await authResp.json();
  assert.equal(authData.ok, true);
  assert.equal(authData.tenant.client_account_id, 11);

  const siteResp = await fetch(`${base}/sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authData.supabaseToken}` },
    body: JSON.stringify({ ast: SAMPLE_AST, publish: true }),
  });
  assert.equal(siteResp.status, 201);
  const siteData = await siteResp.json();
  assert.equal(siteData.site.status, "published");
  assert.ok(siteData.flex && siteData.flex.type === "flex");

  const missingInq = await fetch(`${base}/inquiry`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site_slug: "nonexistent-site", customer_name: "Somchai", contact_phone: "0812345678" }),
  });
  assert.equal(missingInq.status, 404);

  const okInq = await fetch(`${base}/inquiry`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site_slug: SAMPLE_AST.siteSlug, customer_name: "Somchai", contact_phone: "0812345678", product_interest: "Tempered 10mm" }),
  });
  assert.equal(okInq.status, 201);
  assert.equal(tables.nh_site_inquiries.length, 1);

  const demoResp = await fetch(`${base}/demo-request`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nida", business: "Bangkok Glass", contact: "@bkkglass", industry: "glass", message: "Need Aria & Jarvis", consent: true }),
  });
  assert.equal(demoResp.status, 201);
  assert.equal(tables.support_cases.length, 1);
  assert.match(tables.support_cases[0].subject, /Website Demo: Bangkok Glass/);
  assert.equal(ownerNotices.length, 1);

  const unauthCfg = await fetch(`${base}/config-import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "aria", blocks: ["docs", "answer"] }),
  });
  assert.equal(unauthCfg.status, 401);

  const okCfg = await fetch(`${base}/config-import`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "test-nh-api-key" },
    body: JSON.stringify({ role: "aria", oa_name: "Bangkok Glass OA", industry: "glass", blocks: ["docs", "answer", "approval"] }),
  });
  assert.equal(okCfg.status, 202);
  const cfgData = await okCfg.json();
  assert.equal(cfgData.requires_jarvis_approval, true);
  assert.equal(tables.jarvis_notes.at(-1).status, "pending");

  const forgedUserMetaJwt = signHs256Jwt({
    aud: "authenticated",
    role: "authenticated",
    sub: "00000000-0000-4000-8000-000000000009",
    app_metadata: { provider: "email" },
    user_metadata: { client_account_id: 11, client_code: "KNC", line_user_id: validLineUserId },
    exp: Math.floor(Date.now() / 1000) + 600,
  }, "fixture-jwt-secret-at-least-16-chars");
  const forgedResp = await fetch(`${base}/sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${forgedUserMetaJwt}` },
    body: JSON.stringify({ ast: SAMPLE_AST, publish: false }),
  });
  assert.equal(forgedResp.status, 401);

  const badTypeResp = await fetch(`${base}/inquiry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site_slug: { toString: null }, customer_name: "Somchai", contact_phone: "0812345678" }),
  });
  assert.equal(badTypeResp.status, 400);

  tables.client_agent_bindings[0].client_accounts.active = false;
  const inactiveResp = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: "valid-line-token" }),
  });
  assert.equal(inactiveResp.status, 403);
});
