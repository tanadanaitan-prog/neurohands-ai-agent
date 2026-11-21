"use strict";

const { loadMenu } = require("./setup-richmenu");
const { inspectLineConsoleReadiness } = require("../src/lib/line-console");
const { supabaseHeaders } = require("../src/lib/security");

function createSupabaseSettingReader({ url = "", serviceKey = "" } = {}) {
  if (!url || !serviceKey) return async (_k, fallback) => fallback;
  return async (key, fallback) => {
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers: supabaseHeaders(serviceKey),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return fallback;
    const rows = await res.json();
    return rows?.[0]?.value ?? fallback;
  };
}

async function main() {
  loadMenu("public", { quiet: true });
  loadMenu("active", { quiet: true });

  const report = await inspectLineConsoleReadiness({
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET || "",
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
    lineLoginChannelId: process.env.LINE_LOGIN_CHANNEL_ID || "",
    liffId: process.env.LIFF_ID || "",
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || "",
    publicBase: process.env.PUBLIC_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://neurohands-ai-agent-production.up.railway.app"),
    getSettingFn: createSupabaseSettingReader({
      url: process.env.SUPABASE_URL || "",
      serviceKey: process.env.SUPABASE_SERVICE_KEY || "",
    }),
  });

  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--strict") && (!report.readyForMessaging || !report.defaultRichMenu.matchesSettings)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
