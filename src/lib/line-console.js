"use strict";

const express = require("express");
const { loadMenu, isValidRichMenuAction, NEUROHANDS_PREVIEW_URL } = require("../../scripts/setup-richmenu");
const { equalSecret, extractApiKey } = require("./security");

const DEFAULT_WIDTH = 2500;
const DEFAULT_HEIGHT = 1686;
const TENANT_SITE_URI_RE = /^https:\/\/([a-z0-9-]+)\.neurohands\.site(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?$/;

const DEFAULT_SLOTS = Object.freeze([
  { x: 64, y: 290, width: 764, height: 640 },
  { x: 868, y: 290, width: 764, height: 640 },
  { x: 1672, y: 290, width: 764, height: 640 },
  { x: 64, y: 970, width: 764, height: 640 },
  { x: 868, y: 970, width: 764, height: 640 },
  { x: 1672, y: 970, width: 764, height: 640 },
]);

function isAllowedTenantMenuAction(action, { allowedLiffId = "", allowedClientCode = "" } = {}) {
  if (!action || typeof action !== "object") return false;
  if (action.type === "postback") return isValidRichMenuAction(action);
  if (action.type !== "uri" || typeof action.uri !== "string" || !action.uri.trim() || action.uri.length > 512) {
    return false;
  }
  let parsed;
  try { parsed = new URL(action.uri); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(parsed.pathname)) {
    return false;
  }
  if (parsed.hostname === "liff.line.me") {
    return Boolean(allowedLiffId) && (parsed.pathname === `/${allowedLiffId}` || parsed.pathname.startsWith(`/${allowedLiffId}/`));
  }
  const siteMatch = action.uri.match(TENANT_SITE_URI_RE);
  if (siteMatch) {
    const slug = siteMatch[1];
    if (slug.length < 2 || slug.length > 80) return false;
    if (!allowedClientCode) return slug.length >= 3;
    const code = String(allowedClientCode).trim().toLowerCase();
    return Boolean(code) && (slug === code || (slug.startsWith(`${code}-`) && slug.length > code.length + 1));
  }
  return isValidRichMenuAction(action, { allowedLiffId });
}

function buildCustomRichMenuPayload({
  name = "Neurohands Custom Menu",
  chatBarText = "Neurohands",
  buttons,
  allowedLiffId = "",
  allowedClientCode = "",
} = {}) {
  const cleanName = typeof name === "string" ? name.trim().slice(0, 60) : "";
  const cleanBar = typeof chatBarText === "string" ? chatBarText.trim().slice(0, 14) : "";
  if (!cleanName || !cleanBar) throw new RangeError("name and chatBarText are required");
  if (!Array.isArray(buttons) || buttons.length !== 6) {
    throw new RangeError("Exactly 6 Rich Menu button definitions are required");
  }

  const areas = buttons.map((btn, idx) => {
    if (!btn || typeof btn !== "object" || Array.isArray(btn)) {
      throw new RangeError(`Button ${idx + 1} must be an object`);
    }
    let action;
    if (btn.type === "uri") {
      if (typeof btn.uri !== "string" || !btn.uri.trim()) {
        throw new RangeError(`Button ${idx + 1} URI is required`);
      }
      action = { type: "uri", uri: btn.uri.trim() };
    } else {
      action = { type: "postback", data: typeof btn.data === "string" ? btn.data.trim() : "" };
    }
    if (!isAllowedTenantMenuAction(action, { allowedLiffId, allowedClientCode })) {
      throw new RangeError(`Button ${idx + 1} action is invalid or uses an untrusted URI`);
    }
    const bounds = btn.bounds || DEFAULT_SLOTS[idx];
    const { x, y, width, height } = bounds || {};
    if (
      ![x, y, width, height].every(Number.isInteger)
      || x < 0 || y < 0 || width <= 0 || height <= 0
      || x + width > DEFAULT_WIDTH || y + height > DEFAULT_HEIGHT
    ) {
      throw new RangeError(`Button ${idx + 1} bounds exceed ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}`);
    }
    return { bounds: { x, y, width, height }, action };
  });

  return {
    size: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
    selected: true,
    name: cleanName,
    chatBarText: cleanBar,
    areas,
  };
}

async function lineJsonRequest(url, token, options = {}, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE API rejected (${res.status})`);
  return text ? JSON.parse(text) : {};
}

async function deleteRichMenuQuietly(token, richMenuId, fetchImpl = globalThis.fetch) {
  if (!token || !richMenuId) return;
  try {
    await fetchImpl(`https://api.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function uploadSingleMenu({ token, menu, image }, fetchImpl = globalThis.fetch) {
  const created = await lineJsonRequest("https://api.line.me/v2/bot/richmenu", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(menu),
  }, fetchImpl);
  const richMenuId = created?.richMenuId;
  if (typeof richMenuId !== "string" || !richMenuId) {
    throw new Error("LINE API did not return a richMenuId");
  }
  try {
    const uploadRes = await fetchImpl(`https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
      body: image,
      signal: AbortSignal.timeout(15000),
    });
    if (!uploadRes.ok) throw new Error(`LINE Rich Menu image upload rejected (${uploadRes.status})`);
    return richMenuId;
  } catch (err) {
    // Delete the JSON shell whenever PNG upload throws or fails so orphan menus do not accumulate against LINE's quota.
    await deleteRichMenuQuietly(token, richMenuId, fetchImpl);
    throw err;
  }
}

async function syncDefaultRichMenus({
  lineChannelAccessToken = "",
  getSettingFn = null,
  saveSettingFn,
  loadMenuFn = loadMenu,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!lineChannelAccessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
  if (typeof saveSettingFn !== "function") throw new Error("saveSettingFn is required");

  let prevPublicId = null;
  let prevActiveId = null;
  if (typeof getSettingFn === "function") {
    try {
      prevPublicId = await getSettingFn("richmenu_public_id", null);
      prevActiveId = await getSettingFn("richmenu_active_id", null);
    } catch {}
  }

  const publicMenu = loadMenuFn("public", { quiet: true });
  const activeMenu = loadMenuFn("active", { quiet: true });

  const createdIds = [];
  try {
    const publicId = await uploadSingleMenu({ token: lineChannelAccessToken, ...publicMenu }, fetchImpl);
    createdIds.push(publicId);
    const activeId = await uploadSingleMenu({ token: lineChannelAccessToken, ...activeMenu }, fetchImpl);
    createdIds.push(activeId);

    await lineJsonRequest(`https://api.line.me/v2/bot/user/all/richmenu/${encodeURIComponent(publicId)}`, lineChannelAccessToken, {
      method: "POST",
    }, fetchImpl);
    await saveSettingFn("richmenu_public_id", publicId);
    await saveSettingFn("richmenu_active_id", activeId);

    for (const oldId of [prevPublicId, prevActiveId]) {
      if (oldId && oldId !== publicId && oldId !== activeId) {
        await deleteRichMenuQuietly(lineChannelAccessToken, oldId, fetchImpl);
      }
    }
    return { ok: true, richmenuPublicId: publicId, richmenuActiveId: activeId, linkedDefault: true };
  } catch (err) {
    for (const createdId of createdIds) {
      await deleteRichMenuQuietly(lineChannelAccessToken, createdId, fetchImpl);
    }
    if (prevPublicId) {
      try {
        await lineJsonRequest(`https://api.line.me/v2/bot/user/all/richmenu/${encodeURIComponent(prevPublicId)}`, lineChannelAccessToken, {
          method: "POST",
        }, fetchImpl);
      } catch {}
    }
    throw err;
  }
}

async function publishTenantCustomRichMenu({
  lineChannelAccessToken = "",
  menuPayload,
  targetLineUserId = null,
  linkUserFn = null,
  loadMenuFn = loadMenu,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!lineChannelAccessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
  const { image } = loadMenuFn("active", { quiet: true });
  const richMenuId = await uploadSingleMenu({ token: lineChannelAccessToken, menu: menuPayload, image }, fetchImpl);
  try {
    if (targetLineUserId) {
      if (typeof linkUserFn === "function") await linkUserFn(targetLineUserId, richMenuId);
      else await lineJsonRequest(`https://api.line.me/v2/bot/user/${encodeURIComponent(targetLineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`, lineChannelAccessToken, { method: "POST" }, fetchImpl);
    }
    return { ok: true, richMenuId, linkedUser: Boolean(targetLineUserId) };
  } catch (err) {
    await deleteRichMenuQuietly(lineChannelAccessToken, richMenuId, fetchImpl);
    throw err;
  }
}

async function inspectLineConsoleReadiness({
  lineChannelSecret = "",
  lineChannelAccessToken = "",
  lineLoginChannelId = "",
  liffId = "",
  supabaseJwtSecret = "",
  publicBase = "",
  getSettingFn = async (_k, fallback) => fallback,
  fetchImpl = globalThis.fetch,
} = {}) {
  const baseUrl = String(publicBase || "https://neurohands-ai-agent-production.up.railway.app").replace(/\/+$/, "");
  const expectedWebhookUrl = `${baseUrl}/webhook`;
  const expectedWebsiteUrl = `${baseUrl}/neurohands`;
  const expectedStudioUrl = `${baseUrl}/studio/`;

  const messagingConfigured = Boolean(lineChannelSecret && lineChannelAccessToken);
  const liffConfigured = Boolean(lineLoginChannelId && liffId && typeof supabaseJwtSecret === "string" && supabaseJwtSecret.length >= 16);

  let storedPublicMenuId = null;
  let storedActiveMenuId = null;
  try {
    storedPublicMenuId = await getSettingFn("richmenu_public_id", null);
    storedActiveMenuId = await getSettingFn("richmenu_active_id", null);
  } catch {}

  let bot = { reachable: false };
  let webhook = { verified: false, endpoint: null, active: false, matchesExpected: false };
  let defaultRichMenu = { linked: false, richMenuId: null, matchesSettings: false };

  if (lineChannelAccessToken) {
    try {
      const info = await lineJsonRequest("https://api.line.me/v2/bot/info", lineChannelAccessToken, {}, fetchImpl);
      bot = { reachable: true, basicId: info.basicId || null, displayName: info.displayName || null };
    } catch (err) {
      bot = { reachable: false, error: err.message };
    }
    try {
      const ep = await lineJsonRequest("https://api.line.me/v2/bot/channel/webhook/endpoint", lineChannelAccessToken, {}, fetchImpl);
      webhook = {
        verified: true,
        endpoint: ep.endpoint || null,
        active: ep.active === true,
        matchesExpected: ep.endpoint === expectedWebhookUrl && ep.active === true,
      };
    } catch (err) {
      webhook = { verified: false, endpoint: null, active: false, matchesExpected: false, error: err.message };
    }
    try {
      const rm = await lineJsonRequest("https://api.line.me/v2/bot/user/all/richmenu", lineChannelAccessToken, {}, fetchImpl);
      const liveId = rm.richMenuId || null;
      defaultRichMenu = {
        linked: Boolean(liveId),
        richMenuId: liveId,
        matchesSettings: Boolean(liveId && storedPublicMenuId && liveId === storedPublicMenuId),
      };
    } catch (err) {
      defaultRichMenu = { linked: false, richMenuId: null, matchesSettings: false, error: err.message };
    }
  }

  const consoleActions = [];
  if (!messagingConfigured) consoleActions.push("Set LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN in Railway from LINE Developers Messaging API channel.");
  if (!webhook.matchesExpected) consoleActions.push(`In LINE Developers Console -> Messaging API -> Webhook URL, set ${expectedWebhookUrl} and enable "Use webhook".`);
  if (!defaultRichMenu.matchesSettings) consoleActions.push("Run POST /api/line/richmenu-sync (or npm run richmenu:setup) to upload and link the /neurohands public Rich Menu.");
  if (!liffConfigured) consoleActions.push(`Create a LINE Login channel + LIFF app (Endpoint URL: ${expectedWebsiteUrl}) in LINE Developers Console and set LINE_LOGIN_CHANNEL_ID, LIFF_ID, and SUPABASE_JWT_SECRET in Railway.`);

  return {
    readyForMessaging: Boolean(messagingConfigured && bot.reachable && webhook.matchesExpected),
    readyForLiff: liffConfigured,
    urls: {
      webhookUrl: expectedWebhookUrl,
      websiteUrl: expectedWebsiteUrl,
      studioUrl: expectedStudioUrl,
    },
    credentials: {
      channelSecretSet: Boolean(lineChannelSecret),
      channelAccessTokenSet: Boolean(lineChannelAccessToken),
      lineLoginChannelIdSet: Boolean(lineLoginChannelId),
      liffIdSet: Boolean(liffId),
      supabaseJwtSecretSet: Boolean(supabaseJwtSecret && supabaseJwtSecret.length >= 16),
    },
    bot,
    webhook,
    defaultRichMenu: {
      ...defaultRichMenu,
      storedPublicMenuId,
      storedActiveMenuId,
    },
    consoleActions,
  };
}

function createLineAdminRouter({
  apiKey = "",
  lineChannelSecret = "",
  lineChannelAccessToken = "",
  lineLoginChannelId = "",
  liffId = "",
  supabaseJwtSecret = "",
  publicBase = "",
  getSettingFn,
  saveSettingFn,
  loadMenuFn = loadMenu,
  fetchImpl = globalThis.fetch,
} = {}) {
  const router = express.Router();
  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!apiKey) return res.status(503).json({ error: "LINE admin API key is not configured" });
    if (!equalSecret(apiKey, extractApiKey(req))) return res.status(401).json({ error: "Unauthorized" });
    next();
  });

  router.get("/readiness", route(async (_req, res) => {
    const report = await inspectLineConsoleReadiness({
      lineChannelSecret,
      lineChannelAccessToken,
      lineLoginChannelId,
      liffId,
      supabaseJwtSecret,
      publicBase,
      getSettingFn,
      fetchImpl,
    });
    res.json(report);
  }));

  router.post("/richmenu-sync", route(async (_req, res) => {
    if (!lineChannelAccessToken) {
      return res.status(503).json({ error: "LINE_CHANNEL_ACCESS_TOKEN is not configured" });
    }
    const synced = await syncDefaultRichMenus({
      lineChannelAccessToken,
      getSettingFn,
      saveSettingFn,
      loadMenuFn,
      fetchImpl,
    });
    res.status(200).json(synced);
  }));

  router.use((err, _req, res, _next) => {
    const safeMsg = typeof err?.message === "string" && err.message.startsWith("LINE ") ? err.message : "LINE administrative operation failed";
    console.error("LINE admin route error:", safeMsg);
    return res.status(502).json({ error: safeMsg });
  });

  return router;
}

module.exports = {
  buildCustomRichMenuPayload,
  syncDefaultRichMenus,
  publishTenantCustomRichMenu,
  inspectLineConsoleReadiness,
  createLineAdminRouter,
};
