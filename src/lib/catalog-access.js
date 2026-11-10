"use strict";

// The inspected legacy tables have no row-level owner column. Never pretend a
// filter on a nonexistent column provides isolation, or infer that rates are public.
const MAX_ACCOUNT_ID = 9223372036854775807n;
function accountId(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value);
  return /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= MAX_ACCOUNT_ID ? id : null;
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

  async function read(ctx, key, query) {
    if (!await authorized(ctx)) return denied(key);
    const rows = await db(query);
    if (!Array.isArray(rows)) throw new Error("Catalog read was not confirmed");
    return { found: rows.length > 0, [key]: rows };
  }

  return Object.freeze({
    async products(ctx, args = {}, limit = 100) {
      const boundedLimit = limit === 30 ? 30 : 100;
      const result = await read(ctx, "products", `glass_types?active=eq.true&select=product_code,glass_name,thickness_mm,price_per_sqft&order=product_code&limit=${boundedLimit}`);
      if (result.error) return result;
      const q = String(args?.query || "").toLowerCase().trim();
      const products = q ? result.products.filter((row) =>
        String(row.product_code || "").toLowerCase().includes(q) || String(row.glass_name || "").toLowerCase().includes(q)) : result.products;
      return { found: products.length > 0, products };
    },
    async edging(ctx, limit = 100) {
      const boundedLimit = limit === 20 ? 20 : 100;
      return read(ctx, "services", `edging_services?active=eq.true&select=service_code,service_name,price_per_sqft,price_rule&limit=${boundedLimit}`);
    },
  });
}

module.exports = { createLegacyCatalogAccess };
