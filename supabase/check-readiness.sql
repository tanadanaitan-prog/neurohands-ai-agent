-- Read-only diagnostic. Does not create or modify anything.
with expected_tables(table_name) as (
  values ('activation_codes'), ('agent_memory'), ('agent_registry'),
    ('agent_runs'), ('agent_tasks'), ('bot_feedback'), ('client_accounts'),
    ('client_agent_bindings'), ('client_documents'), ('clients'),
    ('edging_services'), ('escalations'), ('glass_types'), ('jarvis_audit_log'),
    ('jarvis_checklist'), ('jarvis_notes'), ('messages'), ('orders'),
    ('settings'), ('staff_activations'), ('support_cases'), ('tool_calls')
), expected_columns(table_name, column_name) as (
  values ('clients', 'client_account_id'), ('orders', 'client_account_id'),
    ('orders', 'lead_time_days'), ('orders', 'urgent_flag')
)
select 'missing_table' as problem, e.table_name as object_name
from expected_tables e
where not exists (
  select 1 from information_schema.tables t
  where t.table_schema = 'public' and t.table_name = e.table_name
)
union all
select 'missing_column', e.table_name || '.' || e.column_name
from expected_columns e
where not exists (
  select 1 from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = e.table_name
    and c.column_name = e.column_name
)
order by problem, object_name;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'neurohands-docs';
