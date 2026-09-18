-- Exactly-once request ledger for the private POST /api/agent/run route.
-- The raw Idempotency-Key, LINE user ID and message are never stored here.
create table public.agent_api_requests (
  id bigint generated always as identity primary key,
  client_account_id bigint not null references public.client_accounts(id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  line_user_id_hash text not null check (line_user_id_hash ~ '^[0-9a-f]{64}$'),
  department text not null check (department ~ '^[a-z][a-z0-9_-]{1,31}$'),
  execution_id uuid not null default gen_random_uuid(),
  state text not null default 'in_progress'
    check (state in ('in_progress', 'completed', 'failed', 'uncertain')),
  response_status integer check (response_status between 200 and 599),
  response_body jsonb check (response_body is null or jsonb_typeof(response_body) = 'object'),
  run_id bigint references public.agent_runs(id),
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  requested_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (idempotency_key_hash),
  constraint agent_api_requests_terminal_shape check (
    (state = 'in_progress' and response_status is null and response_body is null
      and completed_at is null and lease_expires_at is not null)
    or
    (state = 'completed' and response_status is not null and response_body is not null
      and completed_at is not null and lease_expires_at is null)
    or
    (state in ('failed', 'uncertain') and response_status is null and response_body is null
      and completed_at is not null and lease_expires_at is null)
  )
);

comment on table public.agent_api_requests is
  'Private exactly-once ledger for API agent requests; payloads are bound by digest and completed responses are replayed without execution.';

create index agent_api_requests_state_lease_idx
  on public.agent_api_requests (state, lease_expires_at)
  where state = 'in_progress';

alter table public.agent_api_requests enable row level security;
revoke all on table public.agent_api_requests from public, anon, authenticated;
revoke all on sequence public.agent_api_requests_id_seq from public, anon, authenticated;
grant select, insert, update on table public.agent_api_requests to service_role;
grant usage, select on sequence public.agent_api_requests_id_seq to service_role;

create or replace function public.nh_claim_agent_api_request(
  p_idempotency_key_hash text,
  p_request_digest text,
  p_client_account_id bigint,
  p_department text,
  p_line_user_id_hash text
)
returns table(
  decision text,
  execution_id uuid,
  requested_at timestamptz,
  state text,
  response_status integer,
  response_body jsonb,
  run_id bigint
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_request public.agent_api_requests%rowtype;
begin
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_client_account_id is null or p_client_account_id <= 0
    or p_department is null or p_department !~ '^[a-z][a-z0-9_-]{1,31}$'
    or p_line_user_id_hash is null or p_line_user_id_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'Invalid agent API request';
  end if;

  -- Each Idempotency-Key owns one immutable request globally. Tenant is part of the
  -- request digest, so a later binding change cannot reacquire the same key.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key_hash, 0));

  insert into public.agent_api_requests (
    client_account_id, idempotency_key_hash, request_digest,
    line_user_id_hash, department, lease_expires_at
  ) values (
    p_client_account_id, p_idempotency_key_hash, p_request_digest,
    p_line_user_id_hash, p_department, clock_timestamp() + interval '15 minutes'
  )
  on conflict (idempotency_key_hash) do nothing
  returning * into v_request;

  if found then
    return query select 'acquired'::text, v_request.execution_id,
      v_request.requested_at, v_request.state, v_request.response_status,
      v_request.response_body, v_request.run_id;
    return;
  end if;

  select r.* into v_request
  from public.agent_api_requests as r
  where r.idempotency_key_hash = p_idempotency_key_hash
  for update;

  if not found then
    raise exception using errcode = '40001', message = 'Agent API claim could not be confirmed';
  end if;

  if v_request.client_account_id <> p_client_account_id
    or v_request.request_digest <> p_request_digest
    or v_request.department <> p_department
    or v_request.line_user_id_hash <> p_line_user_id_hash
  then
    return query select 'conflict'::text, v_request.execution_id,
      v_request.requested_at, v_request.state, null::integer, null::jsonb,
      v_request.run_id;
    return;
  end if;

  if v_request.state = 'in_progress'
    and v_request.lease_expires_at <= clock_timestamp()
  then
    update public.agent_api_requests as r
    set state = 'uncertain', error_code = 'execution_lease_expired',
        lease_expires_at = null, completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where r.id = v_request.id
    returning * into v_request;
  end if;

  return query select
    case v_request.state
      when 'completed' then 'completed'
      when 'in_progress' then 'in_progress'
      when 'failed' then 'failed'
      else 'uncertain'
    end::text,
    v_request.execution_id, v_request.requested_at, v_request.state,
    v_request.response_status, v_request.response_body, v_request.run_id;
end;
$$;

create or replace function public.nh_finish_agent_api_request(
  p_client_account_id bigint,
  p_idempotency_key_hash text,
  p_request_digest text,
  p_execution_id uuid,
  p_state text,
  p_response_status integer default null,
  p_response_body jsonb default null,
  p_run_id bigint default null,
  p_error_code text default null
)
returns table(
  decision text,
  execution_id uuid,
  requested_at timestamptz,
  state text,
  response_status integer,
  response_body jsonb,
  run_id bigint
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_request public.agent_api_requests%rowtype;
begin
  if p_client_account_id is null or p_client_account_id <= 0
    or p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_execution_id is null
    or p_state is null or p_state not in ('completed', 'failed', 'uncertain')
    or (p_state = 'completed' and (
      p_response_status is null or p_response_status not between 200 and 599
      or p_response_body is null or jsonb_typeof(p_response_body) <> 'object'
    ))
    or (p_state <> 'completed' and (p_response_status is not null or p_response_body is not null))
    or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
  then
    raise exception using errcode = '22023', message = 'Invalid agent API completion';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key_hash, 0));

  select r.* into v_request
  from public.agent_api_requests as r
  where r.idempotency_key_hash = p_idempotency_key_hash
  for update;

  if not found
    or v_request.client_account_id <> p_client_account_id
    or v_request.request_digest <> p_request_digest
    or v_request.execution_id <> p_execution_id
  then
    raise exception using errcode = '22023', message = 'Agent API completion does not match its claim';
  end if;

  -- A retry after an uncertain network response reads the stored terminal state.
  if v_request.state <> 'in_progress' then
    return query select v_request.state::text, v_request.execution_id,
      v_request.requested_at, v_request.state, v_request.response_status,
      v_request.response_body, v_request.run_id;
    return;
  end if;

  update public.agent_api_requests as r
  set state = p_state,
      response_status = case when p_state = 'completed' then p_response_status else null end,
      response_body = case when p_state = 'completed' then p_response_body else null end,
      run_id = p_run_id,
      error_code = case when p_state = 'completed' then null else coalesce(p_error_code, 'execution_failed') end,
      lease_expires_at = null,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where r.id = v_request.id
  returning * into v_request;

  return query select v_request.state::text, v_request.execution_id,
    v_request.requested_at, v_request.state, v_request.response_status,
    v_request.response_body, v_request.run_id;
end;
$$;

revoke all on function public.nh_claim_agent_api_request(text, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.nh_claim_agent_api_request(text, text, bigint, text, text)
  to service_role;
revoke all on function public.nh_finish_agent_api_request(bigint, text, text, uuid, text, integer, jsonb, bigint, text)
  from public, anon, authenticated;
grant execute on function public.nh_finish_agent_api_request(bigint, text, text, uuid, text, integer, jsonb, bigint, text)
  to service_role;

notify pgrst, 'reload schema';
