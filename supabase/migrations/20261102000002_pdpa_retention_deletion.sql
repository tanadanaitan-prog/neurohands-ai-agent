-- PDPA retention purge and right-to-erasure RPCs (G3).
-- Deletes customer PII in child-to-parent FK order while detaching commercial order headers
-- required for accounting records, and records a non-PII SHA-256 audit receipt.
begin;

create or replace function public.nh_erase_line_user_data(
  p_line_user_id text,
  p_client_account_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user text := btrim(coalesce(p_line_user_id, ''));
  v_mem_deleted integer := 0;
  v_tasks_deleted integer := 0;
  v_cases_deleted integer := 0;
  v_esc_deleted integer := 0;
  v_fb_deleted integer := 0;
  v_docs_deleted integer := 0;
  v_msgs_deleted integer := 0;
  v_tools_deleted integer := 0;
  v_runs_deleted integer := 0;
  v_bindings_revoked integer := 0;
  v_clients_deleted integer := 0;
  v_run_ids bigint[];
  v_client_ids bigint[];
  v_subject_hash text;
begin
  if v_user = '' then
    raise exception 'p_line_user_id is required' using errcode = '22023';
  end if;

  select coalesce(array_agg(r.id), '{}')
    into v_run_ids
    from public.agent_runs r
   where r.line_user_id = v_user
     and (p_client_account_id is null or r.client_account_id = p_client_account_id)
     and r.client_account_id is not null;

  select coalesce(array_agg(c.id), '{}')
    into v_client_ids
    from public.clients c
   where c.line_user_id = v_user
     and (p_client_account_id is null or c.client_account_id = p_client_account_id);

  delete from public.agent_memory m
   where (m.line_user_id = v_user and (p_client_account_id is null or m.client_account_id = p_client_account_id))
      or m.source_run_id = any(v_run_ids);
  get diagnostics v_mem_deleted = row_count;

  delete from public.messages m
   where (m.line_user_id = v_user and (p_client_account_id is null or m.client_account_id = p_client_account_id or m.client_account_id is null))
      or m.run_id = any(v_run_ids)
      or m.client_id = any(v_client_ids);
  get diagnostics v_msgs_deleted = row_count;

  delete from public.tool_calls tc
   where tc.run_id = any(v_run_ids);
  get diagnostics v_tools_deleted = row_count;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jarvis_notes' and column_name = 'source_run_id'
  ) then
    execute 'update public.jarvis_notes set source_run_id = null where source_run_id = any($1)' using v_run_ids;
  end if;

  delete from public.agent_runs r
   where r.id = any(v_run_ids);
  get diagnostics v_runs_deleted = row_count;

  delete from public.agent_tasks t
   where t.line_user_id = v_user
     and (p_client_account_id is null or t.client_account_id = p_client_account_id);
  get diagnostics v_tasks_deleted = row_count;

  delete from public.support_cases sc
   where sc.line_user_id = v_user
     and (p_client_account_id is null or sc.client_account_id = p_client_account_id or sc.client_account_id is null);
  get diagnostics v_cases_deleted = row_count;

  delete from public.escalations e
   where e.line_user_id = v_user
     and (p_client_account_id is null or e.client_account_id = p_client_account_id);
  get diagnostics v_esc_deleted = row_count;

  if p_client_account_id is null then
    delete from public.bot_feedback bf where bf.line_user_id = v_user;
    get diagnostics v_fb_deleted = row_count;
  end if;

  delete from public.client_documents cd
   where cd.uploaded_by = v_user
     and (p_client_account_id is null or cd.client_account_id = p_client_account_id);
  get diagnostics v_docs_deleted = row_count;

  update public.client_agent_bindings b
     set status = 'revoked'
   where b.line_user_id = v_user
     and b.status <> 'revoked'
     and (p_client_account_id is null or b.client_account_id = p_client_account_id);
  get diagnostics v_bindings_revoked = row_count;

  if cardinality(v_client_ids) > 0 then
    update public.orders o set client_id = null where o.client_id = any(v_client_ids);
    delete from public.clients c where c.id = any(v_client_ids);
    get diagnostics v_clients_deleted = row_count;
  end if;

  v_subject_hash := encode(sha256(convert_to(v_user, 'UTF8')), 'hex');
  insert into public.jarvis_audit_log(event_type, detail, line_user_id)
  values ('pdpa_erasure', 'sha256:' || v_subject_hash, null);

  return jsonb_build_object(
    'erased', true,
    'subject_sha256', v_subject_hash,
    'memories_deleted', v_mem_deleted,
    'messages_deleted', v_msgs_deleted,
    'tool_calls_deleted', v_tools_deleted,
    'runs_deleted', v_runs_deleted,
    'tasks_deleted', v_tasks_deleted,
    'support_cases_deleted', v_cases_deleted,
    'escalations_deleted', v_esc_deleted,
    'feedback_deleted', v_fb_deleted,
    'documents_deleted', v_docs_deleted,
    'bindings_revoked', v_bindings_revoked,
    'clients_deleted', v_clients_deleted
  );
end;
$$;

create or replace function public.nh_purge_expired_customer_data(
  p_retention_days integer default 365
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz;
  v_mem_deleted integer := 0;
  v_msgs_deleted integer := 0;
  v_tools_deleted integer := 0;
  v_runs_deleted integer := 0;
  v_docs_deleted integer := 0;
  v_run_ids bigint[];
begin
  if p_retention_days is null or p_retention_days < 1 or p_retention_days > 3650 then
    raise exception 'p_retention_days must be between 1 and 3650' using errcode = '22023';
  end if;

  v_cutoff := now() - make_interval(days => p_retention_days);

  select coalesce(array_agg(r.id), '{}')
    into v_run_ids
    from public.agent_runs r
   where r.created_at < v_cutoff
     and r.client_account_id is not null;

  delete from public.agent_memory m
   where m.created_at < v_cutoff
      or m.source_run_id = any(v_run_ids);
  get diagnostics v_mem_deleted = row_count;

  delete from public.messages m
   where m.created_at < v_cutoff
      or m.run_id = any(v_run_ids);
  get diagnostics v_msgs_deleted = row_count;

  delete from public.tool_calls tc
   where tc.run_id = any(v_run_ids);
  get diagnostics v_tools_deleted = row_count;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jarvis_notes' and column_name = 'source_run_id'
  ) then
    execute 'update public.jarvis_notes set source_run_id = null where source_run_id = any($1)' using v_run_ids;
  end if;

  delete from public.agent_runs r
   where r.id = any(v_run_ids);
  get diagnostics v_runs_deleted = row_count;

  delete from public.client_documents cd
   where (cd.expires_at is not null and cd.expires_at < now())
      or cd.created_at < v_cutoff;
  get diagnostics v_docs_deleted = row_count;

  insert into public.jarvis_audit_log(event_type, detail, line_user_id)
  values ('pdpa_retention_purge', 'retention_days=' || p_retention_days::text, null);

  return jsonb_build_object(
    'purged', true,
    'retention_days', p_retention_days,
    'cutoff', v_cutoff,
    'memories_deleted', v_mem_deleted,
    'messages_deleted', v_msgs_deleted,
    'tool_calls_deleted', v_tools_deleted,
    'runs_deleted', v_runs_deleted,
    'documents_deleted', v_docs_deleted
  );
end;
$$;

revoke all on function public.nh_erase_line_user_data(text, bigint) from public, anon, authenticated;
revoke all on function public.nh_purge_expired_customer_data(integer) from public, anon, authenticated;
grant execute on function public.nh_erase_line_user_data(text, bigint) to service_role;
grant execute on function public.nh_purge_expired_customer_data(integer) to service_role;

commit;
