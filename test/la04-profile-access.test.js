"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function actualProfile(client, accounts = [{ id: 1, company: "Current account" }]) {
  const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const start = source.indexOf("const TOOL_HANDLERS = {"), end = source.indexOf("async function executeToolWithLog(", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}; TOOL_HANDLERS.get_client_profile`, {
    db: async (query) => {
      assert.equal(query, "client_accounts?id=eq.1&select=*");
      return accounts;
    },
    findClient: async (user) => { assert.equal(user, "same-line-user"); return client; },
    encodeURIComponent,
  });
}

test("LA04 profile: one LINE user's old client record cannot cross into another account", async () => {
  const record = { id: 8, client_account_id: 2, private_note: "OTHER-ACCOUNT-PROFILE" };
  const result = await actualProfile(record)({ lineUserId: "same-line-user", clientAccountId: 1 });
  assert.equal(result.found, true);
  assert.equal(result.client_account.id, 1);
  assert.equal(result.line_client, null);
  assert.equal(JSON.stringify(result).includes("OTHER-ACCOUNT-PROFILE"), false);
});

test("LA04 profile: the matching account keeps its real client profile", async () => {
  const record = { id: 8, client_account_id: 1, name: "Authorized synthetic client" };
  const result = await actualProfile(record)({ lineUserId: "same-line-user", clientAccountId: 1 });
  assert.equal(result.found, true);
  assert.equal(result.line_client, record);
});

for (const [label, accounts] of [["missing", []], ["mismatched", [{ id: 2 }]], ["inactive", [{ id: 1, active: false }]]]) {
  test(`LA04 profile: ${label} account cannot report a found profile`, async () => {
    const result = await actualProfile({ id: 8, client_account_id: 1, name: "Synthetic profile" }, accounts)
      ({ lineUserId: "same-line-user", clientAccountId: 1 });
    assert.equal(result.found, false);
    assert.equal(result.line_client, undefined);
  });
}
