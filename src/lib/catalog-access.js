"use strict";

const { isFreshRecord } = require("./document-parser");

// The inspected legacy tables may not yet have a row-level owner column. Never pretend
// a filter on a nonexistent column provides isolation, or infer that rates are public.
const MAX_ACCOUNT_ID = 9223372036854775807n;
function accountId(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value);
  return /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= MAX_ACCOUNT_ID ? id : null;
}

function pickPublicFields(row, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(row, key)) out[key] = row[key];
  }
  return out;
}

function createLegacyCatalogAccess({ db, ownerAccountId } = {}) {
  if (typeof db !== "function") throw new TypeError("Catalog database reader is required");
  const ownerId = accountId(ownerAccountId);
  const denied = (key) => ({ found: false, [key]: [], error: "Catalog is not available for this client account." });

  async function authorized(ctx) {
    if (!ownerId || accountId(ctx?.clientAccountId) !== ownerId ||
        typeof ctx?.lineUserId !== "string" || !ctx.lineUserId.trim()) return false;
    const accounts = await db(`client_accounts?id=eq.${ownerId}&active=eq.true&select=id,active&limit=1`);
    if (!Array.isArray(accounts)) throw new Error("Catalog owner lookup was not confirmed");
    return accounts.length === 1 && accountId(accounts[0]?.id) === ownerId && accounts[0]?.active === true;
  }

  async function read(ctx, key, query, publicKeys) {
    if (!await authorized(ctx)) return denied(key);
    const rows = await db(query);
    if (!Array.isArray(rows)) throw new Error("Catalog read was not confirmed");
    const filtered = rows
      .filter((row) => (row?.client_account_id == null || accountId(row.client_account_id) === accountId(ctx.clientAccountId)) && isFreshRecord(row))
      .map((row) => pickPublicFields(row, publicKeys));
    return { found: filtered.length > 0, [key]: filtered };
  }

  return Object.freeze({
    async products(ctx, args = {}, limit = 100) {
      const boundedLimit = limit === 30 ? 30 : 100;
      const result = await read(ctx, "products", `glass_types?active=eq.true&order=product_code&limit=${boundedLimit}`, ["product_code", "glass_name", "thickness_mm", "price_per_sqft"]);
      if (result.error) return result;
      const q = String(args?.query || "").toLowerCase().trim();
      const products = q ? result.products.filter((row) =>
        String(row.product_code || "").toLowerCase().includes(q) || String(row.glass_name || "").toLowerCase().includes(q)) : result.products;
      return { found: products.length > 0, products };
    },
    async edging(ctx, limit = 100) {
      const boundedLimit = limit === 20 ? 20 : 100;
      return read(ctx, "services", `edging_services?active=eq.true&limit=${boundedLimit}`, ["service_code", "service_name", "price_per_sqft", "price_rule"]);
    },
  });
}

module.exports = { createLegacyCatalogAccess };
