"use strict";

const crypto = require("node:crypto");
const express = require("express");
const {
  validateSiteAst,
  compileSiteHtml,
  buildLineProposalFlexMessage,
  verifyLiffIdTokenAndMintJwt,
} = require("./liff-builder");
const { equalSecret, extractApiKey } = require("./security");
const { buildCustomRichMenuPayload } = require("./line-console");

const ALLOWED_INDUSTRIES = new Set(["glass", "materials", "auto", "shop", "other"]);
const ALLOWED_ROLES = new Set(["concierge", "aria", "jarvis", "suri", "mira"]);
const ALLOWED_BLOCKS = new Set([
  "docs", "catalog", "faq", "prices", "answer", "quote", "order",
  "booking", "leads", "handoff", "summary", "friendly", "formal",
  "lang_th", "lang_en", "lang_both", "emoji_none", "emoji_some",
  "emoji_lots", "approval", "hours", "pdpa",
]);

class LiffHttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanText(value, field, { min = 1, max = 300, required = true } = {}) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (!required) return null;
    throw new LiffHttpError(400, `${field} is required`);
  }
  if (typeof value !== "string") throw new LiffHttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new LiffHttpError(400, `${field} must be between ${min} and ${max} characters`);
  }
  return trimmed;
}

function base64UrlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signHs256Jwt(payload, secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("SUPABASE_JWT_SECRET must be at least 16 characters");
  }
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const claims = base64UrlJson(payload);
  const body = `${header}.${claims}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyHs256Jwt(token, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length > 8192 || typeof secret !== "string" || secret.length < 16) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null;
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!equalSecret(expected, s)) return null;
  if (!Number.isInteger(claims?.exp) || claims.exp <= nowSec) return null;
  return claims;
}

async function verifyLineJwksIdToken(idToken, { fetchImpl = globalThis.fetch, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof idToken !== "string" || idToken.length > 8192) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!header?.kid || !["ES256", "RS256"].includes(header.alg)) return null;
  if (claims?.iss !== "https://access.line.me" || !Number.isInteger(claims?.exp) || claims.exp <= nowSec) {
    return null;
  }
  const resp = await fetchImpl("https://api.line.me/oauth2/v2.1/certs", {
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return null;
  const jwks = await resp.json();
  const jwk = Array.isArray(jwks?.keys) ? jwks.keys.find((k) => k.kid === header.kid) : null;
  if (!jwk || (jwk.alg && jwk.alg !== header.alg)) return null;
  try {
    const keyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], "base64url");
    const alg = header.alg === "ES256" ? "sha256" : "RSA-SHA256";
    // RFC 7515 JWS ES256 signatures from LINE JWKS use raw (r, s) ieee-p1363 encoding rather than ASN.1 DER.
    const ok = header.alg === "ES256"
      ? crypto.verify(alg, signingInput, { key: keyObj, dsaEncoding: "ieee-p1363" }, signature)
      : crypto.verify(alg, signingInput, keyObj, signature);
    return ok ? claims : null;
  } catch {
    return null;
  }
}

function createLiffRouter({
  db,
  lineLoginChannelId = "",
  liffId = "",
  supabaseJwtSecret = "",
  apiKey = "",
  founderLineId = "",
  websiteUrl = "https://neurohands-ai-agent-production.up.railway.app/neurohands",
  verifySignature = null,
  signSupabaseJwt = null,
  proposeNote = null,
  notifyOwner = null,
} = {}) {
  if (typeof db !== "function") throw new TypeError("db reader/writer function is required");
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.get("/config", (_req, res) => {
    const cleanUrl = String(websiteUrl || "https://neurohands-ai-agent-production.up.railway.app/neurohands").trim();
    const jwtReady = typeof supabaseJwtSecret === "string" && supabaseJwtSecret.length >= 16;
    const liffEnabled = Boolean(lineLoginChannelId && liffId && jwtReady);
    res.json({
      ok: true,
      liffEnabled,
      liffId: liffEnabled ? liffId : null,
      websiteUrl: cleanUrl,
      architecture: "hybrid_private_hardware_with_cloud_routing_and_backup",
    });
  });

  const resolvedVerifier = verifySignature || ((token) => verifyLineJwksIdToken(token));
  const resolvedSigner = signSupabaseJwt || (supabaseJwtSecret ? (payload) => signHs256Jwt(payload, supabaseJwtSecret) : null);

  function requireTenant(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer (\S+)$/);
    if (!match || !supabaseJwtSecret) throw new LiffHttpError(401, "Valid builder session token is required");
    const claims = verifyHs256Jwt(match[1], supabaseJwtSecret);
    // Supabase Auth lets users mutate user_metadata via auth.updateUser(); trust only server-signed app_metadata.
    const appMeta = claims?.app_metadata;
    if (
      !claims
      || claims.aud !== "authenticated"
      || claims.role !== "authenticated"
      || appMeta?.provider !== "line"
      || !Number.isInteger(appMeta?.client_account_id)
      || typeof appMeta?.line_user_id !== "string"
      || claims.sub !== `line:${appMeta.line_user_id}`
    ) {
      throw new LiffHttpError(401, "Invalid or expired builder session");
    }
    return {
      clientAccountId: appMeta.client_account_id,
      clientCode: appMeta.client_code || "CLIENT",
      lineUserId: appMeta.line_user_id,
    };
  }

  router.post("/auth/verify", route(async (req, res) => {
    const idToken = req.body?.idToken;
    if (!lineLoginChannelId || !resolvedSigner) {
      return res.status(503).json({ error: "LIFF authentication is not configured", code: "LIFF_AUTH_UNCONFIGURED" });
    }
    const result = await verifyLiffIdTokenAndMintJwt({
      idToken,
      channelId: lineLoginChannelId,
      verifySignature: resolvedVerifier,
      resolveBinding: async (lineUserId) => {
        const rows = await db(
          `client_agent_bindings?line_user_id=eq.${encodeURIComponent(lineUserId)}&status=eq.active&select=client_account_id,department,status,client_accounts!inner(client_code,active)&client_accounts.active=eq.true&order=activated_at.desc&limit=1`
        );
        const row = rows?.[0];
        if (!row) return null;
        return {
          client_account_id: row.client_account_id,
          client_code: row.client_accounts?.client_code || "CLIENT",
          role: "staff",
          active: row.status === "active" && row.client_accounts?.active === true,
        };
      },
      signSupabaseJwt: resolvedSigner,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.code, code: result.code });
    }
    return res.json({
      ok: true,
      supabaseToken: result.supabaseToken,
      expiresAt: result.expiresAt,
      tenant: result.claims.app_metadata,
    });
  }));

  router.post("/sites", route(async (req, res) => {
    const tenant = requireTenant(req);
    const ast = req.body?.ast;
    const check = validateSiteAst(ast);
    if (!check.valid) return res.status(400).json({ error: "Invalid site definition", details: check.errors });
    const publish = req.body?.publish === true;
    const metaDescription = cleanText(req.body?.metaDescription, "metaDescription", { min: 1, max: 300, required: false });
    const html = publish ? compileSiteHtml(ast, { clientCode: tenant.clientCode }) : null;
    const existing = (await db(`nh_sites?site_slug=eq.${encodeURIComponent(ast.siteSlug)}&select=id,client_account_id&limit=1`))?.[0];
    if (existing && Number(existing.client_account_id) !== tenant.clientAccountId) {
      return res.status(409).json({ error: "This site address is already claimed by another business" });
    }
    const record = {
      client_account_id: tenant.clientAccountId,
      created_by_line_user_id: tenant.lineUserId,
      site_slug: ast.siteSlug,
      title: ast.title,
      meta_description: metaDescription,
      status: publish ? "published" : "draft",
      theme_config: ast.theme,
      draft_blocks: ast.blocks,
      ...(publish ? { published_blocks: ast.blocks, published_html: html, published_at: new Date().toISOString() } : {}),
    };
    const saved = existing
      ? await db(`nh_sites?id=eq.${encodeURIComponent(existing.id)}&client_account_id=eq.${tenant.clientAccountId}`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: record,
      })
      : await db("nh_sites", { method: "POST", headers: { Prefer: "return=representation" }, body: record });
    const site = saved?.[0];
    if (!site?.id) throw new Error("Site persistence was not confirmed");
    const liveUrl = `https://${String(tenant.clientCode).toLowerCase()}-${ast.siteSlug}.neurohands.site`;
    const flex = publish && liffId ? buildLineProposalFlexMessage(ast, { liveUrl, liffId }) : null;
    return res.status(existing ? 200 : 201).json({ ok: true, site, liveUrl, flex });
  }));

  router.post("/inquiry", route(async (req, res) => {
    const siteSlug = cleanText(req.body?.site_slug, "site_slug", { min: 3, max: 63 });
    if (!/^[a-z0-9-]{3,63}$/.test(siteSlug)) throw new LiffHttpError(400, "Invalid site_slug format");
    const customerName = cleanText(req.body?.customer_name, "customer_name", { min: 1, max: 120 });
    const contactPhone = cleanText(req.body?.contact_phone, "contact_phone", { min: 6, max: 40 });
    const contactEmail = cleanText(req.body?.contact_email, "contact_email", { min: 3, max: 120, required: false });
    const productInterest = cleanText(req.body?.product_interest, "product_interest", { min: 1, max: 200, required: false });
    const rawSpecs = req.body?.specifications ?? {};
    if (typeof rawSpecs !== "object" || rawSpecs === null || Array.isArray(rawSpecs) || JSON.stringify(rawSpecs).length > 4096) {
      throw new LiffHttpError(400, "specifications must be a bounded JSON object");
    }
    const site = (await db(`nh_sites?site_slug=eq.${encodeURIComponent(siteSlug)}&status=eq.published&select=id,client_account_id,title&limit=1`))?.[0];
    if (!site) return res.status(404).json({ error: "Published site not found" });
    const rows = await db("nh_site_inquiries", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        site_id: site.id,
        client_account_id: site.client_account_id,
        customer_name: customerName,
        contact_phone: contactPhone,
        contact_email: contactEmail,
        product_interest: productInterest,
        specifications: rawSpecs,
      },
    });
    if (!rows?.[0]?.id) throw new Error("Inquiry could not be saved");
    return res.status(201).json({ ok: true, inquiry_id: rows[0].id });
  }));

  router.post("/demo-request", route(async (req, res) => {
    if (req.body?.consent !== true) throw new LiffHttpError(400, "Consent is required");
    const name = cleanText(req.body?.name, "name", { min: 2, max: 120 });
    const business = cleanText(req.body?.business, "business", { min: 2, max: 160 });
    const contact = cleanText(req.body?.contact, "contact", { min: 3, max: 80 });
    const industry = cleanText(req.body?.industry, "industry", { min: 2, max: 30 });
    if (!ALLOWED_INDUSTRIES.has(industry)) throw new LiffHttpError(400, "Unsupported industry selection");
    const message = cleanText(req.body?.message, "message", { min: 1, max: 1000, required: false });
    const detail = [
      `Contact: ${name} (${contact})`,
      `Business: ${business} [${industry}]`,
      message ? `Notes: ${message}` : null,
      "Source: Neurohands interactive website (#demo)",
    ].filter(Boolean).join(" | ");
    const created = await db("support_cases", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        client_account_id: null,
        line_user_id: null,
        department: "sales",
        subject: `Website Demo: ${business}`.slice(0, 300),
        detail: detail.slice(0, 3000),
        urgency: "normal",
        status: "open",
      },
    });
    const caseId = created?.[0]?.id || null;
    if (!caseId) throw new Error("Demo request persistence could not be confirmed");
    if (typeof notifyOwner === "function") {
      try { await notifyOwner(`🧩 New website demo request (#${caseId}): ${business} — ${name} (${contact})`); }
      catch { /* Non-fatal owner notification failure must not hide the saved case. */ }
    }
    return res.status(201).json({ ok: true, case_id: caseId });
  }));

  router.post("/config-import", route(async (req, res) => {
    if (!equalSecret(apiKey, extractApiKey(req))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (typeof proposeNote !== "function") {
      return res.status(503).json({ error: "Proposal approval gate is unavailable" });
    }
    const role = cleanText(req.body?.role, "role", { min: 2, max: 30 });
    if (!ALLOWED_ROLES.has(role)) throw new LiffHttpError(400, "Unsupported agent role");
    const rawBlocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const blocks = [...new Set(rawBlocks.filter((b) => typeof b === "string" && ALLOWED_BLOCKS.has(b)))].slice(0, 25);
    const oaName = cleanText(req.body?.oa_name, "oa_name", { min: 1, max: 120, required: false }) || "Custom OA";
    const industry = cleanText(req.body?.industry, "industry", { min: 2, max: 30, required: false }) || "glass";
    if (!ALLOWED_INDUSTRIES.has(industry)) throw new LiffHttpError(400, "Unsupported industry");
    const proposer = founderLineId || cleanText(req.body?.operator_line_user_id, "operator_line_user_id", { min: 5, max: 128 });
    const summary = `Onboard Neurohands agent for ${oaName} (${industry}): role=${role}, modules=[${blocks.join(", ")}]`;
    const proposalId = await proposeNote(summary, "general", proposer);
    return res.status(202).json({
      ok: true,
      proposal_id: proposalId,
      requires_jarvis_approval: true,
      summary,
    });
  }));

  router.post("/richmenu-publish", route(async (req, res) => {
    const hasApiKey = Boolean(apiKey && equalSecret(apiKey, extractApiKey(req)));
    const tenant = hasApiKey ? null : requireTenant(req);
    if (typeof proposeNote !== "function") {
      return res.status(503).json({ error: "Proposal approval gate is unavailable" });
    }
    const proposer = founderLineId || (!tenant ? cleanText(req.body?.operator_line_user_id, "operator_line_user_id", { min: 5, max: 128 }) : null);
    if (!proposer) {
      return res.status(503).json({ error: "Founder operator ID is required to approve Rich Menu proposals" });
    }
    let menuPayload;
    try {
      menuPayload = buildCustomRichMenuPayload({
        name: req.body?.name || `${tenant?.clientCode || "Neurohands"} Rich Menu`,
        chatBarText: req.body?.chatBarText || "Neurohands",
        buttons: req.body?.buttons,
        allowedLiffId: liffId,
        allowedClientCode: tenant?.clientCode || "",
      });
    } catch (err) {
      throw new LiffHttpError(400, err.message);
    }
    const compactButtons = menuPayload.areas.map((a, idx) => {
      const target = a.action.type === "uri" ? a.action.uri.slice(0, 120) : a.action.data;
      return `${idx + 1}:${target}`;
    }).join(" | ");
    const summary = `Publish Rich Menu '${menuPayload.name}' (${tenant?.clientCode || "admin"}): ${compactButtons}`.slice(0, 980);
    const toolArgs = {
      menuPayload,
      targetLineUserId: tenant?.lineUserId || cleanText(req.body?.target_line_user_id, "target_line_user_id", { min: 5, max: 128, required: false }),
    };
    const proposalId = await proposeNote(summary, "general", proposer, "publish_rich_menu", toolArgs, tenant?.clientAccountId ?? null, "operations");
    return res.status(202).json({
      ok: true,
      proposal_id: proposalId,
      requires_jarvis_approval: true,
      menuPayload,
    });
  }));

  router.use((error, _req, res, _next) => {
    if (error instanceof LiffHttpError) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    console.error("LIFF router error:", error?.name || "Error");
    return res.status(503).json({ error: "Request could not be verified" });
  });

  return router;
}

module.exports = {
  createLiffRouter,
  signHs256Jwt,
  verifyHs256Jwt,
  verifyLineJwksIdToken,
};
