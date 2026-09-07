-- Additive workspace foundation. Existing Neurohands tables are not modified.
begin;

create table public.nh_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  created_at timestamptz not null default now()
);
create index nh_workspaces_owner_idx on public.nh_workspaces(owner_id);

create table public.nh_memberships (
  workspace_id uuid not null references public.nh_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('admin', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  primary key(workspace_id, user_id)
);
create index nh_memberships_user_idx on public.nh_memberships(user_id, workspace_id);

alter table public.nh_workspaces enable row level security;
alter table public.nh_memberships enable row level security;
revoke all on public.nh_workspaces, public.nh_memberships from public, anon, authenticated;
grant select, insert on public.nh_workspaces to authenticated;
grant update(name) on public.nh_workspaces to authenticated;
grant select on public.nh_memberships to authenticated;
grant all on public.nh_workspaces, public.nh_memberships to service_role;

-- Membership administration is server-only. Self-only visibility avoids recursive RLS.
create policy nh_memberships_self_read on public.nh_memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy nh_workspaces_read on public.nh_workspaces for select to authenticated
  using (owner_id = (select auth.uid()) or id in (
    select workspace_id from public.nh_memberships where user_id = (select auth.uid())
  ));
create policy nh_workspaces_create on public.nh_workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy nh_workspaces_rename on public.nh_workspaces for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create function public.nh_can_access(p_workspace_id uuid, p_permission text default 'view')
returns boolean language sql stable security invoker set search_path = '' as $$
  select (select auth.uid()) is not null and p_permission in ('view', 'operate', 'manage') and (
    exists (select 1 from public.nh_workspaces w where w.id = p_workspace_id and w.owner_id = (select auth.uid()))
    or exists (
      select 1 from public.nh_memberships m
      where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid())
        and (p_permission = 'view' or m.role = 'admin' or (p_permission = 'operate' and m.role = 'operator'))
    )
  );
$$;
revoke all on function public.nh_can_access(uuid, text) from public, anon;
grant execute on function public.nh_can_access(uuid, text) to authenticated, service_role;

create table public.nh_departments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.nh_workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  sort_order integer not null default 0 check (sort_order >= 0),
  unique(id, workspace_id), unique(workspace_id, name)
);

create table public.nh_teams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.nh_workspaces(id) on delete cascade,
  department_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  unique(id, department_id, workspace_id), unique(department_id, name),
  foreign key(department_id, workspace_id) references public.nh_departments(id, workspace_id)
);
create index nh_teams_workspace_idx on public.nh_teams(workspace_id);

create table public.nh_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.nh_workspaces(id) on delete cascade,
  department_id uuid not null,
  team_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  role text not null check (char_length(btrim(role)) between 1 and 160),
  responsibilities text[] not null default '{}' check (cardinality(responsibilities) <= 30),
  instructions text not null default '' check (char_length(instructions) <= 12000),
  tool_ids text[] not null default '{}' check (cardinality(tool_ids) <= 40),
  model_provider text not null default 'gemini' check (model_provider in ('gemini', 'groq')),
  model_id text not null default '' check (char_length(model_id) <= 160),
  status text not null default 'draft' check (status in ('draft', 'ready', 'paused')),
  sort_order integer not null default 0 check (sort_order >= 0),
  version integer not null default 1 check (version > 0),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, workspace_id),
  foreign key(department_id, workspace_id) references public.nh_departments(id, workspace_id),
  foreign key(team_id, department_id, workspace_id) references public.nh_teams(id, department_id, workspace_id)
);
create index nh_agents_department_idx on public.nh_agents(department_id, workspace_id, sort_order);
create index nh_agents_workspace_idx on public.nh_agents(workspace_id);
create index nh_agents_team_idx on public.nh_agents(team_id, department_id, workspace_id);
create index nh_agents_creator_idx on public.nh_agents(created_by);

create function public.nh_agent_revision() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.nh_agent_revision() from public, anon, authenticated;
create trigger nh_agent_revision before update on public.nh_agents
  for each row execute function public.nh_agent_revision();

create table public.nh_agent_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.nh_workspaces(id),
  agent_id uuid not null,
  revision integer not null check (revision > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  published_by uuid not null default auth.uid() references auth.users(id),
  published_at timestamptz not null default now(),
  unique(agent_id, revision),
  foreign key(agent_id, workspace_id) references public.nh_agents(id, workspace_id)
);
create index nh_agent_versions_workspace_idx on public.nh_agent_versions(workspace_id);
create index nh_agent_versions_publisher_idx on public.nh_agent_versions(published_by);

alter table public.nh_departments enable row level security;
alter table public.nh_teams enable row level security;
alter table public.nh_agents enable row level security;
alter table public.nh_agent_versions enable row level security;
revoke all on public.nh_departments, public.nh_teams, public.nh_agents, public.nh_agent_versions from public, anon, authenticated;
grant select, insert on public.nh_departments, public.nh_teams, public.nh_agents, public.nh_agent_versions to authenticated;
grant update(name, sort_order) on public.nh_departments to authenticated;
grant update(name) on public.nh_teams to authenticated;
grant update(department_id, team_id, name, role, responsibilities, instructions, tool_ids, model_provider, model_id, status, sort_order) on public.nh_agents to authenticated;
grant all on public.nh_departments, public.nh_teams, public.nh_agents, public.nh_agent_versions to service_role;

create policy nh_departments_read on public.nh_departments for select to authenticated using (public.nh_can_access(workspace_id));
create policy nh_departments_insert on public.nh_departments for insert to authenticated with check (public.nh_can_access(workspace_id, 'manage'));
create policy nh_departments_update on public.nh_departments for update to authenticated using (public.nh_can_access(workspace_id, 'manage')) with check (public.nh_can_access(workspace_id, 'manage'));
create policy nh_teams_read on public.nh_teams for select to authenticated using (public.nh_can_access(workspace_id));
create policy nh_teams_insert on public.nh_teams for insert to authenticated with check (public.nh_can_access(workspace_id, 'manage'));
create policy nh_teams_update on public.nh_teams for update to authenticated using (public.nh_can_access(workspace_id, 'manage')) with check (public.nh_can_access(workspace_id, 'manage'));
create policy nh_agents_read on public.nh_agents for select to authenticated using (public.nh_can_access(workspace_id));
create policy nh_agents_insert on public.nh_agents for insert to authenticated with check (public.nh_can_access(workspace_id, 'manage') and created_by = (select auth.uid()));
create policy nh_agents_update on public.nh_agents for update to authenticated using (public.nh_can_access(workspace_id, 'manage')) with check (public.nh_can_access(workspace_id, 'manage'));
create policy nh_agent_versions_read on public.nh_agent_versions for select to authenticated using (public.nh_can_access(workspace_id));
create policy nh_agent_versions_insert on public.nh_agent_versions for insert to authenticated with check (public.nh_can_access(workspace_id, 'manage') and published_by = (select auth.uid()));

create function public.nh_create_workspace(p_name text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_workspace_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.nh_workspaces(owner_id, name) values ((select auth.uid()), btrim(p_name)) returning id into v_workspace_id;
  insert into public.nh_departments(workspace_id, name, sort_order)
  select v_workspace_id, name, ordinality::integer from unnest(array[
    'Sales', 'Marketing', 'Finance', 'Accounting', 'Human Resources',
    'Research & Development', 'IT', 'Data Analysis', 'AI Engineering', 'Operations'
  ]) with ordinality as department(name, ordinality);
  return v_workspace_id;
end;
$$;
revoke all on function public.nh_create_workspace(text) from public, anon;
grant execute on function public.nh_create_workspace(text) to authenticated;

create function public.nh_publish_agent(p_agent_id uuid, p_expected_version integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_agent public.nh_agents; v_version_id uuid; v_revision integer;
begin
  select * into v_agent from public.nh_agents where id = p_agent_id for update;
  if not found or not public.nh_can_access(v_agent.workspace_id, 'manage') then
    raise exception 'Agent unavailable' using errcode = '42501';
  end if;
  if v_agent.version <> p_expected_version then raise exception 'Agent changed; reload before publishing' using errcode = '40001'; end if;
  if cardinality(v_agent.responsibilities) = 0 then raise exception 'Add at least one responsibility before publishing' using errcode = '22023'; end if;
  select coalesce(max(revision), 0) + 1 into v_revision from public.nh_agent_versions where agent_id = v_agent.id;
  insert into public.nh_agent_versions(workspace_id, agent_id, revision, definition)
  values (v_agent.workspace_id, v_agent.id, v_revision, jsonb_build_object(
    'name', v_agent.name, 'role', v_agent.role, 'department_id', v_agent.department_id,
    'team_id', v_agent.team_id, 'responsibilities', v_agent.responsibilities,
    'instructions', v_agent.instructions, 'tool_ids', v_agent.tool_ids,
    'model_provider', v_agent.model_provider, 'model_id', v_agent.model_id
  )) returning id into v_version_id;
  update public.nh_agents set status = 'ready' where id = v_agent.id;
  return v_version_id;
end;
$$;
revoke all on function public.nh_publish_agent(uuid, integer) from public, anon;
grant execute on function public.nh_publish_agent(uuid, integer) to authenticated;

commit;
