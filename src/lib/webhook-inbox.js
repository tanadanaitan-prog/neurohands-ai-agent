const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const eventContext = new AsyncLocalStorage();
const currentWebhookEventId = () => eventContext.getStore()?.eventId || null;

// Classify failures without exposing URLs, keys, message contents or provider bodies.
function failureCode(error) {
  if (error?.name === 'TimeoutError') return 'request_timeout';
  if (error?.name === 'AbortError') return 'request_aborted';
  const line = /^LINE (reply|push|menu link) rejected \(([1-5][0-9]{2})\)$/.exec(error?.message || '');
  if (line) return `line_${line[1].replaceAll(' ', '_')}_${line[2]}`;
  if (error?.message === 'Database operation failed') return 'database_request_failed';
  if (error?.message === 'Database write was not confirmed') return 'database_write_unconfirmed';
  if (error?.message === 'Agent execution failed; response delivery was recorded') return 'agent_failed_response_delivered';
  if (error?.name === 'SyntaxError') return 'invalid_json';
  const code = error?.cause?.code || error?.code;
  if (['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET'].includes(code)) return code.toLowerCase();
  if (error?.message === 'fetch failed') return 'network_request_failed';
  return 'unclassified_failure';
}

function encryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('A private 32-byte base64 WEBHOOK_ENCRYPTION_KEY is required');
  const key=Buffer.from(value,'base64');
  if(key.length!==32)throw new Error('Invalid webhook encryption key');
  return key;
}
function encryptEvent(event, key) {
  const nonce=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(event.webhookEventId));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(event),'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64');
}
function decryptEvent(row,key) {
  const bytes=Buffer.from(row.payload_ciphertext || '','base64');
  if(bytes.length<29)throw new Error('Invalid encrypted payload');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(row.event_id));
  decipher.setAuthTag(bytes.subarray(12,28));
  const event=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  if(event.webhookEventId!==row.event_id)throw new Error('Event identity mismatch');
  return event;
}

function createWebhookInbox({db,handleEvent,keyValue,logger=console}) {
  const workerId=crypto.randomUUID();
  let timer=null, stopped=true, running=false, currentRun=null;
  async function accept(events) {
    if(!Array.isArray(events) || events.length>100)throw new Error('Invalid event batch');
    if(!events.length)return [];
    const key=encryptionKey(keyValue);
    const rows=events.map(event=>{
      if(!event || !/^[A-Za-z0-9_-]{1,128}$/.test(event.webhookEventId || '') || typeof event.type!=='string' || event.type.length>64 || !Number.isSafeInteger(event.timestamp) || event.timestamp<=0)throw new Error('Invalid LINE event');
      const source=event.source || {};
      const sourceKey=String(source.type || 'system')+':'+String(source.groupId || source.roomId || source.userId || event.webhookEventId);
      return {event_id:event.webhookEventId,event_type:event.type,source_key:sourceKey,message_id:event.message?.id || null,payload_ciphertext:encryptEvent(event,key),occurred_at:new Date(event.timestamp).toISOString()};
    });
    const saved=await db('rpc/nh_accept_line_events',{method:'POST',body:{p_events:rows}});
    const ids=new Set((saved || []).map(row=>row.event_id));
    if(rows.some(row=>!ids.has(row.event_id)))throw new Error('Event persistence was not confirmed');
    return saved;
  }
  const filter=row=>`line_webhook_events?event_id=eq.${encodeURIComponent(row.event_id)}&status=eq.processing&worker_id=eq.${workerId}`;
  async function runOnce() {
    const key=encryptionKey(keyValue);
    const row=(await db('rpc/nh_claim_line_event',{method:'POST',body:{p_worker:workerId}}))?.[0];
    if(!row)return false;
    const startedAt=performance.now();
    const heartbeat=setInterval(()=>{
      db(filter(row),{method:'PATCH',headers:{Prefer:'return=representation'},body:{lease_expires_at:new Date(Date.now()+90000).toISOString(),updated_at:new Date().toISOString()}})
        .then(saved=>{if(!saved?.length)logger.error('Webhook lease is no longer owned');})
        .catch(()=>logger.error('Webhook lease renewal failed'));
    },25000);
    heartbeat.unref?.();
    let status='completed', failure=null, stage='decrypt';
    try {
      const event=decryptEvent(row,key);
      stage='handler';
      await eventContext.run({eventId:row.event_id},()=>handleEvent(event));
    }
    catch(error) {
      status='failed';
      failure=stage==='decrypt'?'payload_decryption_failed':failureCode(error);
      logger.error('Webhook handler failed; encrypted input retained for review', {
        eventId:row.event_id,stage,failure,elapsedMs:Math.round(performance.now()-startedAt),
      });
    }
    finally {clearInterval(heartbeat);}
    const saved=await db(filter(row),{method:'PATCH',headers:{Prefer:'return=representation'},body:{status,error:status==='failed'?`Handler failed (${failure}); inspect run and delivery evidence before retrying`:null,updated_at:new Date().toISOString(),lease_expires_at:null,...(status==='completed'?{payload_ciphertext:null}:{})}});
    if(!saved?.[0]?.event_id)throw new Error('Webhook completion was not persisted; do not replay blindly');
    logger.info?.('Webhook processing finished',{eventId:row.event_id,status,elapsedMs:Math.round(performance.now()-startedAt)});
    return true;
  }
  async function tick() {
    if(stopped || running)return;
    running=true;
    let handled=false;
    try {handled=await runOnce();}catch(error){logger.error('Webhook worker could not confirm progress',{failure:failureCode(error)});}
    finally {
      running=false;
      if(!stopped){timer=setTimeout(()=>{currentRun=tick();},handled?10:2000);timer.unref?.();}
    }
  }
  function wake() {if(stopped || running)return;clearTimeout(timer);currentRun=tick();}
  function start(){encryptionKey(keyValue);if(!stopped)return;stopped=false;wake();}
  async function stop(){stopped=true;clearTimeout(timer);await currentRun;}
  return {accept,runOnce,start,wake,stop,workerId};
}
module.exports={createWebhookInbox,currentWebhookEventId,encryptionKey};
