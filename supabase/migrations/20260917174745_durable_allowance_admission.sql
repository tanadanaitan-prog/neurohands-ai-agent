-- Staged durable admission ledger for shared, externally metered allowances.
-- This migration is intentionally not wired into the production request path.
-- Apply only after founder review and an isolated restore test.

create table public.nh_allowance_pools (
  pool_id text primary key,
  unit_name text not null,
  allowance_status text not null,
  verified_limit_units bigint,
  remaining_units bigint,
  alert_threshold_units bigint,
  reset_at timestamptz,
  evidence_ref text,
  allowance_epoch uuid not null default gen_random_uuid(),
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint nh_allowance_pools_pool_id_check
    check (pool_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  constraint nh_allowance_pools_unit_name_check
    check (unit_name ~ '^[a-z][a-z0-9._-]{0,63}$'),
  constraint nh_allowance_pools_status_check
    check (allowance_status in ('unknown', 'verified_available', 'verified_exhausted')),
  constraint nh_allowance_pools_state_check
    check (
      (allowance_status = 'unknown'
        and verified_limit_units is null
        and remaining_units is null)
      or
      (allowance_status = 'verified_available'
        and verified_limit_units is not null
        and verified_limit_units > 0
        and remaining_units is not null
        and remaining_units > 0
        and remaining_units <= verified_limit_units)
      or
      (allowance_status = 'verified_exhausted'
        and verified_limit_units is not null
        and verified_limit_units >= 0
        and remaining_units = 0)
    ),
  constraint nh_allowance_pools_alert_check
    check (
      alert_threshold_units is null
      or (
        verified_limit_units is not null
        and alert_threshold_units >= 0
        and alert_threshold_units <= verified_limit_units
      )
    ),
  constraint nh_allowance_pools_version_check check (version > 0),
  constraint nh_allowance_pools_evidence_ref_check
    check (evidence_ref is null or length(btrim(evidence_ref)) between 1 and 500)
);

create table public.nh_allowance_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_digest text not null,
  workload text not null,
  actor_id text not null,
  operation text not null,
  state text not null default 'reserved',
  reserved_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  dispatch_key uuid unique,
  dispatched_at timestamptz,
  settlement_key uuid unique,
  settlement_outcome text,
  settled_at timestamptz,
  reconciliation_key uuid unique,
  reconciliation_reason text,
  released_at timestamptz,
  constraint nh_allowance_reservations_idempotency_key_check
    check (length(btrim(idempotency_key)) between 1 and 200),
  constraint nh_allowance_reservations_request_digest_check
    check (request_digest ~ '^[0-9a-f]{64}$'),
  constraint nh_allowance_reservations_workload_check
    check (workload ~ '^[a-z][a-z0-9._:-]{0,63}$'),
  constraint nh_allowance_reservations_actor_check
    check (length(btrim(actor_id)) between 1 and 128),
  constraint nh_allowance_reservations_operation_check
    check (operation ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  constraint nh_allowance_reservations_state_check
    check (state in (
      'reserved', 'dispatched', 'reconciliation_required',
      'settled', 'cancelled', 'reclaimed'
    )),
  constraint nh_allowance_reservations_expiry_check check (expires_at > reserved_at),
  constraint nh_allowance_reservations_dispatch_check
    check (
      (state in ('reserved', 'cancelled', 'reclaimed')
        and dispatch_key is null and dispatched_at is null)
      or
      (state in ('dispatched', 'reconciliation_required', 'settled')
        and dispatch_key is not null and dispatched_at is not null)
    ),
  constraint nh_allowance_reservations_settlement_check
    check (
      (state = 'settled'
        and settlement_key is not null
        and settlement_outcome in ('completed', 'failed_after_dispatch')
        and settled_at is not null
        and released_at is null)
      or
      (state = 'cancelled'
        and settlement_key is not null
        and settlement_outcome = 'cancelled_before_dispatch'
        and settled_at is not null
        and released_at is not null)
      or
      (state not in ('settled', 'cancelled')
        and settlement_key is null
        and settlement_outcome is null
        and settled_at is null)
    ),
  constraint nh_allowance_reservations_reconciliation_check
    check (
      (state = 'reconciliation_required'
        and reconciliation_reason in ('transport_uncertain', 'lease_expired')
        and (
          (reconciliation_reason = 'transport_uncertain' and reconciliation_key is not null)
          or
          (reconciliation_reason = 'lease_expired' and reconciliation_key is null)
        ))
      or
      (state <> 'reconciliation_required'
        and reconciliation_key is null
        and reconciliation_reason is null)
    ),
  constraint nh_allowance_reservations_release_check
    check (
      (state in ('cancelled', 'reclaimed') and released_at is not null)
      or
      (state not in ('cancelled', 'reclaimed') and released_at is null)
    )
);

create index nh_allowance_reservations_reconcile
  on public.nh_allowance_reservations(expires_at, state);

create table public.nh_allowance_reservation_items (
  reservation_id uuid not null
    references public.nh_allowance_reservations(reservation_id),
  pool_id text not null references public.nh_allowance_pools(pool_id),
  allowance_epoch uuid not null,
  action_units bigint not null,
  verification_units bigint not null,
  reserved_units bigint not null,
  actual_units bigint,
  primary key (reservation_id, pool_id),
  constraint nh_allowance_reservation_items_units_check
    check (
      action_units >= 0
      and verification_units >= 0
      and reserved_units > 0
      and reserved_units = action_units + verification_units
    ),
  constraint nh_allowance_reservation_items_actual_check
    check (actual_units is null or actual_units between 0 and reserved_units)
);

create index nh_allowance_reservation_items_pool
  on public.nh_allowance_reservation_items(pool_id, reservation_id);

create or replace function public.nh_guard_allowance_epoch_refresh()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.allowance_epoch <> old.allowance_epoch and exists (
    select 1
    from public.nh_allowance_reservation_items as i
    join public.nh_allowance_reservations as r using (reservation_id)
    where i.pool_id = old.pool_id
      and i.allowance_epoch = old.allowance_epoch
      and r.state in ('dispatched', 'reconciliation_required')
  ) then
    raise exception using
      errcode = '55000',
      message = 'Cannot refresh an allowance epoch with unresolved dispatched work';
  end if;
  return new;
end;
$$;

create trigger nh_allowance_epoch_refresh_guard
before update of allowance_epoch on public.nh_allowance_pools
for each row execute function public.nh_guard_allowance_epoch_refresh();

create table public.nh_admission_audit (
  audit_id bigint generated always as identity primary key,
  event_at timestamptz not null default clock_timestamp(),
  event_type text not null,
  decision_code text not null,
  pool_id text,
  reservation_id uuid,
  actor_id text not null,
  workload text,
  operation text,
  requested_units bigint,
  remaining_units bigint,
  constraint nh_admission_audit_event_type_check
    check (event_type in (
      'reservation_granted', 'reservation_replayed', 'reservation_denied',
      'reservation_dispatched', 'reservation_cancelled', 'reservation_settled',
      'reservation_reclaimed', 'reconciliation_required'
    )),
  constraint nh_admission_audit_decision_code_check
    check (decision_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  constraint nh_admission_audit_actor_check
    check (length(btrim(actor_id)) between 1 and 128),
  constraint nh_admission_audit_requested_units_check
    check (requested_units is null or requested_units > 0),
  constraint nh_admission_audit_remaining_units_check
    check (remaining_units is null or remaining_units >= 0)
);

comment on table public.nh_allowance_pools is
  'Verified shared allowance state. Unknown is represented by NULL units, never by zero.';
comment on table public.nh_allowance_reservations is
  'Durable bundle reservations with idempotent dispatch and terminal state keys.';
comment on table public.nh_allowance_reservation_items is
  'Per-pool action and verification units reserved atomically as one bundle.';
comment on table public.nh_admission_audit is
  'Append-only admission evidence written in the same transaction as each transition.';

alter table public.nh_allowance_pools enable row level security;
alter table public.nh_allowance_pools force row level security;
alter table public.nh_allowance_reservations enable row level security;
alter table public.nh_allowance_reservations force row level security;
alter table public.nh_allowance_reservation_items enable row level security;
alter table public.nh_allowance_reservation_items force row level security;
alter table public.nh_admission_audit enable row level security;
alter table public.nh_admission_audit force row level security;

revoke all on table public.nh_allowance_pools from public, anon, authenticated, service_role;
revoke all on table public.nh_allowance_reservations from public, anon, authenticated, service_role;
revoke all on table public.nh_allowance_reservation_items from public, anon, authenticated, service_role;
revoke all on table public.nh_admission_audit from public, anon, authenticated, service_role;
revoke all on sequence public.nh_admission_audit_audit_id_seq from public, anon, authenticated, service_role;

-- The service role may inspect evidence but cannot fabricate or mutate ledger state.
-- All state transitions cross the narrowly granted SECURITY DEFINER RPC boundary below.
grant select on table public.nh_allowance_pools to service_role;
grant select on table public.nh_allowance_reservations to service_role;
grant select on table public.nh_allowance_reservation_items to service_role;
grant select on table public.nh_admission_audit to service_role;

create or replace function public.nh_allowance_requirements_valid(
  p_requirements jsonb,
  p_allow_zero boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_key text;
  v_seen text[] := array[]::text[];
begin
  if p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then
    return false;
  end if;
  -- One side of a bundle may be empty when that operation has no separate
  -- action or verification charge. The reservation RPC still requires the
  -- combined bundle to contain at least one positive unit.
  if jsonb_array_length(p_requirements) = 0 then return true; end if;

  for v_item in select value from jsonb_array_elements(p_requirements)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or jsonb_typeof(v_item -> 'pool') <> 'string'
      or (v_item ->> 'pool') !~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      or jsonb_typeof(v_item -> 'units') <> 'number'
      or (v_item ->> 'units') !~ (case when p_allow_zero
        then '^(0|[1-9][0-9]*)$' else '^[1-9][0-9]*$' end)
      or (v_item ->> 'pool') = any(v_seen)
    then
      return false;
    end if;
    perform (v_item ->> 'units')::bigint;
    for v_key in select jsonb_object_keys(v_item)
    loop
      if v_key not in ('pool', 'units') then return false; end if;
    end loop;
    v_seen := array_append(v_seen, v_item ->> 'pool');
  end loop;
  return true;
exception when numeric_value_out_of_range then
  return false;
end;
$$;

create or replace function public.nh_merge_allowance_requirements(
  p_action_requirements jsonb,
  p_verification_requirements jsonb
)
returns table (
  pool_id text,
  action_units bigint,
  verification_units bigint,
  reserved_units bigint
)
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $$
  with action as (
    select item ->> 'pool' as pool_id, (item ->> 'units')::bigint as units
    from jsonb_array_elements(p_action_requirements) as items(item)
  ), verification as (
    select item ->> 'pool' as pool_id, (item ->> 'units')::bigint as units
    from jsonb_array_elements(p_verification_requirements) as items(item)
  )
  select coalesce(a.pool_id, v.pool_id), coalesce(a.units, 0),
    coalesce(v.units, 0), coalesce(a.units, 0) + coalesce(v.units, 0)
  from action as a
  full join verification as v using (pool_id)
  order by 1;
$$;

create or replace function public.nh_reject_admission_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception using errcode = '42501', message = 'nh_admission_audit is append-only';
end;
$$;

create trigger nh_admission_audit_append_only
before update or delete on public.nh_admission_audit
for each row execute function public.nh_reject_admission_audit_mutation();

create or replace function public.nh_audit_reservation_event(
  p_reservation_id uuid,
  p_event_type text,
  p_decision_code text,
  p_actor_id text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  insert into public.nh_admission_audit (
    event_type, decision_code, pool_id, reservation_id, actor_id,
    workload, operation, requested_units, remaining_units
  )
  select p_event_type, p_decision_code, i.pool_id, r.reservation_id,
    p_actor_id, r.workload, r.operation, i.reserved_units, p.remaining_units
  from public.nh_allowance_reservations as r
  join public.nh_allowance_reservation_items as i using (reservation_id)
  join public.nh_allowance_pools as p using (pool_id)
  where r.reservation_id = p_reservation_id
  order by i.pool_id;
end;
$$;

create or replace function public.nh_reserve_allowance_bundle(
  p_idempotency_key text,
  p_request_digest text,
  p_workload text,
  p_actor_id text,
  p_operation text,
  p_action_requirements jsonb,
  p_verification_requirements jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_existing public.nh_allowance_reservations%rowtype;
  v_reservation public.nh_allowance_reservations%rowtype;
  v_pool public.nh_allowance_pools%rowtype;
  v_requirement record;
  v_code text;
  v_allowed boolean;
  v_alert boolean := false;
  v_remaining jsonb;
  v_requested jsonb;
  v_stored jsonb;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 200
    or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_workload is null or p_workload !~ '^[a-z][a-z0-9._:-]{0,63}$'
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 128
    or p_operation is null or p_operation !~ '^[a-z][a-z0-9._:-]{0,127}$'
    or not public.nh_allowance_requirements_valid(p_action_requirements, false)
    or not public.nh_allowance_requirements_valid(p_verification_requirements, false)
    or jsonb_array_length(p_action_requirements)
      + jsonb_array_length(p_verification_requirements) = 0
    or p_expires_at is null
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '24 hours'
  then
    raise exception using errcode = '22023', message = 'Invalid allowance bundle request';
  end if;

  -- One transaction-level lock makes the idempotency key deterministic even when
  -- a conflicting retry names a different set of pools.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  select jsonb_agg(jsonb_build_object(
    'pool', m.pool_id,
    'action_units', m.action_units,
    'verification_units', m.verification_units,
    'reserved_units', m.reserved_units
  ) order by m.pool_id) into v_requested
  from public.nh_merge_allowance_requirements(
    p_action_requirements, p_verification_requirements
  ) as m;

  select r.* into v_existing
  from public.nh_allowance_reservations as r
  where r.idempotency_key = p_idempotency_key;

  if found then
    select jsonb_agg(jsonb_build_object(
      'pool', i.pool_id,
      'action_units', i.action_units,
      'verification_units', i.verification_units,
      'reserved_units', i.reserved_units
    ) order by i.pool_id) into v_stored
    from public.nh_allowance_reservation_items as i
    where i.reservation_id = v_existing.reservation_id;
    if v_existing.request_digest <> p_request_digest
      or v_existing.workload <> p_workload
      or v_existing.actor_id <> p_actor_id
      or v_existing.operation <> p_operation
      or v_stored <> v_requested
    then
      v_code := 'IDEMPOTENCY_CONFLICT';
      v_allowed := false;
    elsif v_existing.state = 'reserved' then
      v_code := 'IDEMPOTENT_REPLAY';
      v_allowed := true;
    elsif v_existing.state = 'dispatched' then
      v_code := 'ALREADY_DISPATCHED';
      v_allowed := false;
    elsif v_existing.state = 'settled' then
      v_code := 'ALREADY_SETTLED';
      v_allowed := false;
    elsif v_existing.state = 'reclaimed' then
      v_code := 'RESERVATION_RECLAIMED';
      v_allowed := false;
    elsif v_existing.state = 'cancelled' then
      v_code := 'RESERVATION_CANCELLED';
      v_allowed := false;
    else
      v_code := 'RECONCILIATION_REQUIRED';
      v_allowed := false;
    end if;
    perform public.nh_audit_reservation_event(
      v_existing.reservation_id, 'reservation_replayed', v_code, p_actor_id
    );
    return jsonb_build_object(
      'allowed', v_allowed, 'code', v_code,
      'reservation_id', v_existing.reservation_id, 'replayed', true
    );
  end if;

  -- Pools are locked in a stable order before any debit. A failed check returns
  -- before state changes; an audit failure later rolls the full statement back.
  for v_requirement in
    select * from public.nh_merge_allowance_requirements(
      p_action_requirements, p_verification_requirements
    ) order by pool_id
  loop
    select p.* into v_pool
    from public.nh_allowance_pools as p
    where p.pool_id = v_requirement.pool_id
    for update;

    if not found then
      insert into public.nh_admission_audit (
        event_type, decision_code, pool_id, actor_id, workload,
        operation, requested_units
      ) values (
        'reservation_denied', 'POOL_NOT_FOUND', v_requirement.pool_id,
        p_actor_id, p_workload, p_operation, v_requirement.reserved_units
      );
      return jsonb_build_object(
        'allowed', false, 'code', 'POOL_NOT_FOUND',
        'pool', v_requirement.pool_id, 'reservation_id', null, 'replayed', false
      );
    end if;

    if v_pool.allowance_status = 'unknown' then
      v_code := 'ALLOWANCE_UNKNOWN';
    elsif v_pool.reset_at is not null and v_pool.reset_at <= clock_timestamp() then
      v_code := 'ALLOWANCE_SNAPSHOT_EXPIRED';
    elsif v_pool.reset_at is not null and p_expires_at > v_pool.reset_at then
      v_code := 'ALLOWANCE_LEASE_CROSSES_RESET';
    elsif v_pool.allowance_status = 'verified_exhausted' or v_pool.remaining_units = 0 then
      v_code := 'ALLOWANCE_EXHAUSTED';
    elsif v_pool.remaining_units < v_requirement.reserved_units then
      v_code := 'ALLOWANCE_INSUFFICIENT';
    else
      v_code := null;
    end if;

    if v_code is not null then
      insert into public.nh_admission_audit (
        event_type, decision_code, pool_id, actor_id, workload,
        operation, requested_units, remaining_units
      ) values (
        'reservation_denied', v_code, v_requirement.pool_id, p_actor_id,
        p_workload, p_operation, v_requirement.reserved_units,
        v_pool.remaining_units
      );
      return jsonb_build_object(
        'allowed', false, 'code', v_code, 'pool', v_requirement.pool_id,
        'reservation_id', null, 'remaining_units', v_pool.remaining_units,
        'replayed', false
      );
    end if;

    v_alert := v_alert or (
      v_pool.alert_threshold_units is not null
      and v_pool.remaining_units - v_requirement.reserved_units
        <= v_pool.alert_threshold_units
    );
  end loop;

  insert into public.nh_allowance_reservations (
    idempotency_key, request_digest, workload, actor_id, operation, expires_at
  ) values (
    p_idempotency_key, p_request_digest, p_workload, p_actor_id,
    p_operation, p_expires_at
  ) returning * into v_reservation;

  for v_requirement in
    select * from public.nh_merge_allowance_requirements(
      p_action_requirements, p_verification_requirements
    ) order by pool_id
  loop
    update public.nh_allowance_pools as p
    set remaining_units = p.remaining_units - v_requirement.reserved_units,
        allowance_status = case
          when p.remaining_units - v_requirement.reserved_units = 0
            then 'verified_exhausted'
          else 'verified_available'
        end,
        version = p.version + 1,
        updated_at = clock_timestamp()
    where p.pool_id = v_requirement.pool_id;

    insert into public.nh_allowance_reservation_items (
      reservation_id, pool_id, allowance_epoch,
      action_units, verification_units, reserved_units
    ) values (
      v_reservation.reservation_id, v_requirement.pool_id,
      (select p.allowance_epoch from public.nh_allowance_pools as p
       where p.pool_id = v_requirement.pool_id),
      v_requirement.action_units, v_requirement.verification_units,
      v_requirement.reserved_units
    );
  end loop;

  v_code := case when v_alert then 'ALLOWED_WITH_ALERT' else 'ALLOWED' end;
  perform public.nh_audit_reservation_event(
    v_reservation.reservation_id, 'reservation_granted', v_code, p_actor_id
  );
  select jsonb_object_agg(i.pool_id, p.remaining_units order by i.pool_id)
  into v_remaining
  from public.nh_allowance_reservation_items as i
  join public.nh_allowance_pools as p using (pool_id)
  where i.reservation_id = v_reservation.reservation_id;

  return jsonb_build_object(
    'allowed', true, 'code', v_code,
    'reservation_id', v_reservation.reservation_id,
    'remaining_units', v_remaining, 'replayed', false,
    'alert_required', v_alert
  );
end;
$$;

create or replace function public.nh_mark_allowance_dispatched(
  p_reservation_id uuid,
  p_dispatch_key uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_reservation public.nh_allowance_reservations%rowtype;
  v_code text;
  v_allowed boolean;
begin
  if p_reservation_id is null or p_dispatch_key is null
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 128
  then
    raise exception using errcode = '22023', message = 'Invalid dispatch request';
  end if;
  select r.* into v_reservation from public.nh_allowance_reservations as r
  where r.reservation_id = p_reservation_id for update;
  if not found then
    insert into public.nh_admission_audit (
      event_type, decision_code, reservation_id, actor_id
    ) values ('reservation_denied', 'RESERVATION_NOT_FOUND', p_reservation_id, p_actor_id);
    return jsonb_build_object('allowed', false, 'code', 'RESERVATION_NOT_FOUND');
  end if;
  if v_reservation.actor_id <> p_actor_id then
    v_code := 'ACTOR_MISMATCH'; v_allowed := false;
  elsif v_reservation.state = 'reserved' and v_reservation.expires_at <= clock_timestamp() then
    v_code := 'RESERVATION_EXPIRED'; v_allowed := false;
  elsif v_reservation.state = 'reserved' then
    -- Lock every current pool before validating the snapshot used for this
    -- reservation. A refreshed or expired allowance can never authorize a
    -- later external dispatch.
    perform p.pool_id
    from public.nh_allowance_reservation_items as i
    join public.nh_allowance_pools as p using (pool_id)
    where i.reservation_id = p_reservation_id
    order by p.pool_id
    for update of p;
    if exists (
      select 1
      from public.nh_allowance_reservation_items as i
      join public.nh_allowance_pools as p using (pool_id)
      where i.reservation_id = p_reservation_id
        and i.allowance_epoch <> p.allowance_epoch
    ) then
      v_code := 'ALLOWANCE_EPOCH_CHANGED'; v_allowed := false;
    elsif exists (
      select 1
      from public.nh_allowance_reservation_items as i
      join public.nh_allowance_pools as p using (pool_id)
      where i.reservation_id = p_reservation_id
        and p.reset_at is not null and p.reset_at <= clock_timestamp()
    ) then
      v_code := 'ALLOWANCE_SNAPSHOT_EXPIRED'; v_allowed := false;
    elsif exists (
      select 1
      from public.nh_allowance_reservation_items as i
      join public.nh_allowance_pools as p using (pool_id)
      where i.reservation_id = p_reservation_id
        and p.allowance_status = 'unknown'
    ) then
      v_code := 'ALLOWANCE_UNKNOWN'; v_allowed := false;
    else
      update public.nh_allowance_reservations
      set state = 'dispatched', dispatch_key = p_dispatch_key,
          dispatched_at = clock_timestamp()
      where reservation_id = p_reservation_id returning * into v_reservation;
      v_code := 'DISPATCH_RECORDED'; v_allowed := true;
    end if;
  elsif v_reservation.state = 'dispatched' and v_reservation.dispatch_key = p_dispatch_key then
    v_code := 'IDEMPOTENT_REPLAY'; v_allowed := true;
  elsif v_reservation.state = 'dispatched' then
    v_code := 'DISPATCH_CONFLICT'; v_allowed := false;
  elsif v_reservation.state = 'reconciliation_required' then
    v_code := 'RECONCILIATION_REQUIRED'; v_allowed := false;
  elsif v_reservation.state = 'settled' then
    v_code := 'ALREADY_SETTLED'; v_allowed := false;
  elsif v_reservation.state = 'reclaimed' then
    v_code := 'RESERVATION_RECLAIMED'; v_allowed := false;
  else
    v_code := 'RESERVATION_CANCELLED'; v_allowed := false;
  end if;
  perform public.nh_audit_reservation_event(
    v_reservation.reservation_id,
    case when v_code in ('DISPATCH_RECORDED', 'IDEMPOTENT_REPLAY')
      then 'reservation_dispatched' else 'reservation_denied' end,
    v_code, p_actor_id
  );
  return jsonb_build_object(
    'allowed', v_allowed, 'code', v_code,
    'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
  );
end;
$$;

create or replace function public.nh_cancel_allowance_reservation(
  p_reservation_id uuid,
  p_cancellation_key uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_reservation public.nh_allowance_reservations%rowtype;
  v_item public.nh_allowance_reservation_items%rowtype;
  v_code text;
begin
  if p_reservation_id is null or p_cancellation_key is null
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 128
  then raise exception using errcode = '22023', message = 'Invalid cancellation request'; end if;
  select r.* into v_reservation from public.nh_allowance_reservations as r
  where r.reservation_id = p_reservation_id for update;
  if not found then
    insert into public.nh_admission_audit (
      event_type, decision_code, reservation_id, actor_id
    ) values ('reservation_denied', 'RESERVATION_NOT_FOUND', p_reservation_id, p_actor_id);
    return jsonb_build_object('allowed', false, 'code', 'RESERVATION_NOT_FOUND');
  end if;
  if v_reservation.actor_id <> p_actor_id then v_code := 'ACTOR_MISMATCH';
  elsif v_reservation.state = 'cancelled' and v_reservation.settlement_key = p_cancellation_key
    then v_code := 'IDEMPOTENT_REPLAY';
  elsif v_reservation.state = 'reserved' then v_code := null;
  elsif v_reservation.state in ('dispatched', 'reconciliation_required', 'settled')
    then v_code := 'ALREADY_DISPATCHED';
  elsif v_reservation.state = 'reclaimed' then v_code := 'RESERVATION_RECLAIMED';
  else v_code := 'SETTLEMENT_CONFLICT'; end if;
  if v_code is not null then
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id,
      case when v_code = 'IDEMPOTENT_REPLAY'
        then 'reservation_replayed' else 'reservation_denied' end,
      v_code, p_actor_id
    );
    return jsonb_build_object(
      'allowed', false, 'code', v_code,
      'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
    );
  end if;

  for v_item in select * from public.nh_allowance_reservation_items
    where reservation_id = p_reservation_id order by pool_id
  loop
    perform 1 from public.nh_allowance_pools where pool_id = v_item.pool_id for update;
    update public.nh_allowance_pools as p
    set remaining_units = p.remaining_units + v_item.reserved_units,
        allowance_status = 'verified_available', version = p.version + 1,
        updated_at = clock_timestamp()
    where p.pool_id = v_item.pool_id
      and p.allowance_epoch = v_item.allowance_epoch
      and p.remaining_units is not null;
    if not found and exists (
      select 1 from public.nh_allowance_pools as p
      where p.pool_id = v_item.pool_id
        and p.allowance_epoch = v_item.allowance_epoch
    ) then
      raise exception using errcode = '23514', message = 'Reserved pool has unknown state';
    end if;
  end loop;
  update public.nh_allowance_reservations
  set state = 'cancelled', settlement_key = p_cancellation_key,
      settlement_outcome = 'cancelled_before_dispatch',
      settled_at = clock_timestamp(), released_at = clock_timestamp()
  where reservation_id = p_reservation_id returning * into v_reservation;
  update public.nh_allowance_reservation_items set actual_units = 0
  where reservation_id = p_reservation_id;
  perform public.nh_audit_reservation_event(
    v_reservation.reservation_id, 'reservation_cancelled',
    'CANCELLED_BEFORE_DISPATCH', p_actor_id
  );
  return jsonb_build_object(
    'allowed', true, 'code', 'CANCELLED_BEFORE_DISPATCH',
    'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
  );
end;
$$;

create or replace function public.nh_mark_allowance_reconciliation_required(
  p_reservation_id uuid,
  p_reconciliation_key uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_reservation public.nh_allowance_reservations%rowtype;
  v_code text;
begin
  if p_reservation_id is null or p_reconciliation_key is null
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 128
  then raise exception using errcode = '22023', message = 'Invalid reconciliation request'; end if;
  select r.* into v_reservation from public.nh_allowance_reservations as r
  where r.reservation_id = p_reservation_id for update;
  if not found then
    insert into public.nh_admission_audit (
      event_type, decision_code, reservation_id, actor_id
    ) values ('reservation_denied', 'RESERVATION_NOT_FOUND', p_reservation_id, p_actor_id);
    return jsonb_build_object('allowed', false, 'code', 'RESERVATION_NOT_FOUND');
  end if;
  if v_reservation.actor_id <> p_actor_id then v_code := 'ACTOR_MISMATCH';
  elsif v_reservation.state = 'reconciliation_required'
    and v_reservation.reconciliation_key = p_reconciliation_key
    then v_code := 'IDEMPOTENT_REPLAY';
  elsif v_reservation.state = 'dispatched' then v_code := null;
  elsif v_reservation.state = 'reserved' then v_code := 'NOT_DISPATCHED';
  elsif v_reservation.state = 'settled' then v_code := 'ALREADY_SETTLED';
  else v_code := 'RESERVATION_RELEASED'; end if;
  if v_code is not null then
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id,
      case when v_code = 'IDEMPOTENT_REPLAY'
        then 'reservation_replayed' else 'reservation_denied' end,
      v_code, p_actor_id
    );
    return jsonb_build_object(
      'allowed', false, 'code', v_code,
      'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
    );
  end if;
  update public.nh_allowance_reservations
  set state = 'reconciliation_required', reconciliation_key = p_reconciliation_key,
      reconciliation_reason = 'transport_uncertain'
  where reservation_id = p_reservation_id returning * into v_reservation;
  perform public.nh_audit_reservation_event(
    v_reservation.reservation_id, 'reconciliation_required',
    'TRANSPORT_UNCERTAIN', p_actor_id
  );
  return jsonb_build_object(
    'allowed', false, 'code', 'TRANSPORT_UNCERTAIN',
    'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
  );
end;
$$;

create or replace function public.nh_settle_allowance_reservation(
  p_reservation_id uuid,
  p_settlement_key uuid,
  p_outcome text,
  p_actual_requirements jsonb,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_reservation public.nh_allowance_reservations%rowtype;
  v_item record;
  v_code text;
  v_supplied jsonb;
  v_stored jsonb;
begin
  if p_reservation_id is null or p_settlement_key is null
    or p_outcome not in ('completed', 'failed_after_dispatch')
    or not public.nh_allowance_requirements_valid(p_actual_requirements, true)
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 128
  then raise exception using errcode = '22023', message = 'Invalid settlement request'; end if;

  select jsonb_agg(jsonb_build_object(
    'pool', item ->> 'pool', 'units', (item ->> 'units')::bigint
  ) order by item ->> 'pool') into v_supplied
  from jsonb_array_elements(p_actual_requirements) as items(item);

  select r.* into v_reservation from public.nh_allowance_reservations as r
  where r.reservation_id = p_reservation_id for update;
  if not found then
    insert into public.nh_admission_audit (
      event_type, decision_code, reservation_id, actor_id
    ) values ('reservation_denied', 'RESERVATION_NOT_FOUND', p_reservation_id, p_actor_id);
    return jsonb_build_object('allowed', false, 'code', 'RESERVATION_NOT_FOUND');
  end if;
  if v_reservation.actor_id <> p_actor_id then
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id, 'reservation_denied', 'ACTOR_MISMATCH', p_actor_id
    );
    return jsonb_build_object(
      'allowed', false, 'code', 'ACTOR_MISMATCH',
      'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
    );
  end if;

  if v_reservation.state = 'settled' then
    select jsonb_agg(jsonb_build_object(
      'pool', i.pool_id, 'units', i.actual_units
    ) order by i.pool_id) into v_stored
    from public.nh_allowance_reservation_items as i
    where i.reservation_id = p_reservation_id;
    v_code := case when v_reservation.settlement_key = p_settlement_key
      and v_reservation.settlement_outcome = p_outcome and v_stored = v_supplied
      then 'IDEMPOTENT_REPLAY' else 'SETTLEMENT_CONFLICT' end;
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id, 'reservation_replayed', v_code, p_actor_id
    );
    return jsonb_build_object(
      'allowed', false, 'code', v_code,
      'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
    );
  end if;
  if v_reservation.state not in ('dispatched', 'reconciliation_required') then
    v_code := case when v_reservation.state = 'reserved' then 'NOT_DISPATCHED'
      when v_reservation.state = 'reclaimed' then 'RESERVATION_RECLAIMED'
      else 'RESERVATION_CANCELLED' end;
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id, 'reservation_denied', v_code, p_actor_id
    );
    return jsonb_build_object(
      'allowed', false, 'code', v_code,
      'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
    );
  end if;

  if exists (
    select 1 from public.nh_allowance_reservation_items as i
    full join jsonb_to_recordset(v_supplied) as a(pool text, units bigint)
      on a.pool = i.pool_id
    where i.reservation_id = p_reservation_id
      and (i.pool_id is null or a.pool is null or a.units > i.reserved_units)
  ) or (
    select count(*) from jsonb_array_elements(v_supplied)
  ) <> (
    select count(*) from public.nh_allowance_reservation_items
    where reservation_id = p_reservation_id
  ) then
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id, 'reservation_denied',
      'INVALID_ACTUAL_REQUIREMENTS', p_actor_id
    );
    return jsonb_build_object(
      'allowed', false, 'code', 'INVALID_ACTUAL_REQUIREMENTS',
      'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
    );
  end if;

  for v_item in
    select i.pool_id, i.allowance_epoch, i.reserved_units, a.units as actual_units
    from public.nh_allowance_reservation_items as i
    join jsonb_to_recordset(v_supplied) as a(pool text, units bigint)
      on a.pool = i.pool_id
    where i.reservation_id = p_reservation_id order by i.pool_id
  loop
    perform 1 from public.nh_allowance_pools where pool_id = v_item.pool_id for update;
    update public.nh_allowance_pools as p
    set remaining_units = p.remaining_units + v_item.reserved_units - v_item.actual_units,
        allowance_status = case
          when p.remaining_units + v_item.reserved_units - v_item.actual_units = 0
            then 'verified_exhausted' else 'verified_available' end,
        version = p.version + 1, updated_at = clock_timestamp()
    where p.pool_id = v_item.pool_id
      and p.allowance_epoch = v_item.allowance_epoch
      and p.remaining_units is not null;
    if not found and exists (
      select 1 from public.nh_allowance_pools as p
      where p.pool_id = v_item.pool_id
        and p.allowance_epoch = v_item.allowance_epoch
    ) then
      raise exception using errcode = '23514', message = 'Reserved pool has unknown state';
    end if;
    update public.nh_allowance_reservation_items
    set actual_units = v_item.actual_units
    where reservation_id = p_reservation_id and pool_id = v_item.pool_id;
  end loop;

  update public.nh_allowance_reservations
  set state = 'settled', settlement_key = p_settlement_key,
      settlement_outcome = p_outcome, settled_at = clock_timestamp(),
      reconciliation_key = null, reconciliation_reason = null
  where reservation_id = p_reservation_id returning * into v_reservation;
  perform public.nh_audit_reservation_event(
    v_reservation.reservation_id, 'reservation_settled',
    'SETTLEMENT_RECORDED', p_actor_id
  );
  return jsonb_build_object(
    'allowed', true, 'code', 'SETTLEMENT_RECORDED',
    'reservation_id', v_reservation.reservation_id, 'state', v_reservation.state
  );
end;
$$;

create or replace function public.nh_reconcile_allowance_reservations(
  p_now timestamptz,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_reservation public.nh_allowance_reservations%rowtype;
  v_item public.nh_allowance_reservation_items%rowtype;
  v_reclaimed integer := 0;
  v_needs_review integer := 0;
begin
  if p_now is null
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 128
  then raise exception using errcode = '22023', message = 'Invalid reconciliation request'; end if;
  for v_reservation in
    select r.* from public.nh_allowance_reservations as r
    where r.state = 'reserved' and r.dispatch_key is null
      and r.dispatched_at is null and r.expires_at <= p_now
    order by r.expires_at, r.reservation_id for update
  loop
    for v_item in select * from public.nh_allowance_reservation_items
      where reservation_id = v_reservation.reservation_id order by pool_id
    loop
      perform 1 from public.nh_allowance_pools where pool_id = v_item.pool_id for update;
      update public.nh_allowance_pools as p
      set remaining_units = p.remaining_units + v_item.reserved_units,
          allowance_status = 'verified_available', version = p.version + 1,
          updated_at = clock_timestamp()
      where p.pool_id = v_item.pool_id
        and p.allowance_epoch = v_item.allowance_epoch
        and p.remaining_units is not null;
      if not found and exists (
        select 1 from public.nh_allowance_pools as p
        where p.pool_id = v_item.pool_id
          and p.allowance_epoch = v_item.allowance_epoch
      ) then
        raise exception using errcode = '23514', message = 'Reserved pool has unknown state';
      end if;
    end loop;
    update public.nh_allowance_reservations
    set state = 'reclaimed', released_at = clock_timestamp()
    where reservation_id = v_reservation.reservation_id;
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id, 'reservation_reclaimed',
      'UNDISPATCHED_EXPIRED_RECLAIMED', p_actor_id
    );
    v_reclaimed := v_reclaimed + 1;
  end loop;
  for v_reservation in
    select r.* from public.nh_allowance_reservations as r
    where r.state = 'dispatched' and r.dispatch_key is not null
      and r.dispatched_at is not null and r.expires_at <= p_now
    order by r.expires_at, r.reservation_id for update
  loop
    update public.nh_allowance_reservations
    set state = 'reconciliation_required', reconciliation_reason = 'lease_expired'
    where reservation_id = v_reservation.reservation_id;
    perform public.nh_audit_reservation_event(
      v_reservation.reservation_id, 'reconciliation_required',
      'DISPATCHED_USAGE_UNRESOLVED', p_actor_id
    );
    v_needs_review := v_needs_review + 1;
  end loop;
  return jsonb_build_object(
    'reclaimed_count', v_reclaimed,
    'reconciliation_required_count', v_needs_review
  );
end;
$$;

create or replace function public.nh_allowance_store_ready()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    to_regclass('public.nh_allowance_pools') is not null
    and to_regclass('public.nh_allowance_reservations') is not null
    and to_regclass('public.nh_allowance_reservation_items') is not null
    and to_regclass('public.nh_admission_audit') is not null
    and to_regprocedure(
      'public.nh_reserve_allowance_bundle(text,text,text,text,text,jsonb,jsonb,timestamptz)'
    ) is not null
    and to_regprocedure(
      'public.nh_mark_allowance_dispatched(uuid,uuid,text)'
    ) is not null
    and to_regprocedure(
      'public.nh_cancel_allowance_reservation(uuid,uuid,text)'
    ) is not null
    and to_regprocedure(
      'public.nh_mark_allowance_reconciliation_required(uuid,uuid,text)'
    ) is not null
    and to_regprocedure(
      'public.nh_settle_allowance_reservation(uuid,uuid,text,jsonb,text)'
    ) is not null
    and to_regprocedure(
      'public.nh_reconcile_allowance_reservations(timestamptz,text)'
    ) is not null
    and to_regprocedure('public.nh_guard_allowance_epoch_refresh()') is not null;
$$;

revoke all on function public.nh_allowance_requirements_valid(jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.nh_merge_allowance_requirements(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.nh_guard_allowance_epoch_refresh() from public, anon, authenticated, service_role;
revoke all on function public.nh_reject_admission_audit_mutation() from public, anon, authenticated, service_role;
revoke all on function public.nh_audit_reservation_event(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.nh_reserve_allowance_bundle(text, text, text, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.nh_mark_allowance_dispatched(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.nh_cancel_allowance_reservation(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.nh_mark_allowance_reconciliation_required(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.nh_settle_allowance_reservation(uuid, uuid, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.nh_reconcile_allowance_reservations(timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.nh_allowance_store_ready() from public, anon, authenticated, service_role;

-- Only the public transition surface is callable by the server key. Internal
-- validators and audit writers execute solely within the definer-owned RPCs.
grant execute on function public.nh_reserve_allowance_bundle(text, text, text, text, text, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.nh_mark_allowance_dispatched(uuid, uuid, text) to service_role;
grant execute on function public.nh_cancel_allowance_reservation(uuid, uuid, text) to service_role;
grant execute on function public.nh_mark_allowance_reconciliation_required(uuid, uuid, text) to service_role;
grant execute on function public.nh_settle_allowance_reservation(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.nh_reconcile_allowance_reservations(timestamptz, text) to service_role;
grant execute on function public.nh_allowance_store_ready() to service_role;
