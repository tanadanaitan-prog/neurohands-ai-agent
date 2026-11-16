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
const { isValidRichMenuAction, loadMenu, NEUROHANDS_PREVIEW_URL } = require("../scripts/setup-richmenu");
const { BRAND_COPY, DEFAULT_PUBLIC_UPDATES, normalizeGeminiModelName } = require("../src/server");

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

test("Rich Menu validator and BRAND_COPY connect Neurohands Prototype v2 URI and hybrid private-hardware architecture", () => {
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
    isValidRichMenuAction({ type: "uri", uri: "https://tanadanaitan-prog.github.io/neurohands-preview/#builder" }),
    true
  );
  assert.equal(isValidRichMenuAction({ type: "uri", uri: "http://liff.line.me/insecure" }), false);
  assert.equal(isValidRichMenuAction({ type: "uri", uri: "https://evil.example.com/phish" }), false);
  const publicMenu = loadMenu("public").menu;
  assert.ok(publicMenu.areas.length > 0);
  assert.ok(
    publicMenu.areas.some((area) => area.action?.type === "uri" && area.action?.uri === NEUROHANDS_PREVIEW_URL),
    "Public Rich Menu must include a URI action pointing to https://tanadanaitan-prog.github.io/neurohands-preview/"
  );
  assert.ok(loadMenu("active").menu.areas.length > 0);
  for (const key of ["about", "services", "projects", "activate"]) {
    assert.ok(BRAND_COPY[key].includes(NEUROHANDS_PREVIEW_URL), `BRAND_COPY.${key} must link to ${NEUROHANDS_PREVIEW_URL}`);
  }
  assert.match(BRAND_COPY.about, /private hardware/i);
  assert.match(BRAND_COPY.about, /encrypted backup/i);
  assert.ok(DEFAULT_PUBLIC_UPDATES.includes(NEUROHANDS_PREVIEW_URL));
  assert.match(DEFAULT_PUBLIC_UPDATES, /private hardware/i);
  assert.equal(normalizeGeminiModelName("gemini-3.6-flash"), "gemini-2.5-flash");
  assert.equal(normalizeGeminiModelName("gemini-2.5-flash"), "gemini-2.5-flash");
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
