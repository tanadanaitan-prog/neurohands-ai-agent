-- Record Jarvis operator conversations without assigning them to a customer.
-- Existing and omitted run kinds remain client runs and still require an account.
-- Classification is not authorization: RLS, role grants and existing foreign keys
-- are inherited unchanged from the Phase 1 schema.
alter table public.agent_runs
  add column run_kind text not null default 'client'
    constraint agent_runs_run_kind_check check (run_kind in ('client', 'operator')),
  add column delivered_at timestamptz,
  alter column client_account_id drop not null,
  add constraint agent_runs_run_scope_check check (
    (run_kind = 'client' and client_account_id is not null)
    or
    (run_kind = 'operator' and client_account_id is null
      and agent_code is null and department = 'operations')
  );

comment on column public.agent_runs.run_kind is
  'client requires client_account_id; operator requires no client or agent assignment and operations department. Does not grant operator access.';

comment on column public.agent_runs.delivered_at is
  'Recorded only after LINE delivery and its outbound log succeed. NULL means no recorded delivery confirmation, including historical rows.';

-- Only confirmed delivery enters operator context, even if an error-status write failed.
create index agent_runs_operator_history_idx
  on public.agent_runs (line_user_id, created_at desc, id desc)
  where run_kind = 'operator' and status = 'completed' and delivered_at is not null;

-- Natural-language proposals retain the operator run that produced them.
-- Historical notes and explicit commands without a source run stay compatible.
alter table public.jarvis_notes
  add column source_run_id bigint references public.agent_runs(id);

create index jarvis_notes_source_run_idx on public.jarvis_notes (source_run_id);

comment on column public.jarvis_notes.source_run_id is
  'Originating run for a proposed operation. NULL for historical notes or explicit commands without an agent run. Approved execution can attach its tool trace to this same run.';
