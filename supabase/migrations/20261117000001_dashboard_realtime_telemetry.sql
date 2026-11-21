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
