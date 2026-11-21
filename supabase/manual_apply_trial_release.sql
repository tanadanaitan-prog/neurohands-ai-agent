-- Neurohands Customer-Trial Release Combined Idempotent SQL Bundle
-- Paste into Supabase SQL Editor for project darxiaearohhnxiwhcbs and click Run.
-- Includes migrations 20261117000001_dashboard_realtime_telemetry and 20261122000001_customer_trial_release.
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
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    insert into supabase_migrations.schema_migrations (version, name)
    values
      ('20261117000001', 'dashboard_realtime_telemetry'),
      ('20261122000001', 'customer_trial_release')
    on conflict (version) do nothing;
  end if;
end $$;
