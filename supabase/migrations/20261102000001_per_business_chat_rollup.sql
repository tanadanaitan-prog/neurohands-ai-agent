-- Additive per-business chat counting (TASK-038 / G8), tenant product scoping (P0 / G5),
-- and document/catalog expiry timestamps (G15).
begin;

alter table public.messages
  add column if not exists client_account_id bigint references public.client_accounts(id),
  add column if not exists run_id bigint references public.agent_runs(id);

create index if not exists messages_business_created_idx
  on public.messages(client_account_id, created_at desc)
  where client_account_id is not null;

create index if not exists messages_run_idx
  on public.messages(run_id)
  where run_id is not null;

alter table public.glass_types
  add column if not exists client_account_id bigint references public.client_accounts(id),
  add column if not exists expires_at timestamptz;

alter table public.edging_services
  add column if not exists client_account_id bigint references public.client_accounts(id),
  add column if not exists expires_at timestamptz;

alter table public.client_documents
  add column if not exists expires_at timestamptz;

-- Inbound LINE messages are recorded before activation checks so redaction holds;
-- resolve active business ownership automatically when client_account_id is omitted.
create or replace function public.nh_messages_resolve_business()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id bigint;
begin
  if new.client_account_id is null and new.line_user_id is not null and coalesce(new.answered_by, '') <> 'jarvis' then
    select b.client_account_id
      into v_account_id
      from public.client_agent_bindings b
      join public.client_accounts a on a.id = b.client_account_id and a.active = true
     where b.line_user_id = new.line_user_id
       and b.status = 'active'
     order by b.activated_at desc, b.id desc
     limit 1;
    if v_account_id is not null then
      new.client_account_id := v_account_id;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.nh_messages_resolve_business() from public, anon, authenticated;

drop trigger if exists nh_messages_resolve_business_trg on public.messages;
create trigger nh_messages_resolve_business_trg
  before insert on public.messages
  for each row execute function public.nh_messages_resolve_business();

create or replace function public.nh_count_business_chats(
  p_client_account_id bigint,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  client_account_id bigint,
  inbound_messages bigint,
  outbound_messages bigint,
  completed_agent_runs bigint,
  unique_line_users bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with scoped_messages as (
    select m.direction, m.line_user_id
      from public.messages m
     where m.client_account_id = p_client_account_id
       and coalesce(m.answered_by, '') not in ('jarvis', 'concierge', 'demo_flow')
       and (p_since is null or m.created_at >= p_since)
       and (p_until is null or m.created_at < p_until)
  ),
  scoped_runs as (
    select r.id, r.line_user_id
      from public.agent_runs r
     where r.client_account_id = p_client_account_id
       and r.status = 'completed'
       and (p_since is null or r.created_at >= p_since)
       and (p_until is null or r.created_at < p_until)
  )
  select
    p_client_account_id as client_account_id,
    count(*) filter (where sm.direction = 'in')::bigint as inbound_messages,
    count(*) filter (where sm.direction = 'out')::bigint as outbound_messages,
    (select count(*)::bigint from scoped_runs) as completed_agent_runs,
    count(distinct sm.line_user_id)::bigint as unique_line_users
  from scoped_messages sm;
$$;

revoke all on function public.nh_count_business_chats(bigint, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.nh_count_business_chats(bigint, timestamptz, timestamptz) to service_role;

commit;
