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
