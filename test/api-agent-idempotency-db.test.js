const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const migrationDirectory = path.join(__dirname, "../supabase/migrations");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_agent_api_request_idempotency.sql"));
assert.equal(migrationNames.length, 1, "Exactly one agent API idempotency migration must exist");
const migrationSql = fs.readFileSync(path.join(migrationDirectory, migrationNames[0]), "utf8");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function claim(db, key, request = "request-a", tenant = 1) {
  return (await db.query(`
    select * from public.nh_claim_agent_api_request(
      $1::text, $2::text, $3::bigint, $4::text, $5::text
    )
  `, [digest(key), digest(request), tenant, "sales", digest("line-user")])).rows[0];
}

async function finish(db, row, key, request = "request-a", state = "completed") {
  const completed = state === "completed";
  return (await db.query(`
    select * from public.nh_finish_agent_api_request(
      $1::bigint, $2::text, $3::text, $4::uuid, $5::text,
      $6::integer, $7::jsonb, $8::bigint, $9::text
    )
  `, [1, digest(key), digest(request), row.execution_id, state,
    completed ? 200 : null, completed ? JSON.stringify({ reply: "stored", status: "completed" }) : null,
    null, completed ? null : "synthetic_failure"])).rows[0];
}

test("agent API request RPCs provide atomic exactly-once persistence", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create table public.client_accounts(id bigint primary key);
    create table public.agent_runs(id bigint primary key);
    insert into public.client_accounts values (1), (2);
  `);
  await db.exec(migrationSql);

  await t.test("concurrent identical claims acquire once and do not create a second execution", async () => {
    await db.exec("set role service_role");
    let rows;
    try {
      rows = await Promise.all([claim(db, "concurrent-key"), claim(db, "concurrent-key")]);
    } finally { await db.exec("reset role"); }
    assert.deepEqual(rows.map((row) => row.decision).sort(), ["acquired", "in_progress"]);
    assert.equal(new Set(rows.map((row) => row.execution_id)).size, 1);
    assert.equal(new Set(rows.map((row) => new Date(row.requested_at).toISOString())).size, 1);
    assert.equal((await db.query("select count(*)::int as count from public.agent_api_requests where client_account_id=1")).rows[0].count, 1);
  });

  await t.test("a completed request replays the stored response and changed payload is rejected", async () => {
    await db.exec("set role service_role");
    try {
      const acquired = await claim(db, "completed-key");
      assert.equal(acquired.decision, "acquired");
      const completed = await finish(db, acquired, "completed-key");
      assert.equal(completed.state, "completed");
      assert.deepEqual(completed.response_body, { reply: "stored", status: "completed" });
      const replay = await claim(db, "completed-key");
      assert.equal(replay.decision, "completed");
      assert.equal(replay.execution_id, acquired.execution_id);
      assert.deepEqual(replay.response_body, completed.response_body);
      assert.equal((await claim(db, "completed-key", "different-payload")).decision, "conflict");
    } finally { await db.exec("reset role"); }
  });

  await t.test("a key cannot reacquire after its authenticated binding moves tenants", async () => {
    await db.exec("set role service_role");
    try {
      assert.equal((await claim(db, "tenant-key", "request-a", 1)).decision, "acquired");
      assert.equal((await claim(db, "tenant-key", "request-a", 2)).decision, "conflict");
      assert.equal((await db.query("select count(*)::int as count from public.agent_api_requests where idempotency_key_hash=$1", [digest("tenant-key")])).rows[0].count, 1);
    } finally { await db.exec("reset role"); }
  });

  await t.test("expired and failed executions remain terminal and are never reacquired", async () => {
    await db.exec("set role service_role");
    try {
      const expired = await claim(db, "expired-key");
      await db.query("update public.agent_api_requests set lease_expires_at=clock_timestamp()-interval '1 second' where execution_id=$1", [expired.execution_id]);
      assert.equal((await claim(db, "expired-key")).decision, "uncertain");
      const failed = await claim(db, "failed-key");
      assert.equal((await finish(db, failed, "failed-key", "request-a", "failed")).state, "failed");
      assert.equal((await claim(db, "failed-key")).decision, "failed");
    } finally { await db.exec("reset role"); }
  });

  await t.test("browser roles cannot read the ledger or execute lifecycle RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query("select * from public.agent_api_requests"), { code: "42501" });
        await assert.rejects(claim(db, `browser-${role}`), { code: "42501" });
      } finally { await db.exec("reset role"); }
    }
    const relation = (await db.query("select relrowsecurity from pg_class where oid='public.agent_api_requests'::regclass")).rows[0];
    assert.equal(relation.relrowsecurity, true);
  });
});
