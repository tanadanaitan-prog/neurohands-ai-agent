const crypto = require("node:crypto");

function equalSecret(expected, supplied) {
  if (typeof expected !== "string" || !expected || typeof supplied !== "string" || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function supabaseHeaders(key) {
  if (!key) throw new Error("SUPABASE_SERVICE_KEY is required");
  // Opaque secret keys are not JWTs. Keep legacy service_role JWT support.
  return key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

module.exports = { equalSecret, supabaseHeaders };
