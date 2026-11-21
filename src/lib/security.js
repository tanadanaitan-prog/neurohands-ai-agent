const crypto = require("node:crypto");

function equalSecret(expected, supplied) {
  if (typeof expected !== "string" || !expected || typeof supplied !== "string" || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function supabaseHeaders(key) {
  if (!key) throw new Error("SUPABASE_SERVICE_KEY is required");
  // Supabase rejects opaque sb_secret_ keys in Authorization: Bearer (JWT-only); legacy service_role JWTs still require Bearer.
  return key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

function extractApiKey(req) {
  const direct = req?.headers?.["x-api-key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const auth = req?.headers?.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

module.exports = { equalSecret, supabaseHeaders, extractApiKey };
