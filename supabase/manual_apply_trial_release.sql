-- Neurohands Customer-Trial & AI Org Learning Hub Combined Idempotent SQL Bundle
-- Paste into Supabase SQL Editor for project darxiaearohhnxiwhcbs and click Run.
-- Includes 20261117000001_dashboard_realtime_telemetry, 20261122000001_customer_trial_release, and 20261122000002_ai_org_learning_and_reports.

begin;

create index if not exists messages_created_idx
  on public.messages(created_at desc);

create index if not exists agent_runs_status_created_idx
  on public.agent_runs(status, created_at desc);

-- security_invoker = true evaluates caller grants and RLS on public.messages so authenticated tokens granted SELECT on this view cannot bypass them via view-owner privileges.
-- Redact emails and 13-digit Thai IDs BEFORE phones so email local-parts and ID prefixes like 08/02 are masked whole.
create or replace view public.nh_messages_telemetry
with (security_invoker = true) as
select
  m.id,
  m.client_account_id,
  m.run_id,
  m.direction,
  m.answered_by,
  m.question_type,
  m.status,
  m.created_at,
  left(encode(sha256(convert_to(coalesce(m.line_user_id, ''), 'UTF8')), 'hex'), 16) as line_user_hash,
  left(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            coalesce(m.text_content, ''),
            '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
            '[EMAIL-REDACTED]',
            'g'
          ),
          '\y(?:[0-9]{13}|[0-9][- ]?[0-9]{4}[- ]?[0-9]{5}[- ]?[0-9]{2}[- ]?[0-9])\y',
          '[ID-REDACTED]',
          'g'
        ),
        '\yU[0-9A-Fa-f]{32}\y',
        '[LINE-ID-REDACTED]',
        'g'
      ),
      '(?:\+?66[-\s]*(?:\(0\)|0)?|0[2-9])[0-9\-\s]{6,13}[0-9]',
      '[PHONE-REDACTED]',
      'g'
    ),
    140
  ) as masked_text
from public.messages m;

revoke all on public.nh_messages_telemetry from public, anon;
grant select on public.nh_messages_telemetry to authenticated, service_role;

-- Supabase end users can mutate user_metadata via auth.updateUser(); tenant RLS must read server-signed app_metadata only.
-- CASE guards the bigint cast so non-numeric claims return NULL instead of throwing 22P02.
do $$
declare
  tenant_check constant text := $c$
    client_account_id = (
      case
        when (auth.jwt() -> 'app_metadata' ->> 'provider') = 'line'
          and (auth.jwt() -> 'app_metadata' ->> 'client_account_id') ~ '^[0-9]{1,18}$'
        then (auth.jwt() -> 'app_metadata' ->> 'client_account_id')::bigint
      end
    )
  $c$;
begin
  if to_regclass('public.nh_sites') is not null then
    execute 'drop policy if exists "Tenants can view own sites" on public.nh_sites';
    execute format('create policy "Tenants can view own sites" on public.nh_sites for select to authenticated using (%s)', tenant_check);
    execute 'drop policy if exists "Tenants can insert own sites" on public.nh_sites';
    execute format('create policy "Tenants can insert own sites" on public.nh_sites for insert to authenticated with check (%s)', tenant_check);
    execute 'drop policy if exists "Tenants can update own sites" on public.nh_sites';
    execute format('create policy "Tenants can update own sites" on public.nh_sites for update to authenticated using (%1$s) with check (%1$s)', tenant_check);
    execute 'drop policy if exists "Tenants can delete own sites" on public.nh_sites';
    execute format('create policy "Tenants can delete own sites" on public.nh_sites for delete to authenticated using (%s)', tenant_check);
  end if;

  if to_regclass('public.nh_site_assets') is not null then
    execute 'drop policy if exists "Tenants can view own site assets" on public.nh_site_assets';
    execute format('create policy "Tenants can view own site assets" on public.nh_site_assets for select to authenticated using (%s)', tenant_check);
    execute 'drop policy if exists "Tenants can insert own site assets" on public.nh_site_assets';
    execute format('create policy "Tenants can insert own site assets" on public.nh_site_assets for insert to authenticated with check (%s)', tenant_check);
    execute 'drop policy if exists "Tenants can update own site assets" on public.nh_site_assets';
    execute format('create policy "Tenants can update own site assets" on public.nh_site_assets for update to authenticated using (%1$s) with check (%1$s)', tenant_check);
    execute 'drop policy if exists "Tenants can delete own site assets" on public.nh_site_assets';
    execute format('create policy "Tenants can delete own site assets" on public.nh_site_assets for delete to authenticated using (%s)', tenant_check);
  end if;

  if to_regclass('public.nh_site_inquiries') is not null then
    execute 'drop policy if exists "Tenants can view own inquiries" on public.nh_site_inquiries';
    execute format('create policy "Tenants can view own inquiries" on public.nh_site_inquiries for select to authenticated using (%s)', tenant_check);
    execute 'drop policy if exists "Tenants can update own inquiries" on public.nh_site_inquiries';
    execute format('create policy "Tenants can update own inquiries" on public.nh_site_inquiries for update to authenticated using (%1$s) with check (%1$s)', tenant_check);
  end if;

  -- PostgreSQL grants EXECUTE on new functions to PUBLIC by default; revoke direct invocation on this SECURITY DEFINER trigger function.
  if to_regprocedure('public.nh_forward_inquiry_to_cases()') is not null then
    execute 'revoke all on function public.nh_forward_inquiry_to_cases() from public, anon, authenticated';
  end if;
end $$;

commit;

begin;

create table if not exists public.nh_tenant_trials (
  client_account_id bigint primary key references public.client_accounts(id) on delete cascade,
  owner_email text,
  plan_code text not null default 'trial_free',
  status text not null default 'active' check (status in ('active', 'expired', 'quota_exceeded', 'paused')),
  trial_starts_at timestamptz not null default now(),
  trial_expires_at timestamptz not null default (now() + interval '14 days'),
  max_messages integer not null default 200 check (max_messages >= 0),
  used_messages integer not null default 0 check (used_messages >= 0),
  max_actions integer not null default 50 check (max_actions >= 0),
  used_actions integer not null default 0 check (used_actions >= 0),
  spending_cap_usd numeric(10,4) not null default 0 check (spending_cap_usd >= 0),
  spent_usd numeric(10,4) not null default 0 check (spent_usd >= 0),
  updated_at timestamptz not null default now()
);

create unique index if not exists nh_tenant_trials_owner_email_uq
  on public.nh_tenant_trials (lower(owner_email))
  where owner_email is not null;

create table if not exists public.nh_agent_workflows (
  id uuid primary key default gen_random_uuid(),
  client_account_id bigint not null references public.client_accounts(id) on delete cascade,
  agent_code text not null check (length(agent_code) between 1 and 40),
  name text not null check (length(name) between 1 and 100),
  role text not null check (length(role) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'published', 'paused')),
  version integer not null default 1 check (version >= 1),
  workflow_spec jsonb not null default '{}'::jsonb,
  published_spec jsonb,
  published_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_account_id, agent_code)
);

create index if not exists nh_agent_workflows_account_idx
  on public.nh_agent_workflows(client_account_id, status);

create table if not exists public.nh_line_group_bindings (
  id bigint generated always as identity primary key,
  client_account_id bigint not null references public.client_accounts(id) on delete cascade,
  line_group_id text not null unique check (length(line_group_id) between 5 and 128),
  source_type text not null default 'group' check (source_type in ('group', 'room')),
  group_name text,
  workflow_id uuid references public.nh_agent_workflows(id) on delete set null,
  response_mode text not null default 'mention_only' check (response_mode in ('off', 'mention_only', 'keyword', 'always')),
  trigger_keywords text[] not null default array[]::text[],
  active boolean not null default true,
  bound_by_line_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nh_line_group_bindings_account_idx
  on public.nh_line_group_bindings(client_account_id, active);

create table if not exists public.nh_conversation_states (
  id bigint generated always as identity primary key,
  client_account_id bigint not null references public.client_accounts(id) on delete cascade,
  channel_type text not null check (channel_type in ('web', 'line_user', 'line_group')),
  thread_id text not null check (length(thread_id) between 1 and 160),
  state text not null default 'ai_active' check (state in ('ai_active', 'awaiting_approval', 'human_takeover', 'paused')),
  assigned_human text,
  reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (client_account_id, channel_type, thread_id)
);

create index if not exists nh_conversation_states_lookup_idx
  on public.nh_conversation_states(client_account_id, channel_type, thread_id);

create table if not exists public.nh_dev_lessons (
  id text primary key,
  error_signature text not null,
  root_cause text not null,
  approved_fix text not null,
  regression_test text not null,
  verified_commit text,
  status text not null default 'verified' check (status in ('open', 'verified', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.nh_consume_trial_allowance(
  p_client_account_id bigint,
  p_messages integer default 1,
  p_actions integer default 0,
  p_cost_usd numeric default 0,
  p_now timestamptz default now()
)
returns table (
  allowed boolean,
  reason text,
  status text,
  remaining_messages integer,
  remaining_actions integer,
  remaining_budget_usd numeric,
  trial_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.nh_tenant_trials%rowtype;
  v_msg integer := greatest(coalesce(p_messages, 0), 0);
  v_act integer := greatest(coalesce(p_actions, 0), 0);
  v_cost numeric(10,4) := greatest(coalesce(p_cost_usd, 0), 0);
begin
  select * into v_row
  from public.nh_tenant_trials
  where client_account_id = p_client_account_id
  for update;

  if not found then
    return query select false, 'trial_not_found'::text, 'paused'::text, 0, 0, 0::numeric, null::timestamptz;
    return;
  end if;

  if v_row.status = 'paused' then
    return query select false, 'trial_paused'::text, v_row.status,
      greatest(v_row.max_messages - v_row.used_messages, 0),
      greatest(v_row.max_actions - v_row.used_actions, 0),
      greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
      v_row.trial_expires_at;
    return;
  end if;

  if p_now >= v_row.trial_expires_at then
    update public.nh_tenant_trials
      set status = 'expired', updated_at = p_now
      where client_account_id = p_client_account_id;
    return query select false, 'trial_expired'::text, 'expired'::text,
      greatest(v_row.max_messages - v_row.used_messages, 0),
      greatest(v_row.max_actions - v_row.used_actions, 0),
      greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
      v_row.trial_expires_at;
    return;
  end if;

  if v_row.status = 'quota_exceeded' and (v_msg + v_act) = 0 and v_cost = 0 then
    return query select false, 'message_limit_reached'::text, 'quota_exceeded'::text,
      greatest(v_row.max_messages - v_row.used_messages, 0),
      greatest(v_row.max_actions - v_row.used_actions, 0),
      greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
      v_row.trial_expires_at;
    return;
  end if;

  if (v_row.used_messages + v_msg) > v_row.max_messages then
    update public.nh_tenant_trials
      set status = 'quota_exceeded', updated_at = p_now
      where client_account_id = p_client_account_id;
    return query select false, 'message_limit_reached'::text, 'quota_exceeded'::text,
      greatest(v_row.max_messages - v_row.used_messages, 0),
      greatest(v_row.max_actions - v_row.used_actions, 0),
      greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
      v_row.trial_expires_at;
    return;
  end if;

  if (v_row.used_actions + v_act) > v_row.max_actions then
    update public.nh_tenant_trials
      set status = 'quota_exceeded', updated_at = p_now
      where client_account_id = p_client_account_id;
    return query select false, 'action_limit_reached'::text, 'quota_exceeded'::text,
      greatest(v_row.max_messages - v_row.used_messages, 0),
      greatest(v_row.max_actions - v_row.used_actions, 0),
      greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
      v_row.trial_expires_at;
    return;
  end if;

  if (v_row.spent_usd + v_cost) > v_row.spending_cap_usd then
    update public.nh_tenant_trials
      set status = 'quota_exceeded', updated_at = p_now
      where client_account_id = p_client_account_id;
    return query select false, 'spending_cap_reached'::text, 'quota_exceeded'::text,
      greatest(v_row.max_messages - v_row.used_messages, 0),
      greatest(v_row.max_actions - v_row.used_actions, 0),
      greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
      v_row.trial_expires_at;
    return;
  end if;

  update public.nh_tenant_trials
    set used_messages = v_row.used_messages + v_msg,
        used_actions = v_row.used_actions + v_act,
        spent_usd = v_row.spent_usd + v_cost,
        status = case
          when (v_row.used_messages + v_msg) >= v_row.max_messages then 'quota_exceeded'
          else 'active'
        end,
        updated_at = p_now
    where client_account_id = p_client_account_id
    returning * into v_row;

  return query select true, 'ok'::text, v_row.status,
    greatest(v_row.max_messages - v_row.used_messages, 0),
    greatest(v_row.max_actions - v_row.used_actions, 0),
    greatest(v_row.spending_cap_usd - v_row.spent_usd, 0),
    v_row.trial_expires_at;
end;
$$;

revoke all on function public.nh_consume_trial_allowance(bigint, integer, integer, numeric, timestamptz) from public, anon, authenticated;
grant execute on function public.nh_consume_trial_allowance(bigint, integer, integer, numeric, timestamptz) to service_role;

create or replace function public.nh_claim_activation_code(p_code_hash text)
returns table (
  id bigint,
  client_account_id bigint,
  department text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.activation_codes%rowtype;
begin
  select * into v_code
  from public.activation_codes
  where code_hash = p_code_hash
    and status = 'active'
    and used_count < max_uses
    and (expires_at is null or expires_at > now())
  for update;

  if not found then
    return;
  end if;

  update public.activation_codes
    set used_count = v_code.used_count + 1
    where public.activation_codes.id = v_code.id;

  return query select v_code.id, v_code.client_account_id, v_code.department;
end;
$$;

revoke all on function public.nh_claim_activation_code(text) from public, anon, authenticated;
grant execute on function public.nh_claim_activation_code(text) to service_role;

alter table public.nh_tenant_trials enable row level security;
alter table public.nh_agent_workflows enable row level security;
alter table public.nh_line_group_bindings enable row level security;
alter table public.nh_conversation_states enable row level security;
alter table public.nh_dev_lessons enable row level security;

revoke all on public.nh_tenant_trials, public.nh_agent_workflows, public.nh_line_group_bindings, public.nh_conversation_states, public.nh_dev_lessons from public, anon, authenticated;
grant select on public.nh_tenant_trials, public.nh_agent_workflows, public.nh_line_group_bindings, public.nh_conversation_states to authenticated;
grant all on public.nh_tenant_trials, public.nh_agent_workflows, public.nh_line_group_bindings, public.nh_conversation_states, public.nh_dev_lessons to service_role;

do $$
declare
  tenant_check constant text := $c$
    client_account_id = (
      case
        when (auth.jwt() -> 'app_metadata' ->> 'provider') in ('line', 'trial_web')
          and (auth.jwt() -> 'app_metadata' ->> 'client_account_id') ~ '^[0-9]{1,18}$'
        then (auth.jwt() -> 'app_metadata' ->> 'client_account_id')::bigint
      end
    )
  $c$;
begin
  execute 'drop policy if exists "Tenants view own trial" on public.nh_tenant_trials';
  execute format('create policy "Tenants view own trial" on public.nh_tenant_trials for select to authenticated using (%s)', tenant_check);

  execute 'drop policy if exists "Tenants view own workflows" on public.nh_agent_workflows';
  execute format('create policy "Tenants view own workflows" on public.nh_agent_workflows for select to authenticated using (%s)', tenant_check);

  execute 'drop policy if exists "Tenants view own LINE group bindings" on public.nh_line_group_bindings';
  execute format('create policy "Tenants view own LINE group bindings" on public.nh_line_group_bindings for select to authenticated using (%s)', tenant_check);

  execute 'drop policy if exists "Tenants view own conversation states" on public.nh_conversation_states';
  execute format('create policy "Tenants view own conversation states" on public.nh_conversation_states for select to authenticated using (%s)', tenant_check);
end $$;

commit;

begin;

create table if not exists public.nh_org_teams (
  team_id text primary key,
  name text not null,
  tier text not null check (tier in ('command', 'operations', 'customer', 'growth', 'governance')),
  manager_agent_id text not null,
  mission text not null,
  channels jsonb not null default '[]'::jsonb,
  team_learning_file text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nh_org_agents (
  agent_id text primary key,
  display_name text not null,
  team_id text not null references public.nh_org_teams(team_id) on delete restrict,
  role text not null,
  is_manager boolean not null default false,
  manager_agent_id text,
  responsibilities jsonb not null default '[]'::jsonb,
  channels jsonb not null default '[]'::jsonb,
  individual_learning_file text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_nh_org_agents_team on public.nh_org_agents(team_id);

create table if not exists public.nh_agent_individual_learning (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.nh_org_agents(agent_id) on delete restrict,
  team_id text not null references public.nh_org_teams(team_id) on delete restrict,
  case_key text not null check (case_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,95}$'),
  title text not null,
  context_summary text not null,
  observation text not null,
  verified_action text not null,
  evidence_ref text not null default 'verified-run',
  outcome text not null default 'verified' check (outcome in ('verified', 'improved', 'error_prevented', 'needs_review')),
  severity text not null default 'info' check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  unique (agent_id, case_key),
  unique (agent_id, id),
  foreign key (agent_id, supersedes_id) references public.nh_agent_individual_learning(agent_id, id) on delete restrict
);

create index if not exists idx_nh_ind_learning_agent_created on public.nh_agent_individual_learning(agent_id, created_at desc);

create table if not exists public.nh_team_learning (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.nh_org_teams(team_id) on delete restrict,
  pattern_key text not null check (pattern_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,95}$'),
  title text not null,
  standard_playbook text not null,
  guardrail_rule text not null,
  source_case_keys jsonb not null default '[]'::jsonb,
  curated_by text not null references public.nh_org_agents(agent_id) on delete restrict,
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  unique (team_id, pattern_key),
  unique (team_id, id),
  foreign key (team_id, supersedes_id) references public.nh_team_learning(team_id, id) on delete restrict
);

create index if not exists idx_nh_team_learning_team_created on public.nh_team_learning(team_id, created_at desc);

create table if not exists public.nh_central_council_tasks (
  id uuid primary key default gen_random_uuid(),
  command_text text not null,
  requested_by text not null default 'founder',
  target_channel text not null default 'founder' check (target_channel in ('line_user', 'line_group', 'founder', 'web', 'notion')),
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'awaiting_governance', 'completed', 'blocked')),
  council_discussion jsonb not null default '[]'::jsonb,
  governance_signoff_required jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nh_reports (
  id uuid primary key default gen_random_uuid(),
  report_code text not null unique,
  team_id text not null references public.nh_org_teams(team_id) on delete restrict,
  author_agent_id text not null references public.nh_org_agents(agent_id) on delete restrict,
  channel text not null check (channel in ('line_user', 'line_group', 'founder', 'web', 'notion')),
  title text not null,
  summary text not null,
  metrics jsonb not null default '{}'::jsonb,
  delivery_status text not null default 'recorded' check (delivery_status in ('recorded', 'dispatched', 'delivery_failed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_nh_reports_channel_created on public.nh_reports(channel, created_at desc);

create table if not exists public.nh_governance_audits (
  id uuid primary key default gen_random_uuid(),
  overall_status text not null check (overall_status in ('pass', 'attention_required', 'fail')),
  health_result jsonb not null,
  security_result jsonb not null,
  audit_result jsonb not null,
  audited_at timestamptz not null default now()
);

create or replace function public.nh_prevent_learning_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'append-only ledger: % is forbidden on %; append a new record linked via supersedes_id', tg_op, tg_table_name
    using errcode = '42501';
end;
$$;

create or replace function public.nh_check_individual_learning_agent_team()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  expected_team text;
begin
  select team_id into expected_team from public.nh_org_agents where agent_id = new.agent_id;
  if expected_team is null or expected_team <> new.team_id then
    raise exception 'individual learning cross-team mismatch for agent % (expected %, got %)', new.agent_id, expected_team, new.team_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.nh_prevent_learning_mutation() from public, anon, authenticated;
revoke all on function public.nh_check_individual_learning_agent_team() from public, anon, authenticated;

drop trigger if exists trg_nh_ind_learning_append_only on public.nh_agent_individual_learning;
create trigger trg_nh_ind_learning_append_only
  before update or delete on public.nh_agent_individual_learning
  for each row execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_ind_learning_no_truncate on public.nh_agent_individual_learning;
create trigger trg_nh_ind_learning_no_truncate
  before truncate on public.nh_agent_individual_learning
  for each statement execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_ind_learning_agent_team on public.nh_agent_individual_learning;
create trigger trg_nh_ind_learning_agent_team
  before insert on public.nh_agent_individual_learning
  for each row execute function public.nh_check_individual_learning_agent_team();

drop trigger if exists trg_nh_team_learning_append_only on public.nh_team_learning;
create trigger trg_nh_team_learning_append_only
  before update or delete on public.nh_team_learning
  for each row execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_team_learning_no_truncate on public.nh_team_learning;
create trigger trg_nh_team_learning_no_truncate
  before truncate on public.nh_team_learning
  for each statement execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_reports_append_only on public.nh_reports;
create trigger trg_nh_reports_append_only
  before update or delete on public.nh_reports
  for each row execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_reports_no_truncate on public.nh_reports;
create trigger trg_nh_reports_no_truncate
  before truncate on public.nh_reports
  for each statement execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_governance_audits_append_only on public.nh_governance_audits;
create trigger trg_nh_governance_audits_append_only
  before update or delete on public.nh_governance_audits
  for each row execute function public.nh_prevent_learning_mutation();

drop trigger if exists trg_nh_governance_audits_no_truncate on public.nh_governance_audits;
create trigger trg_nh_governance_audits_no_truncate
  before truncate on public.nh_governance_audits
  for each statement execute function public.nh_prevent_learning_mutation();

insert into public.nh_org_teams (team_id, name, tier, manager_agent_id, mission, channels, team_learning_file)
values
  ('central-command', 'Central Executive Command & Strategy Council', 'command', 'cmd-director', 'Receive Founder commands, lead cross-team strategy discussion, divide work cleanly across Team Managers, and reconcile final verified outcomes.', '["line_user","founder","web","notion"]'::jsonb, 'platform/docs/org/learning/teams/central-command.json'),
  ('line-biz-console', 'LINE Business & Console Development Team', 'operations', 'line-manager', 'Connect LINE OA 1:1 & group chats, Rich Menus, Flex Cards, report reading/creation, and multi-channel dispatch with GitHub, Supabase, Railway, and LangSmith.', '["line_user","line_group","founder","web"]'::jsonb, 'platform/docs/org/learning/teams/line-biz-console.json'),
  ('website-brand-ux', 'Website & Brand Synchronized Specialist Team', 'operations', 'web-manager', 'Synchronize /neurohands, typography, Midnight Navy + Electric Cyan mood & tone, visual guides, and mission/vision storytelling across phone, tablet, and laptop.', '["web","line_user"]'::jsonb, 'platform/docs/org/learning/teams/website-brand-ux.json'),
  ('business-dx', 'Business, Content & Digital Transformation Team', 'operations', 'dx-manager', 'Polish bilingual content, SOPs, digital transformation workflows, and cross-team operational efficiency.', '["web","notion","line_user"]'::jsonb, 'platform/docs/org/learning/teams/business-dx.json'),
  ('ai-engineering-arch', 'AI Engineering & Architecture Team (FE + BE)', 'operations', 'eng-manager', 'Architect frontend & backend data structures, zero-error service guardrails, deterministic tests, and structured error-to-fix learning patterns.', '["web","founder","notion"]'::jsonb, 'platform/docs/org/learning/teams/ai-engineering-arch.json'),
  ('customer-service', 'Customer Service Team (Frontline)', 'customer', 'cs-manager', 'Serve active customer inquiries, grounded price quotes, order status, and lead times with seamless human handover.', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/teams/customer-service.json'),
  ('after-service', 'After-Service & Care Team (Separate Role)', 'customer', 'after-manager', 'Handle post-delivery warranty claims, damage/defect resolution, satisfaction follow-ups, and retention care strictly separated from frontline sales/CS.', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/teams/after-service.json'),
  ('sales-marketing', 'Sales & Marketing Team', 'growth', 'growth-manager', 'Qualify B2B leads, prepare grounded quotation briefs, craft brand proposals and campaigns, and route discount approvals to humans.', '["line_user","line_group","web","notion"]'::jsonb, 'platform/docs/org/learning/teams/sales-marketing.json'),
  ('health-monitor', 'Final Governance Team 1 — Health & Reliability', 'governance', 'health-manager', 'Monitor live uptime (/ready, /version), <2.5s Race SLA, provider circuit breakers, and cross-platform connector health.', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/teams/health-monitor.json'),
  ('security-guard', 'Final Governance Team 2 — Security & Privacy', 'governance', 'sec-manager', 'Verify app_metadata RLS isolation, zero PII/secret/code leaks, path traversal guards, Flex URI allowlists, and fail-closed error handling.', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/teams/security-guard.json'),
  ('audit-compliance', 'Final Governance Team 3 — Audit & Command Compliance', 'governance', 'audit-manager', 'Audit all teams for zero duplication, zero erasure, isolated individual vs team learning integrity, and strict execution under Founder prompts and rules.', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/teams/audit-compliance.json')
on conflict (team_id) do nothing;

insert into public.nh_org_agents (agent_id, display_name, team_id, role, is_manager, manager_agent_id, channels, individual_learning_file)
values
  ('cmd-director', 'Neurohands Central Director', 'central-command', 'Executive Coordinator & Final Synthesizer', true, null, '["founder","line_user","web","notion"]'::jsonb, 'platform/docs/org/learning/individual/cmd-director.jsonl'),
  ('cmd-planner', 'Strategic Task Divider', 'central-command', 'Strategy & Decomposition Specialist', false, 'cmd-director', '["founder","notion"]'::jsonb, 'platform/docs/org/learning/individual/cmd-planner.jsonl'),
  ('cmd-synthesizer', 'Cross-Team Reconciler', 'central-command', 'Evidence & Multi-Platform Sync Specialist', false, 'cmd-director', '["founder","notion","web"]'::jsonb, 'platform/docs/org/learning/individual/cmd-synthesizer.jsonl'),
  ('line-manager', 'LINE Ops Manager', 'line-biz-console', 'LINE Business & Console Team Manager', true, 'cmd-director', '["line_user","line_group","founder"]'::jsonb, 'platform/docs/org/learning/individual/line-manager.jsonl'),
  ('line-console-architect', 'LINE Console & Flex Architect', 'line-biz-console', 'Rich Menu, LIFF & Flex Message Specialist', false, 'line-manager', '["line_user","line_group"]'::jsonb, 'platform/docs/org/learning/individual/line-console-architect.jsonl'),
  ('line-channel-tester', 'LINE Channel & Report Specialist', 'line-biz-console', '1:1/Group Test & Report Dispatch Specialist', false, 'line-manager', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/individual/line-channel-tester.jsonl'),
  ('line-connector-sync', 'Platform Connector Engineer', 'line-biz-console', 'GitHub/Supabase/Railway/LangSmith Integration Specialist', false, 'line-manager', '["founder","web"]'::jsonb, 'platform/docs/org/learning/individual/line-connector-sync.jsonl'),
  ('web-manager', 'Website & Brand Director', 'website-brand-ux', 'Website Specialist Team Manager', true, 'cmd-director', '["web","notion"]'::jsonb, 'platform/docs/org/learning/individual/web-manager.jsonl'),
  ('web-brand-designer', 'Brand Font, Mood & Visual Designer', 'website-brand-ux', 'Brand Mood, Typography & HTML-to-PNG Visual Specialist', false, 'web-manager', '["web","line_user"]'::jsonb, 'platform/docs/org/learning/individual/web-brand-designer.jsonl'),
  ('web-ux-architect', 'Guided UX & Responsive Architect', 'website-brand-ux', 'Guided Process Flow & Multi-Device UX Specialist', false, 'web-manager', '["web"]'::jsonb, 'platform/docs/org/learning/individual/web-ux-architect.jsonl'),
  ('dx-manager', 'Digital Transformation Manager', 'business-dx', 'Business & DX Team Manager', true, 'cmd-director', '["notion","web","founder"]'::jsonb, 'platform/docs/org/learning/individual/dx-manager.jsonl'),
  ('dx-content-polisher', 'Bilingual Content & Playbook Polisher', 'business-dx', 'Human-Friendly Bilingual Copy Specialist', false, 'dx-manager', '["web","line_user","notion"]'::jsonb, 'platform/docs/org/learning/individual/dx-content-polisher.jsonl'),
  ('dx-workflow-optimizer', 'Cross-Team Process Architect', 'business-dx', 'SOP & Operational Efficiency Specialist', false, 'dx-manager', '["notion","founder"]'::jsonb, 'platform/docs/org/learning/individual/dx-workflow-optimizer.jsonl'),
  ('eng-manager', 'Chief AI Architect', 'ai-engineering-arch', 'AI Engineering & Architecture Team Manager', true, 'cmd-director', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/individual/eng-manager.jsonl'),
  ('eng-frontend-specialist', 'Frontend Interactive Engineer', 'ai-engineering-arch', 'Web UI & State Hydration Engineer', false, 'eng-manager', '["web"]'::jsonb, 'platform/docs/org/learning/individual/eng-frontend-specialist.jsonl'),
  ('eng-backend-guardrail', 'Backend Data & Guardrail Engineer', 'ai-engineering-arch', 'PostgreSQL Schema, API & Fail-Closed Guardrail Engineer', false, 'eng-manager', '["web","line_user","line_group"]'::jsonb, 'platform/docs/org/learning/individual/eng-backend-guardrail.jsonl'),
  ('eng-learning-curator', 'Error & Learning Pattern Curator', 'ai-engineering-arch', 'Regression Test & Development Pattern Specialist', false, 'eng-manager', '["notion","founder"]'::jsonb, 'platform/docs/org/learning/individual/eng-learning-curator.jsonl'),
  ('cs-manager', 'Customer Service Manager', 'customer-service', 'Frontline Customer Service Team Manager', true, 'cmd-director', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/individual/cs-manager.jsonl'),
  ('cs-aria-frontline', 'Aria — Frontline Inquiry & Quote Specialist', 'customer-service', 'Customer Inquiry & Grounded Quotation Agent', false, 'cs-manager', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/individual/cs-aria-frontline.jsonl'),
  ('cs-order-tracker', 'Order & Lead-Time Desk Specialist', 'customer-service', 'Order Tracking & Delivery ETA Agent', false, 'cs-manager', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/individual/cs-order-tracker.jsonl'),
  ('after-manager', 'After-Service Manager', 'after-service', 'Post-Delivery After-Service Team Manager', true, 'cmd-director', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/individual/after-manager.jsonl'),
  ('after-warranty-care', 'Warranty & Claims Care Specialist', 'after-service', 'Post-Delivery Defect, Claim & Replacement Agent', false, 'after-manager', '["line_user","web"]'::jsonb, 'platform/docs/org/learning/individual/after-warranty-care.jsonl'),
  ('after-retention-followup', 'Post-Installation Follow-Up Specialist', 'after-service', 'Customer Satisfaction & Retention Care Agent', false, 'after-manager', '["line_user","web"]'::jsonb, 'platform/docs/org/learning/individual/after-retention-followup.jsonl'),
  ('growth-manager', 'Sales & Marketing Manager', 'sales-marketing', 'Sales & Marketing Team Manager', true, 'cmd-director', '["line_user","line_group","web","notion"]'::jsonb, 'platform/docs/org/learning/individual/growth-manager.jsonl'),
  ('sales-suri-closer', 'Suri — Sales Qualification Specialist', 'sales-marketing', 'B2B Lead Qualification & Quotation Brief Agent', false, 'growth-manager', '["line_user","line_group","web"]'::jsonb, 'platform/docs/org/learning/individual/sales-suri-closer.jsonl'),
  ('mkt-mira-campaigns', 'Mira — Campaigns & Proposal Specialist', 'sales-marketing', 'B2B Proposal & Brand Campaign Agent', false, 'growth-manager', '["web","notion","line_user"]'::jsonb, 'platform/docs/org/learning/individual/mkt-mira-campaigns.jsonl'),
  ('health-manager', 'Health & SLA Manager', 'health-monitor', 'Final Governance — Health Team Manager', true, 'cmd-director', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/individual/health-manager.jsonl'),
  ('health-sla-sentinel', 'Uptime & Connector Sentinel', 'health-monitor', 'Live Telemetry & Connector Probe Agent', false, 'health-manager', '["founder","web"]'::jsonb, 'platform/docs/org/learning/individual/health-sla-sentinel.jsonl'),
  ('sec-manager', 'Chief Security Officer Agent', 'security-guard', 'Final Governance — Security Team Manager', true, 'cmd-director', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/individual/sec-manager.jsonl'),
  ('sec-rls-redteam', 'RLS, PDPA & Red-Team Specialist', 'security-guard', 'Adversarial Security & Privacy Auditor', false, 'sec-manager', '["founder","notion"]'::jsonb, 'platform/docs/org/learning/individual/sec-rls-redteam.jsonl'),
  ('audit-manager', 'Chief Audit & Compliance Manager', 'audit-compliance', 'Final Governance — Audit Team Manager', true, 'cmd-director', '["founder","web","notion"]'::jsonb, 'platform/docs/org/learning/individual/audit-manager.jsonl'),
  ('audit-rule-verifier', 'Append-Only & Rule Compliance Auditor', 'audit-compliance', 'Learning Isolation & Evidence Verification Specialist', false, 'audit-manager', '["founder","notion"]'::jsonb, 'platform/docs/org/learning/individual/audit-rule-verifier.jsonl')
on conflict (agent_id) do nothing;

alter table public.nh_org_teams enable row level security;
alter table public.nh_org_agents enable row level security;
alter table public.nh_agent_individual_learning enable row level security;
alter table public.nh_team_learning enable row level security;
alter table public.nh_central_council_tasks enable row level security;
alter table public.nh_reports enable row level security;
alter table public.nh_governance_audits enable row level security;

revoke all on
  public.nh_org_teams,
  public.nh_org_agents,
  public.nh_agent_individual_learning,
  public.nh_team_learning,
  public.nh_central_council_tasks,
  public.nh_reports,
  public.nh_governance_audits
from public, anon, authenticated;

grant select on public.nh_org_teams, public.nh_org_agents to authenticated;

revoke all on
  public.nh_agent_individual_learning,
  public.nh_team_learning,
  public.nh_reports,
  public.nh_governance_audits
from service_role;

grant all on
  public.nh_org_teams,
  public.nh_org_agents,
  public.nh_central_council_tasks
to service_role;

grant select, insert on
  public.nh_agent_individual_learning,
  public.nh_team_learning,
  public.nh_reports,
  public.nh_governance_audits
to service_role;

drop policy if exists "Authenticated view org teams" on public.nh_org_teams;
create policy "Authenticated view org teams"
  on public.nh_org_teams for select to authenticated using (true);

drop policy if exists "Authenticated view org agents" on public.nh_org_agents;
create policy "Authenticated view org agents"
  on public.nh_org_agents for select to authenticated using (true);

commit;

do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    insert into supabase_migrations.schema_migrations (version, name)
    values
      ('20261117000001', 'dashboard_realtime_telemetry'),
      ('20261122000001', 'customer_trial_release'),
      ('20261122000002', 'ai_org_learning_and_reports')
    on conflict (version) do nothing;
  end if;
end $$;
