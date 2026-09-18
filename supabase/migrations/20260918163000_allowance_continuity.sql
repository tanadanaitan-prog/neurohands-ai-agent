-- Durable, least-privilege evidence for allowance alerts and hard-limit
-- continuity decisions. The application may use only the three RPCs below;
-- even service_role has no direct table privileges.

create table public.nh_allowance_alerts (
  alert_key text primary key
    check (alert_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  fingerprint text not null
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  kind text not null
    check (kind in ('threshold', 'hard_limit')),
  action_key text not null
    check (action_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  destination_digest text not null
    check (destination_digest ~ '^[0-9a-f]{64}$'),
  allowance jsonb not null
    check (pg_catalog.jsonb_typeof(allowance) = 'object'),
  policy_version text not null
    check (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  approval_ref text not null
    check (approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  claim_id uuid not null unique default gen_random_uuid(),
  state text not null default 'claimed'
    check (state in ('claimed', 'delivered', 'failed', 'uncertain')),
  receipt_digest text
    check (receipt_digest is null or receipt_digest ~ '^[0-9a-f]{64}$'),
  failure_code text
    check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  claimed_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint nh_allowance_alerts_state_shape check (
    (state = 'claimed' and receipt_digest is null and failure_code is null and finished_at is null)
    or
    (state = 'delivered' and receipt_digest is not null and failure_code is null and finished_at is not null)
    or
    (state in ('failed', 'uncertain') and receipt_digest is null and failure_code is not null and finished_at is not null)
  )
);

comment on table public.nh_allowance_alerts is
  'One durable claim and terminal outcome for each founder allowance-alert episode.';

create table public.nh_allowance_continuity_events (
  event_key text primary key
    check (event_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  fingerprint text not null
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  action_key text not null
    check (action_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  reason_code text not null
    check (reason_code = 'CONTINUITY_HARD_LIMIT'),
  completed boolean not null
    check (completed = false),
  allowance jsonb not null
    check (pg_catalog.jsonb_typeof(allowance) = 'object'),
  response_code text not null
    check (response_code = 'STATIC_CONTINUITY_RESPONSE'),
  response_digest text not null
    check (response_digest ~ '^[0-9a-f]{64}$'),
  policy_version text not null
    check (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  approval_ref text not null
    check (approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

comment on table public.nh_allowance_continuity_events is
  'Idempotent evidence that a hard-limit request was not completed and received the approved static response.';

alter table public.nh_allowance_alerts enable row level security;
alter table public.nh_allowance_continuity_events enable row level security;

revoke all on table public.nh_allowance_alerts
  from public, anon, authenticated, service_role;
revoke all on table public.nh_allowance_continuity_events
  from public, anon, authenticated, service_role;

create or replace function public.nh_claim_allowance_alert(
  p_alert_key text,
  p_fingerprint text,
  p_kind text,
  p_action_key text,
  p_destination_digest text,
  p_allowance jsonb,
  p_policy_version text,
  p_approval_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert public.nh_allowance_alerts%rowtype;
begin
  if p_alert_key is null or p_alert_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_kind is null or p_kind not in ('threshold', 'hard_limit')
    or p_action_key is null or p_action_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_destination_digest is null or p_destination_digest !~ '^[0-9a-f]{64}$'
    or p_policy_version is null or p_policy_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_approval_ref is null or p_approval_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_allowance is null or pg_catalog.jsonb_typeof(p_allowance) <> 'object'
    or not (p_allowance ?& array['poolId', 'remaining', 'unit', 'verifiedAt', 'evidenceRef', 'resetAt', 'resetEvidenceRef'])
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_allowance)) <> 7
    or pg_catalog.jsonb_typeof(p_allowance->'remaining') <> 'number'
    or (p_allowance->>'remaining') !~ '^(0|[1-9][0-9]{0,15})$'
    or pg_catalog.jsonb_typeof(p_allowance->'poolId') <> 'string'
    or (p_allowance->>'poolId') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or pg_catalog.jsonb_typeof(p_allowance->'unit') <> 'string'
    or (p_allowance->>'unit') !~ '^[A-Za-z][A-Za-z0-9 _.-]{0,31}$'
    or pg_catalog.jsonb_typeof(p_allowance->'verifiedAt') <> 'string'
    or pg_catalog.length(p_allowance->>'verifiedAt') > 64
    or pg_catalog.jsonb_typeof(p_allowance->'evidenceRef') <> 'string'
    or (p_allowance->>'evidenceRef') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or not ((p_allowance->'resetAt' = 'null'::jsonb) or pg_catalog.jsonb_typeof(p_allowance->'resetAt') = 'string')
    or not ((p_allowance->'resetEvidenceRef' = 'null'::jsonb) or pg_catalog.jsonb_typeof(p_allowance->'resetEvidenceRef') = 'string')
    or (p_allowance->>'resetAt' is null and p_allowance->>'resetEvidenceRef' is null)
    or (p_kind = 'hard_limit' and p_allowance->>'remaining' <> '0')
  then
    raise exception using errcode = '22023', message = 'Invalid allowance alert claim';
  end if;

  insert into public.nh_allowance_alerts (
    alert_key, fingerprint, kind, action_key, destination_digest,
    allowance, policy_version, approval_ref
  ) values (
    p_alert_key, p_fingerprint, p_kind, p_action_key, p_destination_digest,
    p_allowance, p_policy_version, p_approval_ref
  )
  on conflict (alert_key) do nothing
  returning * into v_alert;

  if found then
    return pg_catalog.jsonb_build_object(
      'state', 'claimed', 'new_claim', true,
      'claim_id', v_alert.claim_id, 'fingerprint', v_alert.fingerprint
    );
  end if;

  select a.* into v_alert
  from public.nh_allowance_alerts as a
  where a.alert_key = p_alert_key
  for update;

  if v_alert.fingerprint <> p_fingerprint then
    return pg_catalog.jsonb_build_object(
      'state', 'conflict', 'new_claim', false,
      'claim_id', null, 'fingerprint', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'state', v_alert.state, 'new_claim', false,
    'claim_id', v_alert.claim_id, 'fingerprint', v_alert.fingerprint
  );
end;
$$;

create or replace function public.nh_finish_allowance_alert(
  p_claim_id uuid,
  p_fingerprint text,
  p_state text,
  p_failure_code text default null,
  p_receipt_digest text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert public.nh_allowance_alerts%rowtype;
begin
  if p_claim_id is null
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_state is null or p_state not in ('delivered', 'failed', 'uncertain')
    or (p_state = 'delivered' and (
      p_receipt_digest is null or p_receipt_digest !~ '^[0-9a-f]{64}$' or p_failure_code is not null
    ))
    or (p_state in ('failed', 'uncertain') and (
      p_failure_code is null or p_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' or p_receipt_digest is not null
    ))
  then
    raise exception using errcode = '22023', message = 'Invalid allowance alert finish';
  end if;

  select a.* into v_alert
  from public.nh_allowance_alerts as a
  where a.claim_id = p_claim_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('recorded', false, 'state', 'conflict');
  end if;
  if v_alert.fingerprint <> p_fingerprint then
    return pg_catalog.jsonb_build_object('recorded', false, 'state', 'conflict');
  end if;

  if v_alert.state <> 'claimed' then
    if v_alert.state = p_state
      and (p_state <> 'delivered' or v_alert.receipt_digest = p_receipt_digest)
      and (p_state = 'delivered' or v_alert.failure_code = p_failure_code)
    then
      return pg_catalog.jsonb_build_object('recorded', true, 'state', v_alert.state);
    end if;
    return pg_catalog.jsonb_build_object('recorded', false, 'state', v_alert.state);
  end if;

  update public.nh_allowance_alerts as a
  set state = p_state,
      receipt_digest = p_receipt_digest,
      failure_code = p_failure_code,
      finished_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where a.claim_id = p_claim_id
    and a.fingerprint = p_fingerprint
    and a.state = 'claimed';

  return pg_catalog.jsonb_build_object('recorded', true, 'state', p_state);
end;
$$;

create or replace function public.nh_record_allowance_continuity_event(
  p_event_key text,
  p_fingerprint text,
  p_action_key text,
  p_reason_code text,
  p_completed boolean,
  p_allowance jsonb,
  p_response_code text,
  p_response_digest text,
  p_policy_version text,
  p_approval_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.nh_allowance_continuity_events%rowtype;
begin
  if p_event_key is null or p_event_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_action_key is null or p_action_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_reason_code is distinct from 'CONTINUITY_HARD_LIMIT'
    or p_completed is distinct from false
    or p_allowance is null or pg_catalog.jsonb_typeof(p_allowance) <> 'object'
    or p_response_code is distinct from 'STATIC_CONTINUITY_RESPONSE'
    or p_response_digest is null or p_response_digest !~ '^[0-9a-f]{64}$'
    or p_policy_version is null or p_policy_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
    or p_approval_ref is null or p_approval_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$'
  then
    raise exception using errcode = '22023', message = 'Invalid allowance continuity event';
  end if;

  insert into public.nh_allowance_continuity_events (
    event_key, fingerprint, action_key, reason_code, completed, allowance,
    response_code, response_digest, policy_version, approval_ref
  ) values (
    p_event_key, p_fingerprint, p_action_key, p_reason_code, p_completed, p_allowance,
    p_response_code, p_response_digest, p_policy_version, p_approval_ref
  )
  on conflict (event_key) do nothing
  returning * into v_event;

  if found then
    return pg_catalog.jsonb_build_object('recorded', true, 'conflict', false, 'idempotent', false);
  end if;

  select e.* into v_event
  from public.nh_allowance_continuity_events as e
  where e.event_key = p_event_key
  for update;

  if v_event.fingerprint = p_fingerprint then
    return pg_catalog.jsonb_build_object('recorded', true, 'conflict', false, 'idempotent', true);
  end if;
  return pg_catalog.jsonb_build_object('recorded', false, 'conflict', true, 'idempotent', false);
end;
$$;

revoke all on function public.nh_claim_allowance_alert(text, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.nh_finish_allowance_alert(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.nh_record_allowance_continuity_event(text, text, text, text, boolean, jsonb, text, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.nh_claim_allowance_alert(text, text, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function public.nh_finish_allowance_alert(uuid, text, text, text, text)
  to service_role;
grant execute on function public.nh_record_allowance_continuity_event(text, text, text, text, boolean, jsonb, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';
