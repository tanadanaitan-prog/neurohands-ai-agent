"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function loadTrialSchema(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  const files = [
    "fixtures/legacy-schema.sql",
    "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql",
    "../supabase/migrations/20261102000001_per_business_chat_rollup.sql",
    "../supabase/migrations/20261114000001_liff_website_builder.sql",
    "../supabase/migrations/20261117000001_dashboard_realtime_telemetry.sql",
    "../supabase/migrations/20261122000001_customer_trial_release.sql",
  ];
  for (const rel of files) {
    await db.exec(fs.readFileSync(path.join(__dirname, rel), "utf8"));
  }
  await db.exec(`
    insert into public.client_accounts (id, client_code, company, active)
    overriding system value values (1, 'KNC', 'KNC Glass', true), (2, 'BKK', 'Bangkok Glass', true)
    on conflict (id) do nothing;
    insert into public.nh_tenant_trials (client_account_id, max_messages, max_actions, spending_cap_usd)
    values (1, 2, 1, 0), (2, 200, 50, 0)
    on conflict (client_account_id) do update
      set max_messages = excluded.max_messages, max_actions = excluded.max_actions, spending_cap_usd = excluded.spending_cap_usd;
  `);
  return db;
}

test("20261122000001 enforces atomic trial quotas, expiry, spend cap, tenant RLS isolation, and service-only RPC", async (t) => {
  const db = await loadTrialSchema(t);

  await db.exec("set local role service_role;");
  const c1 = (await db.query("select * from public.nh_consume_trial_allowance(1, 1, 1, 0)")).rows[0];
  assert.equal(c1.allowed, true);
  assert.equal(c1.remaining_messages, 1);
  assert.equal(c1.remaining_actions, 0);

  const c2 = (await db.query("select * from public.nh_consume_trial_allowance(1, 1, 1, 0)")).rows[0];
  assert.equal(c2.allowed, false);
  assert.equal(c2.reason, "action_limit_reached");
  assert.equal(c2.status, "quota_exceeded");

  const c3 = (await db.query("select * from public.nh_consume_trial_allowance(1, 1, 0, 0.01)")).rows[0];
  assert.equal(c3.allowed, false);
  assert.equal(c3.reason, "spending_cap_reached");

  const c4 = (await db.query("select * from public.nh_consume_trial_allowance(1, 1, 0, 0)")).rows[0];
  assert.equal(c4.allowed, true);
  assert.equal(c4.remaining_messages, 0);

  const c5 = (await db.query("select * from public.nh_consume_trial_allowance(1, 1, 0, 0)")).rows[0];
  assert.equal(c5.allowed, false);
  assert.equal(c5.reason, "message_limit_reached");

  const zeroReset = (await db.query("select * from public.nh_consume_trial_allowance(1, 0, 0, 0)")).rows[0];
  assert.equal(zeroReset.allowed, false);
  assert.equal(zeroReset.status, "quota_exceeded");

  const singleHash = "a".repeat(64);
  await db.query(`
    insert into public.activation_codes (code_hash, code_hint, client_account_id, department, status, max_uses, used_count, expires_at, created_by)
    values ($1, 'NH-…1234', 1, 'sales', 'active', 1, 0, now() + interval '1 day', 'owner@knc.example')
  `, [singleHash]);
  const claimed1 = (await db.query("select * from public.nh_claim_activation_code($1)", [singleHash])).rows;
  assert.equal(claimed1.length, 1);
  const claimed2 = (await db.query("select * from public.nh_claim_activation_code($1)", [singleHash])).rows;
  assert.equal(claimed2.length, 0);

  const expired = (await db.query("select * from public.nh_consume_trial_allowance(2, 1, 0, 0, now() + interval '20 days')")).rows[0];
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, "trial_expired");
  assert.equal(expired.status, "expired");

  const missing = (await db.query("select * from public.nh_consume_trial_allowance(999, 1, 0, 0)")).rows[0];
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, "trial_not_found");

  await db.query(`
    insert into public.nh_agent_workflows (client_account_id, agent_code, name, role, status, workflow_spec)
    values (1, 'ARIA', 'KNC Aria', 'customer_service', 'published', '{"blocks":["instructions","knowledge","reply"]}'::jsonb),
           (2, 'ARIA', 'BKK Aria', 'customer_service', 'published', '{"blocks":["instructions","reply"]}'::jsonb)
  `);
  await db.query(`
    insert into public.nh_line_group_bindings (client_account_id, line_group_id, source_type, response_mode)
    values (1, 'C11111111111111111111111111111111', 'group', 'mention_only')
  `);
  await db.query(`
    insert into public.nh_conversation_states (client_account_id, channel_type, thread_id, state)
    values (1, 'line_group', 'C11111111111111111111111111111111', 'human_takeover')
  `);
  await db.exec("reset role;");

  await db.exec("begin; set local role authenticated;");
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"provider":"trial_web","client_account_id":1}}', true)`);
  const t1Workflows = await db.query("select name from public.nh_agent_workflows");
  assert.deepEqual(t1Workflows.rows, [{ name: "KNC Aria" }]);
  const t1Groups = await db.query("select line_group_id from public.nh_line_group_bindings");
  assert.equal(t1Groups.rows.length, 1);
  await db.exec("rollback;");

  await db.exec("begin; set local role authenticated;");
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"provider":"trial_web","client_account_id":2}}', true)`);
  const t2Groups = await db.query("select line_group_id from public.nh_line_group_bindings");
  assert.equal(t2Groups.rows.length, 0);
  const t2States = await db.query("select state from public.nh_conversation_states");
  assert.equal(t2States.rows.length, 0);
  await db.exec("rollback;");

  await db.exec("begin; set local role authenticated;");
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"provider":"email"},"user_metadata":{"client_account_id":1}}', true)`);
  assert.equal((await db.query("select * from public.nh_agent_workflows")).rows.length, 0);
  await db.exec("rollback;");

  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(async () => {
      await db.exec(`begin; set local role ${role};`);
      try {
        await db.query("select * from public.nh_consume_trial_allowance(1, 1, 0, 0)");
      } finally {
        await db.exec("rollback;");
      }
    }, /permission denied/i);
  }
});
