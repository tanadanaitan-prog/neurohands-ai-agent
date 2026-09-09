const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const migrationDirectory = path.join(__dirname, "../supabase/migrations");
const migrationSql = (suffix) => {
  const matching = fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(suffix));
  assert.equal(matching.length, 1, `Exactly one migration must match ${suffix}`);
  return fs.readFileSync(path.join(migrationDirectory, matching[0]), "utf8");
};

test("Jarvis run classification preserves client scope and permissions in isolated PostgreSQL", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  await db.exec(fs.readFileSync(path.join(__dirname, "fixtures/legacy-schema.sql"), "utf8"));
  // The deployed Phase 1 stack; the separate, unapplied workspace schema is not a prerequisite.
  for (const suffix of ["_phase1_gateway_recovery.sql", "_phase1_webhook_inbox.sql", "_agent_run_model_metrics.sql"]) {
    await db.exec(migrationSql(suffix));
  }
  const accountId = (await db.query("select id from public.client_accounts where client_code='KNC'")).rows[0].id;
  const original = (await db.query(`insert into public.agent_runs
    (agent_code,line_user_id,client_account_id,department,objective,input,status,output,iterations,completed_at,llm_metrics)
    values ('AGT-001','fixture-client',$1,'sales','Preserve history','Original question','completed','Original answer',2,now(),'{"version":1}')
    returning *`, [accountId])).rows[0];
  const originalNote = (await db.query(`insert into public.jarvis_notes
    (content,category,proposed_by) values ('Original proposed note','general','fixture-operator-a') returning *`)).rows[0];
  const securityState = async () => ({
    relations: (await db.query(`select relname,relkind,relrowsecurity,relforcerowsecurity,relacl::text as acl
      from pg_class where oid in ('public.agent_runs'::regclass,'public.agent_runs_id_seq'::regclass,
        'public.jarvis_notes'::regclass,'public.jarvis_notes_id_seq'::regclass)
      order by relname`)).rows,
    policies: (await db.query("select * from pg_policies where schemaname='public' and tablename in ('agent_runs','jarvis_notes') order by tablename,policyname")).rows,
    grants: (await db.query(`select rolname,
      has_table_privilege(rolname,'public.agent_runs','SELECT') as can_select,
      has_table_privilege(rolname,'public.agent_runs','INSERT') as can_insert,
      has_table_privilege(rolname,'public.agent_runs','UPDATE') as can_update,
      has_table_privilege(rolname,'public.agent_runs','DELETE') as can_delete,
      has_table_privilege(rolname,'public.agent_runs','TRUNCATE') as can_truncate,
      has_sequence_privilege(rolname,'public.agent_runs_id_seq','USAGE') as can_use_sequence,
      has_table_privilege(rolname,'public.jarvis_notes','SELECT') as can_select_notes,
      has_table_privilege(rolname,'public.jarvis_notes','INSERT') as can_insert_notes,
      has_table_privilege(rolname,'public.jarvis_notes','UPDATE') as can_update_notes,
      has_table_privilege(rolname,'public.jarvis_notes','DELETE') as can_delete_notes,
      has_table_privilege(rolname,'public.jarvis_notes','TRUNCATE') as can_truncate_notes,
      has_sequence_privilege(rolname,'public.jarvis_notes_id_seq','USAGE') as can_use_notes_sequence
      from pg_roles where rolname in ('anon','authenticated','service_role') order by rolname`)).rows,
  });
  const securityBefore = await securityState();
  await db.exec(migrationSql("_jarvis_operator_runs.sql"));

  const insertRun = async (overrides = {}) => {
    const fields = {
      run_kind: "operator", line_user_id: "fixture-operator-a", client_account_id: null,
      agent_code: null, department: "operations", input: "Local operator question", ...overrides,
    };
    const columns = Object.keys(fields);
    return (await db.query(`insert into public.agent_runs (${columns.join(",")})
      values (${columns.map((_, index) => `$${index + 1}`).join(",")}) returning *`, Object.values(fields))).rows[0];
  };
  const asService = async (work) => {
    await db.exec("set role service_role");
    try { return await work(); }
    finally { await db.exec("reset role"); }
  };

  await t.test("existing client history is unchanged and old insert callers still default to client", async () => {
    const saved = (await db.query("select * from public.agent_runs where id=$1", [original.id])).rows[0];
    const { run_kind, delivered_at, ...preserved } = saved;
    assert.equal(run_kind, "client");
    assert.equal(delivered_at, null);
    assert.deepEqual(preserved, original);
    const fresh = await asService(async () => (await db.query(`insert into public.agent_runs
      (agent_code,line_user_id,client_account_id,department,input)
      values ('AGT-001','fixture-new-client',$1,'sales','Old caller') returning *`, [accountId])).rows[0]);
    assert.equal(fresh.run_kind, "client");
    assert.equal(fresh.client_account_id, accountId);
    assert.equal(fresh.delivered_at, null);
    const deliveryColumn = (await db.query(`select column_default,is_nullable from information_schema.columns
      where table_schema='public' and table_name='agent_runs' and column_name='delivered_at'`)).rows[0];
    assert.deepEqual(deliveryColumn, { column_default: null, is_nullable: "YES" });
    await assert.rejects(db.query("update public.agent_runs set client_account_id=null where id=$1", [original.id]), { code: "23514" });
    await assert.rejects(db.query("update public.agent_runs set run_kind='operator' where id=$1", [original.id]), { code: "23514" });
    assert.deepEqual((await db.query("select * from public.agent_runs where id=$1", [original.id])).rows[0], saved);
  });

  await t.test("a missing customer account is rejected for explicit and default client kinds", async () => {
    await assert.rejects(asService(() => insertRun({ run_kind: "client", department: "sales" })), { code: "23514" });
    await assert.rejects(asService(() => db.query(`insert into public.agent_runs
      (line_user_id,department,input) values ('fixture-no-client','sales','Must reject')`)), { code: "23514" });
    await assert.rejects(asService(() => insertRun({ run_kind: "client", client_account_id: 9999999, department: "sales" })), { code: "23503" });
  });

  await t.test("service role can persist operator runs and metrics without a fake client or agent", async () => {
    const operator = await asService(() => insertRun());
    assert.equal(operator.run_kind, "operator");
    assert.equal(operator.client_account_id, null);
    assert.equal(operator.agent_code, null);
    assert.equal(operator.department, "operations");
    assert.equal(operator.delivered_at, null);
    const updated = await asService(async () => (await db.query(`update public.agent_runs
      set status='completed',output='Local verified result',completed_at=now(),llm_metrics=$1::jsonb
      where id=$2 returning *`, [JSON.stringify({ version: 1, finalized: true }), operator.id])).rows[0]);
    assert.equal(updated.status, "completed");
    assert.equal(updated.llm_metrics.finalized, true);
    assert.equal(updated.delivered_at, null, "Completing a model run is not proof of LINE delivery");
    await assert.rejects(asService(() => db.query("update public.agent_runs set llm_metrics='[]'::jsonb where id=$1", [operator.id])), { code: "23514" });
    await assert.rejects(asService(() => db.query("update public.agent_runs set client_account_id=$1 where id=$2", [accountId, operator.id])), { code: "23514" });
  });

  await t.test("invalid classifications and mixed operator/customer shapes are rejected", async () => {
    const invalid = [
      { run_kind: "unknown" },
      { run_kind: "" },
      { client_account_id: accountId },
      { agent_code: "AGT-001" },
      { department: "sales" },
      { client_account_id: accountId, agent_code: "AGT-001", department: "sales" },
    ];
    for (const overrides of invalid) await assert.rejects(asService(() => insertRun(overrides)), { code: "23514" });
    await assert.rejects(asService(() => insertRun({ run_kind: null })), { code: "23502" });
    await assert.rejects(asService(() => insertRun({ department: null })), { code: "23502" });
    await assert.rejects(asService(() => insertRun({ line_user_id: null })), { code: "23502" });
  });

  await t.test("proposal source runs preserve old notes and link approved tool evidence through a real foreign key", async () => {
    const saved = (await db.query("select * from public.jarvis_notes where id=$1", [originalNote.id])).rows[0];
    const { source_run_id, ...preserved } = saved;
    assert.equal(source_run_id, null);
    assert.deepEqual(preserved, originalNote);
    const explicit = await asService(async () => (await db.query(`insert into public.jarvis_notes
      (content,category,proposed_by) values ('Explicit command proposal','general','fixture-operator-a') returning *`)).rows[0]);
    assert.equal(explicit.source_run_id, null);
    assert.equal(explicit.status, "pending");

    const operator = await asService(() => insertRun());
    const proposed = await asService(async () => (await db.query(`insert into public.jarvis_notes
      (content,category,proposed_by,tool_name,tool_args,client_account_id,department,source_run_id)
      values ('Scoped support proposal','general','fixture-operator-a','create_support_case','{}',$1,'sales',$2)
      returning *`, [accountId, operator.id])).rows[0]);
    assert.equal(proposed.source_run_id, operator.id);
    await assert.rejects(asService(() => db.query(`insert into public.jarvis_notes
      (content,category,proposed_by,source_run_id) values ('Invalid source','general','fixture-operator-a',9999999)`)), { code: "23503" });
    await assert.rejects(asService(() => db.query("update public.jarvis_notes set source_run_id=9999999 where id=$1", [proposed.id])), { code: "23503" });

    const claimed = await asService(async () => (await db.query("select * from public.nh_claim_note($1,$2)", [proposed.id, "fixture-operator-a"])).rows[0]);
    assert.equal(claimed.source_run_id, operator.id);
    assert.equal(claimed.status, "executing");
    await asService(() => db.query(`insert into public.tool_calls(run_id,tool_name,input,output,allowed,status)
      values ($1,'create_support_case','{}','{"created":true}',true,'success')`, [claimed.source_run_id]));
    const chain = (await db.query(`select n.source_run_id,t.run_id,t.allowed,t.status
      from public.jarvis_notes n join public.tool_calls t on t.run_id=n.source_run_id where n.id=$1`, [proposed.id])).rows[0];
    assert.deepEqual(chain, { source_run_id: operator.id, run_id: operator.id, allowed: true, status: "success" });
    await assert.rejects(asService(() => db.query("delete from public.agent_runs where id=$1", [operator.id])), { code: "23503" });
    assert.match((await db.query(`select indexdef from pg_indexes where schemaname='public'
      and tablename='jarvis_notes' and indexname='jarvis_notes_source_run_idx'`)).rows[0].indexdef, /\(source_run_id\)/);
  });

  await t.test("RLS, browser restrictions and existing service grants are unchanged", async () => {
    assert.deepEqual(await securityState(), securityBefore);
    assert.equal(securityBefore.relations.find((row) => row.relname === "agent_runs").relrowsecurity, true);
    assert.equal(securityBefore.relations.find((row) => row.relname === "jarvis_notes").relrowsecurity, true);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query("select * from public.agent_runs where run_kind='operator'"), { code: "42501" });
        await assert.rejects(insertRun(), { code: "42501" });
        await assert.rejects(db.query("update public.agent_runs set run_kind='operator'"), { code: "42501" });
        await assert.rejects(db.query("truncate public.agent_runs"), { code: "42501" });
        await assert.rejects(db.query("select source_run_id from public.jarvis_notes"), { code: "42501" });
        await assert.rejects(db.query("update public.jarvis_notes set source_run_id=null"), { code: "42501" });
      } finally { await db.exec("reset role"); }
    }
  });

  await t.test("operator history requires recorded delivery, remains scoped and uses deterministic indexed ordering", async () => {
    const historyUser = "fixture-history-operator";
    const deliveredAt = "2026-09-03T00:01:00Z";
    const earlier = await insertRun({ line_user_id: historyUser, status: "completed", created_at: "2026-09-01T00:00:00Z", delivered_at: deliveredAt });
    const sameTimeOne = await insertRun({ line_user_id: historyUser, status: "completed", created_at: "2026-09-02T00:00:00Z", delivered_at: deliveredAt });
    const sameTimeTwo = await insertRun({ line_user_id: historyUser, status: "completed", created_at: "2026-09-02T00:00:00Z", delivered_at: deliveredAt });
    const undelivered = await insertRun({ line_user_id: historyUser, status: "completed", created_at: "2026-09-03T00:00:00Z" });
    await insertRun({ line_user_id: historyUser, status: "started", created_at: "2026-09-03T00:00:00Z", delivered_at: deliveredAt });
    await insertRun({ line_user_id: historyUser, status: "error", created_at: "2026-09-03T00:00:00Z", delivered_at: deliveredAt });
    await insertRun({ line_user_id: "fixture-other-operator", status: "completed", created_at: "2026-09-03T00:00:00Z", delivered_at: deliveredAt });
    await insertRun({ run_kind: "client", line_user_id: historyUser, client_account_id: accountId, department: "sales", status: "completed", created_at: "2026-09-03T00:00:00Z", delivered_at: deliveredAt });
    const query = `select id from public.agent_runs where line_user_id=$1 and run_kind='operator' and status='completed'
      and delivered_at is not null order by created_at desc,id desc limit 3`;
    const history = await asService(() => db.query(query, [historyUser]));
    assert.deepEqual(history.rows.map((row) => row.id), [sameTimeTwo.id, sameTimeOne.id, earlier.id]);
    await asService(() => db.query("update public.agent_runs set delivered_at=$1 where id=$2", [deliveredAt, undelivered.id]));
    const confirmedHistory = await asService(() => db.query(query, [historyUser]));
    assert.deepEqual(confirmedHistory.rows.map((row) => row.id), [undelivered.id, sameTimeTwo.id, sameTimeOne.id]);

    const index = (await db.query(`select indexdef from pg_indexes
      where schemaname='public' and tablename='agent_runs' and indexname='agent_runs_operator_history_idx'`)).rows[0];
    assert.match(index.indexdef, /\(line_user_id, created_at DESC, id DESC\)/);
    assert.match(index.indexdef, /run_kind = 'operator'/);
    assert.match(index.indexdef, /status = 'completed'/);
    assert.match(index.indexdef, /delivered_at IS NOT NULL/);
    // Small fixtures normally use a sequential scan; this checks index applicability, not speed.
    await db.exec("set enable_seqscan=off");
    try {
      const plan = await db.query(`explain (format json) ${query}`, [historyUser]);
      assert.match(JSON.stringify(plan.rows), /agent_runs_operator_history_idx/);
    } finally { await db.exec("reset enable_seqscan"); }
  });
});
