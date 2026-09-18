"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const migrationDirectory = path.join(__dirname, "../supabase/migrations");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_deployment_approvals.sql"));
assert.equal(migrationNames.length, 1, "Exactly one deployment approval migration must exist");
const migrationSql = fs.readFileSync(path.join(migrationDirectory, migrationNames[0]), "utf8");

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function claim(db, approvalId, overrides = {}) {
  return (await db.query(`
    select * from public.nh_claim_deployment_approval(
      $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text
    )
  `, [
    approvalId,
    overrides.commitSha || COMMIT,
    overrides.deploymentKey || "release.neurohands.test.0001",
    overrides.requesterId || "codex-engineering",
    overrides.action || "railway_deploy",
    overrides.target || "railway_production",
    overrides.requestDigest || digest("exact-request"),
  ])).rows[0];
}

async function approvedRow(db, overrides = {}) {
  const approvalId = crypto.randomUUID();
  await db.query(`
    insert into public.nh_deployment_approvals (
      approval_id, action, target, approved_commit_sha, founder_principal,
      founder_approved, approved_at, expires_at, state
    ) values ($1, $2, $3, $4, 'founder-test', true, clock_timestamp(), $5, 'approved')
  `, [
    approvalId,
    overrides.action || "railway_deploy",
    overrides.target || "railway_production",
    overrides.commitSha || COMMIT,
    overrides.expiresAt || new Date(Date.now() + 60_000).toISOString(),
  ]);
  return approvalId;
}

test("deployment approvals are exact, atomic, one-use and unavailable to browser roles", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);
  await db.exec(migrationSql);

  await t.test("one exact founder approval is claimed once and an identical retry cannot deploy again", async () => {
    const approvalId = await approvedRow(db);
    await db.exec("set role service_role");
    let first;
    let replay;
    try {
      first = await claim(db, approvalId);
      replay = await claim(db, approvalId);
    } finally {
      await db.exec("reset role");
    }
    assert.equal(first.decision, "claimed");
    assert.equal(first.approved_commit_sha, COMMIT);
    assert.equal(first.founder_approved, true);
    assert.match(first.claim_id, /^[0-9a-f-]{36}$/i);
    assert.equal(replay.decision, "idempotent_replay");
    assert.equal(replay.claim_id, first.claim_id);
  });

  await t.test("wrong commit, target and expiry never consume an approval", async () => {
    const commitApproval = await approvedRow(db);
    const targetApproval = await approvedRow(db);
    const expiredApproval = await approvedRow(db, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await db.exec("set role service_role");
    let wrongCommit;
    let wrongTarget;
    let expired;
    try {
      wrongCommit = await claim(db, commitApproval, { commitSha: OTHER_COMMIT });
      wrongTarget = await claim(db, targetApproval, { action: "github_merge", target: "github_main" });
      expired = await claim(db, expiredApproval);
    } finally {
      await db.exec("reset role");
    }
    assert.equal(wrongCommit.decision, "commit_mismatch");
    assert.equal(wrongTarget.decision, "conflict");
    assert.equal(expired.decision, "expired");
    const states = (await db.query(`
      select state from public.nh_deployment_approvals
      where approval_id = any($1::uuid[]) order by approval_id
    `, [[commitApproval, targetApproval, expiredApproval]])).rows;
    assert.deepEqual(states.map((row) => row.state), ["approved", "approved", "approved"]);
  });

  await t.test("concurrent claims can consume the approval at most once", async () => {
    const approvalId = await approvedRow(db);
    await db.exec("set role service_role");
    let decisions;
    try {
      decisions = await Promise.all([
        claim(db, approvalId, { requesterId: "codex-one", requestDigest: digest("one") }),
        claim(db, approvalId, { requesterId: "codex-two", requestDigest: digest("two") }),
      ]);
    } finally {
      await db.exec("reset role");
    }
    assert.equal(decisions.filter((row) => row.decision === "claimed").length, 1);
    assert.equal(decisions.filter((row) => row.decision === "already_used").length, 1);
  });

  await t.test("browser roles cannot read, create or claim deployment approval", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query("select * from public.nh_deployment_approvals"), /permission denied/i);
        await assert.rejects(db.query(`
          insert into public.nh_deployment_approvals (
            action, target, approved_commit_sha, founder_principal, expires_at
          ) values ('railway_deploy', 'railway_production', $1, 'forged', clock_timestamp() + interval '1 hour')
        `, [COMMIT]), /permission denied/i);
        await assert.rejects(claim(db, crypto.randomUUID()), /permission denied/i);
      } finally {
        await db.exec("reset role");
      }
    }
  });

  await t.test("the application service role can claim but cannot create or rewrite founder approval", async () => {
    const approvalId = await approvedRow(db);
    await db.exec("set role service_role");
    try {
      await assert.rejects(db.query(`
        insert into public.nh_deployment_approvals (
          action, target, approved_commit_sha, founder_principal, expires_at
        ) values ('railway_deploy', 'railway_production', $1, 'forged', clock_timestamp() + interval '1 hour')
      `, [COMMIT]), /permission denied/i);
      await assert.rejects(db.query(`
        update public.nh_deployment_approvals
        set founder_approved = true, state = 'approved', approved_at = clock_timestamp()
        where approval_id = $1
      `, [approvalId]), /permission denied/i);
      const exact = await claim(db, approvalId);
      assert.equal(exact.decision, "claimed");
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("the privileged claim function has a fixed empty search path and exact execute grants", async () => {
    const functionSecurity = (await db.query(`
      select p.prosecdef, p.proconfig
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'nh_claim_deployment_approval'
    `)).rows[0];
    assert.equal(functionSecurity.prosecdef, true);
    assert.deepEqual(functionSecurity.proconfig, ["search_path=\"\""]);

    const privileges = (await db.query(`
      select
        has_function_privilege('service_role',
          'public.nh_claim_deployment_approval(uuid,text,text,text,text,text,text)', 'EXECUTE') as service_execute,
        has_function_privilege('anon',
          'public.nh_claim_deployment_approval(uuid,text,text,text,text,text,text)', 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated',
          'public.nh_claim_deployment_approval(uuid,text,text,text,text,text,text)', 'EXECUTE') as authenticated_execute,
        has_table_privilege('service_role', 'public.nh_deployment_approvals', 'INSERT') as service_insert,
        has_table_privilege('service_role', 'public.nh_deployment_approvals', 'UPDATE') as service_update
    `)).rows[0];
    assert.deepEqual(privileges, {
      service_execute: true,
      anon_execute: false,
      authenticated_execute: false,
      service_insert: false,
      service_update: false,
    });
  });
});
