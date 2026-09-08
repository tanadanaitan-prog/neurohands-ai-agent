const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createWebhookInbox, currentWebhookEventId } = require('../src/lib/webhook-inbox');

test('encrypted LINE inbox and recovery in isolated PostgreSQL', async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  for (const file of ['fixtures/legacy-schema.sql','../supabase/migrations/20260907123525_phase1_gateway_recovery.sql','../supabase/migrations/20260907130303_phase1_webhook_inbox.sql']) {
    await pg.exec(fs.readFileSync(path.join(__dirname,file),'utf8'));
  }
  const keyValue = crypto.randomBytes(32).toString('base64');
  const logger = { error() {} };
  const input = (id, user='local-user') => ({
    webhookEventId:id, type:'message', timestamp:Date.now(), replyToken:'local-private-reply-token',
    source:{type:'user',userId:user}, message:{id:'local-message-'+id,type:'text',text:'CONFIDENTIAL-LOCAL-FIXTURE'},
  });
  const row = async id => (await pg.query('select * from line_webhook_events where event_id=$1',[id])).rows[0];
  const adapter = async (route, options={}) => {
    if(route==='rpc/nh_accept_line_events') return (await pg.query('select * from nh_accept_line_events($1::jsonb)',[JSON.stringify(options.body.p_events)])).rows;
    if(route==='rpc/nh_claim_line_event') return (await pg.query('select * from nh_claim_line_event($1::uuid)',[options.body.p_worker])).rows;
    assert.equal(options.method,'PATCH');
    const query=new URL('https://local.invalid/'+route).searchParams;
    const allowed=['status','error','updated_at','lease_expires_at','payload_ciphertext'];
    const fields=Object.keys(options.body);
    assert.ok(fields.every(key=>allowed.includes(key)));
    const values=fields.map(key=>options.body[key]);
    const set=fields.map((key,i)=>key+'=$'+(i+1)).join(',');
    values.push(query.get('event_id').slice(3),query.get('status').slice(3),query.get('worker_id').slice(3));
    return (await pg.query(`update line_webhook_events set ${set} where event_id=$${fields.length+1} and status=$${fields.length+2} and worker_id=$${fields.length+3} returning *`,values)).rows;
  };
  const worker = overrides => createWebhookInbox({db:adapter,handleEvent:async()=>{},keyValue,logger,...overrides});

  await t.test('persist before work; duplicate intake preserves first payload and processing occurs once after restart',async()=>{
    const first=worker();
    const event=input('restart-1');
    await first.accept([event]);
    const stored=await row(event.webhookEventId);
    assert.equal(stored.status,'received');
    assert.equal(stored.attempts,0);
    assert.equal(stored.payload_ciphertext.includes(event.message.text),false);
    assert.equal(stored.payload_ciphertext.includes(event.replyToken),false);
    assert.equal(Buffer.from(stored.payload_ciphertext,'base64').includes(Buffer.from(event.message.text)),false);
    await first.accept([{...event,deliveryContext:{isRedelivery:true}}]);
    assert.equal((await row(event.webhookEventId)).payload_ciphertext,stored.payload_ciphertext);
    let calls=0;
    const restarted=worker({handleEvent:async recovered=>{
      calls++;
      assert.deepEqual(recovered,event);
      assert.equal(currentWebhookEventId(),event.webhookEventId);
      assert.equal((await row(event.webhookEventId)).status,'processing');
    }});
    assert.equal(await restarted.runOnce(),true);
    assert.equal(await restarted.runOnce(),false);
    assert.equal(calls,1);
    assert.equal(currentWebhookEventId(),null);
    assert.equal((await row(event.webhookEventId)).status,'completed');
    assert.equal((await row(event.webhookEventId)).payload_ciphertext,null);
    await first.accept([event]);
    assert.equal(await restarted.runOnce(),false);
  });
  await t.test('an intake batch is atomic when any later event is invalid',async()=>{
    const capture=[];
    await worker({db:async(route,opts)=>{capture.push(opts.body.p_events[0]); return [{event_id:'batch-valid'}];}}).accept([input('batch-valid')]);
    const valid=capture[0];
    await assert.rejects(pg.query('select * from nh_accept_line_events($1::jsonb)',[JSON.stringify([valid,{...valid,event_id:'invalid id'}])]),{code:'23514'});
    assert.equal(await row('batch-valid'),undefined);
    await assert.rejects(pg.query('select * from nh_accept_line_events(null)'),/Invalid event batch/);
    await assert.rejects(pg.query("select * from nh_accept_line_events('{}'::jsonb)"),/Invalid event batch/);
  });
  await t.test('missing key or missing database receipt does not acknowledge intake',async()=>{
    await assert.rejects(worker({keyValue:''}).accept([input('missing-key')]),/encryption/i);
    await assert.rejects(worker({db:async()=>[]}).accept([input('missing-receipt')]),/not confirmed/);
    assert.equal(await row('missing-key'),undefined);
  });
  await t.test('handler failure retains encrypted input and is never automatically replayed',async()=>{
    let calls=0;
    const logs=[];
    const w=worker({logger:{error:(...args)=>logs.push(args)},handleEvent:async()=>{calls++;throw new Error('private error text');}});
    await w.accept([input('handler-failure')]);
    assert.equal(await w.runOnce(),true);
    assert.equal((await row('handler-failure')).status,'failed');
    assert.ok((await row('handler-failure')).payload_ciphertext);
    assert.equal((await row('handler-failure')).error.includes('private error text'),false);
    assert.equal(JSON.stringify(logs).includes('private error text'),false);
    assert.equal(logs[0][1].failure,'unclassified_failure');
    await w.accept([input('handler-failure')]);
    assert.equal(await w.runOnce(),false);
    assert.equal(calls,1);
  });
  await t.test('timeouts and LINE delivery failures retain useful diagnostics without raw error details',async()=>{
    for(const [id,error,expected] of [
      ['diagnostic-timeout',new DOMException('secret-bearing URL and customer text','TimeoutError'),'request_timeout'],
      ['diagnostic-line',new Error('LINE reply rejected (401)'),'line_reply_401'],
      ['diagnostic-network',new TypeError('fetch failed',{cause:{code:'ECONNRESET',message:'private connection details'}}),'econnreset'],
    ]) {
      const logs=[];
      const w=worker({logger:{error:(...args)=>logs.push(args)},handleEvent:async()=>{throw error;}});
      await w.accept([input(id)]);
      await w.runOnce();
      assert.equal((await row(id)).status,'failed');
      assert.ok((await row(id)).error.includes(expected));
      assert.equal(logs[0][1].failure,expected);
      assert.equal(logs[0][1].stage,'handler');
      assert.ok(logs[0][1].elapsedMs>=0);
      assert.doesNotMatch(JSON.stringify(logs),/secret-bearing|customer text|private connection details/);
    }
  });
  await t.test('wrong encryption key and moved ciphertext cannot reach the handler',async()=>{
    let calls=0;
    const w=worker({handleEvent:async()=>{calls++;}});
    await w.accept([input('wrong-key')]);
    await worker({keyValue:crypto.randomBytes(32).toString('base64'),handleEvent:async()=>{calls++;}}).runOnce();
    assert.equal((await row('wrong-key')).status,'failed');
    await w.accept([input('tamper')]);
    await pg.query('update line_webhook_events set payload_ciphertext=$1 where event_id=$2',[(await row('wrong-key')).payload_ciphertext,'tamper']);
    await w.runOnce();
    assert.equal((await row('tamper')).status,'failed');
    assert.equal(calls,0);
  });
  await t.test('only one worker holds a source; another source can progress; expired work becomes uncertain',async()=>{
    const w=worker();
    await w.accept([input('ordered-a','same-user'),input('ordered-b','same-user'),input('ordered-c','another-user')]);
    const claim=async()=> (await adapter('rpc/nh_claim_line_event',{body:{p_worker:crypto.randomUUID()}}))[0];
    assert.equal((await claim()).event_id,'ordered-a');
    assert.equal((await claim()).event_id,'ordered-c');
    assert.equal(await claim(),undefined);
    await pg.query("update line_webhook_events set lease_expires_at=now()-interval '1 second' where event_id='ordered-a'");
    assert.equal((await claim()).event_id,'ordered-b');
    assert.equal((await row('ordered-a')).status,'uncertain');
    assert.equal((await row('ordered-a')).attempts,1);
    await pg.query("update line_webhook_events set status='completed',payload_ciphertext=null where event_id in ('ordered-b','ordered-c')");
  });
  await t.test('lost completion receipt cannot trigger a duplicate side effect after lease expiry',async()=>{
    let calls=0;
    const w=worker({handleEvent:async()=>{calls++;},db:async(route,options)=>{
      if(options.method==='PATCH' && options.body.status)throw new Error('Injected completion outage');
      return adapter(route,options);
    }});
    await w.accept([input('completion-outage')]);
    await assert.rejects(w.runOnce(),/Injected completion outage/);
    assert.equal((await row('completion-outage')).status,'processing');
    await pg.query("update line_webhook_events set lease_expires_at=now()-interval '1 second' where event_id='completion-outage'");
    assert.equal(await w.runOnce(),false);
    assert.equal((await row('completion-outage')).status,'uncertain');
    assert.equal(calls,1);
  });
  await t.test('browser roles cannot read queue payloads or invoke service-only RPCs',async()=>{
    for(const role of ['anon','authenticated']) {
      await pg.exec('set role '+role);
      try {
        await assert.rejects(pg.query('select * from line_webhook_events'),{code:'42501'});
        await assert.rejects(pg.query("select * from nh_accept_line_events('[]'::jsonb)"),{code:'42501'});
        await assert.rejects(pg.query('select * from nh_claim_line_event($1)',[crypto.randomUUID()]),{code:'42501'});
      } finally {await pg.exec('reset role');}
    }
    await pg.exec('set role service_role');
    try {await worker().accept([input('service-permission')]); await worker().runOnce();}
    finally {await pg.exec('reset role');}
    assert.equal((await row('service-permission')).status,'completed');
  });
});
