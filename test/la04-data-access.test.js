"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLegacyCatalogAccess } = require("../src/lib/catalog-access");

const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const product = { product_code: "PRIVATE-GLASS", glass_name: "Owner rates", price_per_sqft: 99 };
const edging = { service_code: "PRIVATE-EDGE", service_name: "Owner service", price_per_sqft: 19 };
const owner = { clientAccountId: 1, lineUserId: "synthetic-owner-user", department: "sales" };

function fixture({ ownerAccountId = "1", binding, active = true, accountRows, catalogRows, fault } = {}) {
  const queries = [], sends = [];
  const db = async (query) => {
    queries.push(query);
    const url = new URL(query, "https://fixture.invalid/");
    if (fault && url.pathname.includes(fault)) throw new Error("Synthetic database failure");
    if (url.pathname === "/client_accounts") {
      assert.equal(url.searchParams.get("id"), "eq.1");
      assert.equal(url.searchParams.get("active"), "eq.true");
      return accountRows === undefined ? (active ? [{ id: 1, active: true }] : []) : accountRows;
    }
    if (url.pathname === "/glass_types" || url.pathname === "/edging_services") {
      assert.equal(url.searchParams.get("active"), "eq.true");
      assert.equal(url.searchParams.has("client_account_id"), false, "Do not query nonexistent ownership columns");
      return catalogRows === undefined ? [url.pathname === "/glass_types" ? product : edging] : catalogRows;
    }
    throw new Error(`Unexpected synthetic query: ${url.pathname}`);
  };
  const catalogAccess = createLegacyCatalogAccess({ db, ownerAccountId });
  const block = (begin, end) => {
    const start = source.indexOf(begin), stop = source.indexOf(end, start + begin.length);
    assert.ok(start >= 0 && stop > start, `Server extraction boundaries ${begin}`);
    return source.slice(start, stop);
  };
  // Evaluate the actual server tool/menu bodies, not rewritten copies of them.
  const actual = vm.runInNewContext([
    block("const TOOL_HANDLERS = {", "async function executeToolWithLog("),
    block("async function getProductText(", "async function getAgentCard("),
    block("async function handlePostback(", "// ---------- CLIENT MESSAGES ----------"),
    "({ TOOL_HANDLERS, getProductText, handlePostback })",
  ].join("\n"), { db, catalogAccess, URLSearchParams, encodeURIComponent,
    BRAND_COPY: {}, getSetting: async () => "", getBindings: async () => binding || [],
    replyToLine: async (_token, text) => { sends.push(text); },
  });
  return { ...actual, db, catalogAccess, queries, sends };
}

for (const [tool, field] of [["get_product_info", "products"], ["get_edging_info", "services"]]) {
  test(`LA04 catalog: ${tool} denies another tenant without reading the catalog`, async () => {
    const f = fixture();
    const result = await f.TOOL_HANDLERS[tool]({ ...owner, clientAccountId: 2 }, {});
    assert.equal(result.found, false);
    assert.equal(result[field].length, 0);
    assert.equal(f.queries.length, 0);
  });

  test(`LA04 catalog: ${tool} keeps an unassigned legacy catalog private`, async () => {
    const f = fixture({ ownerAccountId: "" });
    const result = await f.TOOL_HANDLERS[tool](owner, {});
    assert.equal(result.found, false);
    assert.equal(f.queries.length, 0);
  });

  test(`LA04 catalog: ${tool} permits only the exact configured active owner`, async () => {
    const f = fixture();
    const result = await f.TOOL_HANDLERS[tool](owner, {});
    assert.equal(result.found, true);
    assert.equal(result[field].length, 1);
    assert.equal(f.queries[0].startsWith("client_accounts?"), true);
    assert.equal(f.queries.length, 2);
  });
}

test("LA04 catalog: products postback from an unactivated user discloses no private rates", async () => {
  const f = fixture();
  await f.handlePostback({ source: { userId: "unactivated-user" }, replyToken: "fixture-token", postback: { data: "menu=products" } });
  assert.equal(f.sends.length, 1);
  assert.doesNotMatch(f.sends[0], /PRIVATE|Owner rates|Owner service|99/);
  assert.match(f.sends[0], /activate/i);
  assert.equal(f.queries.length, 0);
});

test("LA04 catalog: products postback uses its binding rather than an unrelated owner catalog", async () => {
  const f = fixture({ binding: [{ client_account_id: 2, department: "sales" }] });
  await f.handlePostback({ source: { userId: "other-tenant-user" }, replyToken: "fixture-token", postback: { data: "menu=products" } });
  assert.doesNotMatch(f.sends[0], /PRIVATE|Owner rates|Owner service|99/);
  assert.equal(f.queries.length, 0);
});

test("LA04 catalog: matching owner menu still provides its configured products and edging", async () => {
  const f = fixture({ binding: [{ client_account_id: 1, department: "sales" }] });
  await f.handlePostback({ source: { userId: owner.lineUserId }, replyToken: "fixture-token", postback: { data: "menu=products" } });
  assert.match(f.sends[0], /PRIVATE-GLASS/);
  assert.match(f.sends[0], /PRIVATE-EDGE/);
  assert.equal(f.queries.filter(q => q.startsWith("client_accounts?")).length, 2);
});

test("LA04 catalog: invalid account IDs and absent caller identity never issue a query", async () => {
  const f = fixture();
  for (const bad of [null, {}, "1&active=eq.false", "01", "1.0", "1e0", -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await f.catalogAccess.products({ ...owner, clientAccountId: bad })).found, false);
  }
  assert.equal((await f.catalogAccess.products({ clientAccountId: 1 })).found, false);
  assert.equal(f.queries.length, 0);
});

test("LA04 catalog: inactive or mismatched owner response is denied", async () => {
  for (const accountRows of [[], [{ id: 1, active: false }], [{ id: 2, active: true }], [{ id: "01", active: true }]]) {
    const f = fixture({ accountRows });
    assert.equal((await f.catalogAccess.products(owner)).found, false);
    assert.equal(f.queries.length, 1);
  }
});

test("LA04 catalog: database errors or malformed results are not empty-success answers", async () => {
  for (const options of [{ fault: "client_accounts" }, { fault: "glass_types" }, { accountRows: null }, { catalogRows: null }]) {
    const f = fixture(options);
    await assert.rejects(() => f.catalogAccess.products(owner));
  }
});

test("LA04 catalog: bounded search retains only actual matching rows", async () => {
  const f = fixture();
  assert.equal((await f.catalogAccess.products(owner, { query: "glass" })).products.length, 1);
  assert.equal((await f.catalogAccess.products(owner, { query: "other" })).found, false);
  assert.ok(f.queries.filter(q => q.startsWith("glass_types?")).every(q => q.includes("limit=100")));
});
