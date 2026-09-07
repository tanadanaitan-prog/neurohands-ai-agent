-- Durable, encrypted LINE intake. Failed/uncertain work is reviewed before replay.
create table public.line_webhook_events (
  event_id text primary key check (event_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  event_type text not null, source_key text not null, message_id text,
  payload_ciphertext text, occurred_at timestamptz not null,
  status text not null default 'received' check (status in ('received','processing','completed','failed','uncertain')),
  attempts integer not null default 0, worker_id uuid, lease_expires_at timestamptz,
  error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index line_events_pending_idx on public.line_webhook_events(created_at,event_id) where status='received';
create index line_events_lease_idx on public.line_webhook_events(lease_expires_at) where status='processing';
create unique index line_events_one_source_worker_idx on public.line_webhook_events(source_key) where status='processing';
alter table public.line_webhook_events enable row level security;
revoke all on public.line_webhook_events from public, anon, authenticated;
grant select, insert, update on public.line_webhook_events to service_role;
alter table public.agent_runs add column webhook_event_id text references public.line_webhook_events(event_id);
create index agent_runs_webhook_idx on public.agent_runs(webhook_event_id);

create function public.nh_accept_line_events(p_events jsonb)
returns table(event_id text, status text)
language plpgsql security definer set search_path='' as $function$
declare v jsonb;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'Invalid event batch'; end if;
  if jsonb_array_length(p_events) > 100 then raise exception 'Invalid event batch'; end if;
  for v in select value from jsonb_array_elements(p_events) loop
    if v->>'payload_ciphertext' is null or length(v->>'payload_ciphertext') not between 32 and 200000
      or coalesce(length(v->>'source_key'),0) not between 1 and 256 or coalesce(length(v->>'event_type'),0) not between 1 and 64 then
      raise exception 'Invalid encrypted event';
    end if;
    insert into public.line_webhook_events(event_id,event_type,source_key,message_id,payload_ciphertext,occurred_at)
    values(v->>'event_id',v->>'event_type',v->>'source_key',v->>'message_id',v->>'payload_ciphertext',(v->>'occurred_at')::timestamptz)
    on conflict on constraint line_webhook_events_pkey do nothing;
  end loop;
  return query select e.event_id,e.status from public.line_webhook_events e
    where e.event_id in (select value->>'event_id' from jsonb_array_elements(p_events));
end $function$;
revoke all on function public.nh_accept_line_events(jsonb) from public, anon, authenticated;
grant execute on function public.nh_accept_line_events(jsonb) to service_role;

create function public.nh_claim_line_event(p_worker uuid)
returns setof public.line_webhook_events
language plpgsql security definer set search_path='' as $function$
declare v_id text;
begin
  if p_worker is null then raise exception 'Worker identity required'; end if;
  -- A crashed worker may have caused side effects. Never blindly execute it again.
  update public.line_webhook_events set status='uncertain',error='Worker lease expired; inspect evidence before retrying',updated_at=now()
    where status='processing' and lease_expires_at < now();
  select e.event_id into v_id from public.line_webhook_events e
    where e.status='received' and not exists(select 1 from public.line_webhook_events busy where busy.source_key=e.source_key and busy.status='processing')
    order by e.created_at,e.event_id for update skip locked limit 1;
  if v_id is null then return; end if;
  return query update public.line_webhook_events set status='processing',worker_id=p_worker,
    attempts=attempts+1,lease_expires_at=now()+interval '90 seconds',updated_at=now()
    where event_id=v_id returning *;
end $function$;
revoke all on function public.nh_claim_line_event(uuid) from public, anon, authenticated;
grant execute on function public.nh_claim_line_event(uuid) to service_role;
notify pgrst,'reload schema';
