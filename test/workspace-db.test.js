const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

test("workspace migration enforces identity, role, tenant and revision boundaries in PostgreSQL", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const ownerA = "00000000-0000-4000-8000-000000000001";
  const ownerB = "00000000-0000-4000-8000-000000000002";
  const viewer = "00000000-0000-4000-8000-000000000003";
  const operator = "00000000-0000-4000-8000-000000000004";
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    insert into auth.users values ('${ownerA}'), ('${ownerB}'), ('${viewer}'), ('${operator}');
  `);
  const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260907112335_agent_workspace_foundation.sql"), "utf8");
  await db.exec(migration);
  async function asUser(user, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    try { return await fn(); }
    finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub', '', false)"); }
  }
  const makeWorkspace = (name) => db.query("select public.nh_create_workspace($1) as id", [name]).then((r) => r.rows[0].id);
  const workspaceA = await asUser(ownerA, () => makeWorkspace("Company A"));
  const workspaceB = await asUser(ownerB, () => makeWorkspace("Company B"));
  const departmentA = (await db.query("select id from nh_departments where workspace_id = $1 order by sort_order limit 1", [workspaceA])).rows[0].id;
  const departmentB = (await db.query("select id from nh_departments where workspace_id = $1 order by sort_order limit 1", [workspaceB])).rows[0].id;
  let agent;

  await t.test("workspace and all ten departments are created atomically for the signed-in owner", async () => {
    await asUser(ownerA, async () => {
      const rows = (await db.query("select * from nh_workspaces")).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, workspaceA);
      assert.equal((await db.query("select * from nh_departments")).rows.length, 10);
      assert.equal((await db.query("select nh_can_access($1, 'manage') as allowed", [workspaceB])).rows[0].allowed, false);
      await assert.rejects(db.query("insert into nh_workspaces(name,owner_id) values ('Spoof', $1)", [ownerB]), { code: "42501" });
      await assert.rejects(db.query("select nh_create_workspace('')"), { code: "23514" });
      assert.equal((await db.query("select * from nh_workspaces")).rows.length, 1);
      agent = (await db.query("insert into nh_agents(workspace_id,department_id,name,role) values ($1,$2,'Aria','Sales coordinator') returning *", [workspaceA, departmentA])).rows[0];
    });
  });

  await t.test("cross-workspace reads, writes and references cannot escape tenant isolation", async () => {
    await asUser(ownerB, async () => {
      assert.equal((await db.query("select * from nh_agents where id=$1", [agent.id])).rows.length, 0);
      assert.equal((await db.query("update nh_agents set name='Hijacked' where id=$1 returning id", [agent.id])).rows.length, 0);
      await assert.rejects(db.query("insert into nh_agents(workspace_id,department_id,name,role) values ($1,$2,'Cross tenant','Research')", [workspaceB, departmentA]), { code: "23503" });
    });
    await asUser(ownerA, async () => {
      await assert.rejects(db.query("update nh_agents set workspace_id=$1 where id=$2", [workspaceB, agent.id]), { code: "42501" });
      await assert.rejects(db.query("update nh_workspaces set owner_id=$1 where id=$2", [ownerB, workspaceA]), { code: "42501" });
    });
  });

  await t.test("viewer and operator membership cannot be promoted by the member", async () => {
    await db.query("insert into nh_memberships(workspace_id,user_id,role) values ($1,$2,'viewer'),($1,$3,'operator')", [workspaceA, viewer, operator]);
    for (const [user, operate] of [[viewer, false], [operator, true]]) {
      await asUser(user, async () => {
        assert.equal((await db.query("select * from nh_agents")).rows.length, 1);
        assert.equal((await db.query("select nh_can_access($1, 'operate') as allowed", [workspaceA])).rows[0].allowed, operate);
        assert.equal((await db.query("select nh_can_access($1, 'manage') as allowed", [workspaceA])).rows[0].allowed, false);
        await assert.rejects(db.query("update nh_memberships set role='admin' where user_id=$1", [user]), { code: "42501" });
        await assert.rejects(db.query("insert into nh_agents(workspace_id,department_id,name,role) values ($1,$2,'Unauthorized','Admin')", [workspaceA, departmentA]), { code: "42501" });
      });
    }
  });

  await t.test("publishing rejects stale versions and preserves an immutable definition", async () => {
    await asUser(ownerA, async () => {
      await assert.rejects(db.query("select nh_publish_agent($1,1)", [agent.id]), { code: "22023" });
      const changed = await db.query("update nh_agents set responsibilities=array['Review orders'] where id=$1 and version=1 returning version", [agent.id]);
      assert.equal(changed.rows[0].version, 2);
      assert.equal((await db.query("update nh_agents set name='Stale write' where id=$1 and version=1 returning id", [agent.id])).rows.length, 0);
      await assert.rejects(db.query("select nh_publish_agent($1,1)", [agent.id]), { code: "40001" });
      await db.query("select nh_publish_agent($1,2)", [agent.id]);
      await db.query("update nh_agents set name='Aria Updated' where id=$1", [agent.id]);
      const published = (await db.query("select * from nh_agent_versions where agent_id=$1", [agent.id])).rows[0];
      assert.equal(published.definition.name, "Aria");
      assert.deepEqual(published.definition.responsibilities, ["Review orders"]);
      await assert.rejects(db.query("update nh_agent_versions set definition='{}' where id=$1", [published.id]), { code: "42501" });
    });
  });

  await t.test("team placement is tied to the same department and workspace", async () => {
    await asUser(ownerA, async () => {
      const team = (await db.query("insert into nh_teams(workspace_id,department_id,name) values ($1,$2,'Accounts team') returning id", [workspaceA, departmentA])).rows[0];
      await db.query("update nh_agents set team_id=$1 where id=$2", [team.id, agent.id]);
      const other = (await db.query("select id from nh_departments where workspace_id=$1 and id<>$2 limit 1", [workspaceA, departmentA])).rows[0];
      await assert.rejects(db.query("update nh_agents set department_id=$1 where id=$2", [other.id, agent.id]), { code: "23503" });
      await db.query("update nh_agents set department_id=$1,team_id=null where id=$2", [other.id, agent.id]);
      const moved = (await db.query("select * from nh_agents where id=$1", [agent.id])).rows[0];
      assert.equal(moved.department_id, other.id);
      assert.equal(moved.team_id, null);
    });
    assert.notEqual(departmentB, departmentA);
  });

  await t.test("anonymous users have no table access or workspace creation permission", async () => {
    await db.exec("set role anon");
    try {
      await assert.rejects(db.query("select * from nh_agents"), { code: "42501" });
      await assert.rejects(db.query("select nh_create_workspace('Unauthorized')"), { code: "42501" });
    } finally { await db.exec("reset role"); }
  });
});
