const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

test('Phase 1 recovery and activation transaction in isolated PostgreSQL', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/legacy-schema.sql'),'utf8'));
  await db.exec("insert into glass_types(product_code,family,glass_name,price_per_sqft,measure_base) values ('LOCAL-SKU','decorative_interior','Test glass',157.43,'sqft'); insert into messages(line_user_id,direction,text_content,answered_by,status) values ('local-fixture','in','Keep this exact text','bot','sent'); insert into settings values ('richmenu_public_id','local-menu-only');");
  const before = (await db.query('select to_jsonb(g) as record from glass_types g')).rows[0].record;
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260907123525_phase1_gateway_recovery.sql'),'utf8'));
  const knc = (await db.query("select id from client_accounts where client_code='KNC'")).rows[0].id;
  const other = (await db.query("insert into client_accounts(client_code,company) values ('OTH','Other fixture') returning id")).rows[0].id;
  const hash = code => crypto.createHash('sha256').update(code).digest('hex');
  let counter=0;
  async function issue(account=knc, options={}) {
    const code='LOCAL-NONPRODUCTION-' + (++counter);
    const row=(await db.query('insert into activation_codes(code_hash,code_hint,client_account_id,department,created_by,max_uses,expires_at,status) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
      [hash(code),'fixture-only',account,options.department || 'sales','local-founder',options.maxUses || 1,options.expires || '2099-01-01',options.status || 'active'])).rows[0];
    return {id:row.id,code};
  }
  const redeem = async(user,code) => (await db.query('select * from nh_activate_client($1,$2)',[user,hash(code)])).rows[0];

  await t.test('legacy rows, menu identifiers and all original constraints survive the additive change', async () => {
    assert.deepEqual((await db.query('select to_jsonb(g) as record from glass_types g')).rows[0].record,before);
    assert.equal((await db.query('select text_content from messages')).rows[0].text_content,'Keep this exact text');
    assert.equal((await db.query("select value from settings where key='richmenu_public_id'")).rows[0].value,'local-menu-only');
    await assert.rejects(db.query("insert into clients(line_user_id,price_tier) values ('bad-tier','unrestricted')"),{code:'23514'});
    await db.query("insert into messages(direction,status,answered_by) values ('in','received','agent:AGT-001')");
    assert.equal((await db.query("select callsign from agent_registry where agent_code='AGT-001'")).rows[0].callsign,'Aria');
  });
  await t.test('browser roles cannot read bot records, truncate tables, or redeem/claim through privileged RPCs',async()=>{
    for(const role of ['anon','authenticated']) {
      await db.exec('set role '+role);
      try {
        await assert.rejects(db.query('select * from client_documents'),{code:'42501'});
        await assert.rejects(db.query('truncate glass_types'),{code:'42501'});
        await assert.rejects(db.query("select * from nh_activate_client('local-user',repeat('a',64))"),{code:'42501'});
        await assert.rejects(db.query("select * from nh_claim_note(1,'local-founder')"),{code:'42501'});
      } finally {await db.exec('reset role');}
    }
  });
  await t.test('one code creates client, binding, usage and audit together; replay does not consume another use',async()=>{
    const c=await issue();
    await db.exec('set role service_role');
    try { assert.equal((await redeem('local-owner',c.code)).ok,true); assert.equal((await redeem('local-owner',c.code)).ok,true); }
    finally {await db.exec('reset role');}
    assert.equal((await db.query('select used_count from activation_codes where id=$1',[c.id])).rows[0].used_count,1);
    assert.equal((await db.query("select count(*)::int n from client_agent_bindings where line_user_id='local-owner'")).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from jarvis_audit_log where line_user_id='local-owner'")).rows[0].n,1);
    assert.equal((await redeem('second-user',c.code)).ok,false);
  });
  await t.test('parallel redemption submissions cannot exceed a one-use code',async()=>{
    // PGlite serializes connections; the function's locks also protect multi-connection PostgreSQL.
    const c=await issue();
    const results=await Promise.all(Array.from({length:12},(_,i)=>redeem('competing-user-'+i,c.code)));
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal((await db.query('select used_count from activation_codes where id=$1',[c.id])).rows[0].used_count,1);
  });
  await t.test('a failed audit insert rolls the entire activation back',async()=>{
    const c=await issue();
    await db.exec("create function fail_test_audit() returns trigger language plpgsql as $$begin raise exception 'injected audit failure'; end$$; create trigger fail_audit before insert on jarvis_audit_log for each row execute function fail_test_audit();");
    await assert.rejects(redeem('rollback-user',c.code),/injected audit failure/);
    assert.equal((await db.query("select count(*)::int n from clients where line_user_id='rollback-user'")).rows[0].n,0);
    assert.equal((await db.query('select used_count from activation_codes where id=$1',[c.id])).rows[0].used_count,0);
    await db.exec('drop trigger fail_audit on jarvis_audit_log; drop function fail_test_audit();');
    assert.equal((await redeem('rollback-user',c.code)).ok,true);
  });
  await t.test('expired/revoked codes and disabled accounts cannot activate',async()=>{
    const expired=await issue(knc,{expires:'2000-01-01'}),revoked=await issue(knc,{status:'revoked'}),disabled=await issue(other);
    assert.equal((await redeem('expired-user',expired.code)).ok,false);
    assert.equal((await redeem('revoked-user',revoked.code)).ok,false);
    await db.query('update client_accounts set active=false where id=$1',[other]);
    assert.equal((await redeem('disabled-user',disabled.code)).ok,false);
    await db.query('update client_accounts set active=true where id=$1',[other]);
  });
  await t.test('codes cannot overwrite another tenant or restore a revoked binding',async()=>{
    const c=await issue(other,{department:'finance'});
    assert.equal((await redeem('local-owner',c.code)).ok,false);
    assert.equal((await db.query("select client_account_id from clients where line_user_id='local-owner'")).rows[0].client_account_id,knc);
    await db.exec("update client_agent_bindings set status='revoked' where line_user_id='local-owner'");
    const fresh=await issue();
    assert.equal((await redeem('local-owner',fresh.code)).ok,false);
    assert.equal((await db.query('select used_count from activation_codes where id=$1',[fresh.id])).rows[0].used_count,0);
  });
  await t.test('approval claims require the proposer and execute at most once',async()=>{
    const id=(await db.query("insert into jarvis_notes(content,category,proposed_by) values ('Local proposal','general','operator-a') returning id")).rows[0].id;
    assert.equal((await db.query('select * from nh_claim_note($1,$2)',[id,'operator-b'])).rows.length,0);
    const results=await Promise.all([db.query('select * from nh_claim_note($1,$2)',[id,'operator-a']),db.query('select * from nh_claim_note($1,$2)',[id,'operator-a'])]);
    assert.equal(results.reduce((n,r)=>n+r.rows.length,0),1);
    assert.equal((await db.query('select status from jarvis_notes where id=$1',[id])).rows[0].status,'executing');
  });
});
