"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { loadOrgRoster } = require("../src/lib/org-learning-store");

async function loadOrgSchema(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  const baseFiles = [
    "fixtures/legacy-schema.sql",
    "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql",
    "../supabase/migrations/20261102000001_per_business_chat_rollup.sql",
    "../supabase/migrations/20261114000001_liff_website_builder.sql",
    "../supabase/migrations/20261117000001_dashboard_realtime_telemetry.sql",
    "../supabase/migrations/20261122000001_customer_trial_release.sql",
    "../supabase/migrations/20261122000002_ai_org_learning_and_reports.sql",
    "../supabase/manual_apply_trial_release.sql",
  ];
  for (const rel of baseFiles) {
    await db.exec(fs.readFileSync(path.join(__dirname, rel), "utf8"));
  }
  return db;
}

test("20261122000002 & manual bundle double-apply cleanly, enforce append-only (UPDATE/DELETE/TRUNCATE), cross-agent FK isolation, and RLS", async (t) => {
  const db = await loadOrgSchema(t);
  const roster = loadOrgRoster();

  async function runAsRole(role, fn) {
    await db.exec(`begin; set local role ${role};`);
    try {
      const result = await fn();
      await db.exec("commit;");
      return result;
    } catch (err) {
      await db.exec("rollback;");
      throw err;
    }
  }

  async function assertRoleRejects(role, sql, params, match) {
    await db.exec(`begin; set local role ${role};`);
    try {
      await assert.rejects(db.query(sql, params), match);
    } finally {
      await db.exec("rollback;");
    }
  }

  const { teams, agents, insertedId } = await runAsRole("service_role", async () => {
    const tRows = (await db.query("select team_id, manager_agent_id from public.nh_org_teams order by team_id")).rows;
    const aRows = (await db.query("select agent_id, team_id, is_manager from public.nh_org_agents order by agent_id")).rows;
    const row = (await db.query(`
      insert into public.nh_agent_individual_learning
        (agent_id, team_id, case_key, title, context_summary, observation, verified_action, evidence_ref, outcome, severity)
      values
        ('line-channel-tester', 'line-biz-console', 'CASE-DB-001', 'Group bind check', 'Testing group bind', 'Works cleanly', 'Keep atomic RPC', 'test', 'verified', 'medium')
      returning id
    `)).rows[0];
    return { teams: tRows, agents: aRows, insertedId: row.id };
  });

  assert.equal(teams.length, roster.teams.length);
  assert.equal(agents.length, roster.agents.length);
  assert.deepEqual(teams.map((r) => r.team_id), roster.teams.map((x) => x.teamId).sort());
  assert.deepEqual(agents.map((r) => r.agent_id), roster.agents.map((x) => x.agentId).sort());

  await assertRoleRejects(
    "service_role",
    `insert into public.nh_agent_individual_learning (agent_id, team_id, case_key, title, context_summary, observation, verified_action)
     values ('line-channel-tester', 'line-biz-console', 'CASE-DB-001', 'Dup', 'Dup', 'Dup', 'Dup')`,
    [],
    (err) => err.code === "23505"
  );

  await assertRoleRejects(
    "service_role",
    `insert into public.nh_agent_individual_learning (agent_id, team_id, case_key, title, context_summary, observation, verified_action)
     values ('line-channel-tester', 'after-service', 'CASE-DB-WRONG-TEAM', 'Wrong team', 'Context', 'Observation', 'Action')`,
    [],
    (err) => err.code === "23514"
  );

  await assertRoleRejects(
    "service_role",
    `insert into public.nh_agent_individual_learning (agent_id, team_id, case_key, title, context_summary, observation, verified_action, supersedes_id)
     values ('after-warranty-care', 'after-service', 'CASE-DB-CROSS-SUPER', 'Cross agent supersede', 'Context', 'Obs', 'Act', $1)`,
    [insertedId],
    (err) => err.code === "23503"
  );

  await assertRoleRejects("service_role", "delete from public.nh_agent_individual_learning where case_key = 'CASE-DB-001'", [], /permission denied/i);
  await assertRoleRejects("service_role", "update public.nh_agent_individual_learning set title = 'Mutated' where case_key = 'CASE-DB-001'", [], /permission denied/i);
  await assertRoleRejects("service_role", "truncate table public.nh_agent_individual_learning", [], /permission denied/i);

  await assert.rejects(db.query("delete from public.nh_agent_individual_learning where case_key = 'CASE-DB-001'"), (err) => err.code === "42501");
  await assert.rejects(db.query("update public.nh_agent_individual_learning set title = 'Mutated' where case_key = 'CASE-DB-001'"), (err) => err.code === "42501");
  await assert.rejects(db.query("truncate table public.nh_agent_individual_learning"), (err) => err.code === "42501");

  const superseded = await runAsRole("service_role", async () => {
    const r = (await db.query(`
      insert into public.nh_agent_individual_learning
        (agent_id, team_id, case_key, title, context_summary, observation, verified_action, supersedes_id)
      values
        ('line-channel-tester', 'line-biz-console', 'CASE-DB-002', 'Improved check', 'v2', 'Added dispatch', 'Append revision', $1)
      returning id, supersedes_id
    `, [insertedId])).rows[0];
    await db.query(`
      insert into public.nh_team_learning (team_id, pattern_key, title, standard_playbook, guardrail_rule, curated_by)
      values ('line-biz-console', 'PAT-DB-001', 'Team playbook', 'Steps', 'Rule', 'line-manager')
    `);
    await db.query(`
      insert into public.nh_reports (report_code, team_id, author_agent_id, channel, title, summary)
      values ('RPT-DB-001', 'central-command', 'cmd-synthesizer', 'founder', 'Daily Readiness', 'All checks passed.')
    `);
    await db.query(`
      insert into public.nh_governance_audits (overall_status, health_result, security_result, audit_result)
      values ('pass', '{"status":"pass"}'::jsonb, '{"status":"pass"}'::jsonb, '{"status":"pass"}'::jsonb)
    `);
    return r;
  });
  assert.equal(superseded.supersedes_id, insertedId);

  await assert.rejects(db.query("truncate table public.nh_team_learning"), (err) => err.code === "42501");
  await assert.rejects(db.query("truncate table public.nh_reports"), (err) => err.code === "42501");
  await assert.rejects(db.query("truncate table public.nh_governance_audits"), (err) => err.code === "42501");

  await assertRoleRejects("anon", "select * from public.nh_org_teams", [], /permission denied/i);
  await assertRoleRejects("anon", "select * from public.nh_agent_individual_learning", [], /permission denied/i);
  await assertRoleRejects("anon", "select * from public.nh_reports", [], /permission denied/i);

  const authCounts = await runAsRole("authenticated", async () => ({
    teams: (await db.query("select team_id from public.nh_org_teams")).rows.length,
    agents: (await db.query("select agent_id from public.nh_org_agents")).rows.length,
  }));
  assert.equal(authCounts.teams, 11);
  assert.equal(authCounts.agents, 32);

  await assertRoleRejects("authenticated", "select * from public.nh_agent_individual_learning", [], /permission denied/i);
  await assertRoleRejects("authenticated", "select * from public.nh_team_learning", [], /permission denied/i);
  await assertRoleRejects("authenticated", "select * from public.nh_central_council_tasks", [], /permission denied/i);
  await assertRoleRejects("authenticated", "select * from public.nh_reports", [], /permission denied/i);
  await assertRoleRejects("authenticated", "select * from public.nh_governance_audits", [], /permission denied/i);
});
