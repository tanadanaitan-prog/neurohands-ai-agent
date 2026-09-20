-- Founder-owned, exact-commit approval claims for consequential releases.
-- Approval rows are created only by a reviewed private operator procedure; the
-- application can atomically claim an existing row but cannot approve itself.
create table public.nh_deployment_approvals (
  approval_id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('railway_deploy', 'github_merge')),
  target text not null check (target in ('railway_production', 'github_main')),
  approved_commit_sha text not null check (approved_commit_sha ~ '^[0-9a-f]{40}$'),
  founder_principal text not null check (founder_principal ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  founder_approved boolean not null default false,
  approved_at timestamptz,
  expires_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending', 'approved', 'claimed', 'revoked')),
  claim_id uuid,
  request_digest text check (request_digest is null or request_digest ~ '^[0-9a-f]{64}$'),
  requester_id text check (requester_id is null or requester_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  claimed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint nh_deployment_approvals_action_target check (
    (action = 'railway_deploy' and target = 'railway_production')
    or (action = 'github_merge' and target = 'github_main')
  ),
  constraint nh_deployment_approvals_state_shape check (
    (state = 'pending' and founder_approved = false and approved_at is null
      and claim_id is null and request_digest is null and requester_id is null and claimed_at is null)
    or
    (state = 'approved' and founder_approved = true and approved_at is not null
      and claim_id is null and request_digest is null and requester_id is null and claimed_at is null)
    or
    (state = 'claimed' and founder_approved = true and approved_at is not null
      and claim_id is not null and request_digest is not null and requester_id is not null and claimed_at is not null)
    or
    (state = 'revoked' and claim_id is null and request_digest is null and requester_id is null and claimed_at is null)
  )
);

comment on table public.nh_deployment_approvals is
  'Private founder approvals bound to one exact commit and atomically consumed before a consequential deployment.';

create index nh_deployment_approvals_expiry_idx
  on public.nh_deployment_approvals (expires_at)
  where state = 'approved';

alter table public.nh_deployment_approvals enable row level security;
revoke all on table public.nh_deployment_approvals from public, anon, authenticated, service_role;

create or replace function public.nh_claim_deployment_approval(
  p_approval_id uuid,
  p_commit_sha text,
  p_deployment_key text,
  p_requester_id text,
  p_action text,
  p_target text,
  p_request_digest text
)
returns table(
  decision text,
  claim_id uuid,
  approved_commit_sha text,
  founder_approved boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.nh_deployment_approvals%rowtype;
  v_claim_id uuid;
begin
  if p_approval_id is null
    or p_commit_sha is null or p_commit_sha !~ '^[0-9a-f]{40}$'
    or p_deployment_key is null or p_deployment_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,199}$'
    or p_requester_id is null or p_requester_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'
    or p_action is null or p_action not in ('railway_deploy', 'github_merge')
    or p_target is null or p_target not in ('railway_production', 'github_main')
    or not ((p_action = 'railway_deploy' and p_target = 'railway_production')
      or (p_action = 'github_merge' and p_target = 'github_main'))
    or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'Invalid deployment approval claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_approval_id::text, 0));
  select a.* into v_approval
  from public.nh_deployment_approvals as a
  where a.approval_id = p_approval_id
  for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, false;
    return;
  end if;

  if v_approval.state = 'claimed' then
    return query select
      case when v_approval.request_digest = p_request_digest
        and v_approval.requester_id = p_requester_id
        and v_approval.approved_commit_sha = p_commit_sha
        and v_approval.action = p_action and v_approval.target = p_target
      then 'idempotent_replay' else 'already_used' end::text,
      v_approval.claim_id, v_approval.approved_commit_sha, v_approval.founder_approved;
    return;
  end if;

  if v_approval.state <> 'approved' or v_approval.founder_approved is not true then
    return query select 'not_found'::text, null::uuid, v_approval.approved_commit_sha, false;
    return;
  end if;
  if v_approval.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'expired'::text, null::uuid, v_approval.approved_commit_sha, true;
    return;
  end if;
  if v_approval.approved_commit_sha <> p_commit_sha then
    return query select 'commit_mismatch'::text, null::uuid, v_approval.approved_commit_sha, true;
    return;
  end if;
  if v_approval.action <> p_action or v_approval.target <> p_target then
    return query select 'conflict'::text, null::uuid, v_approval.approved_commit_sha, true;
    return;
  end if;

  v_claim_id := pg_catalog.gen_random_uuid();
  update public.nh_deployment_approvals as a
  set state = 'claimed', claim_id = v_claim_id,
      request_digest = p_request_digest, requester_id = p_requester_id,
      claimed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  where a.approval_id = p_approval_id;

  return query select 'claimed'::text, v_claim_id,
    v_approval.approved_commit_sha, true;
end;
$$;

revoke all on function public.nh_claim_deployment_approval(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.nh_claim_deployment_approval(uuid, text, text, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';
