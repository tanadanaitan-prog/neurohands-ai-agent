begin;

create schema if not exists auth;

do $$
begin
  if to_regprocedure('auth.jwt()') is null then
    execute $fn$
      create function auth.jwt()
      returns jsonb
      language sql
      stable
      as $body$
        select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
      $body$;
    $fn$;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

alter table public.support_cases
  alter column line_user_id drop not null;

create table if not exists public.nh_sites (
  id uuid primary key default gen_random_uuid(),
  client_account_id bigint not null references public.client_accounts(id),
  created_by_line_user_id text not null,
  site_slug text not null unique check (site_slug ~ '^[a-z0-9-]{3,63}$'),
  title text not null check (length(title) <= 120),
  meta_description text check (length(meta_description) <= 300),
  thumbnail_url text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  theme_config jsonb not null default '{"primaryColor":"#0284C7","fontFamily":"sans","borderRadius":"md"}'::jsonb,
  draft_blocks jsonb not null default '[]'::jsonb,
  published_blocks jsonb,
  published_html text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nh_sites_account_idx on public.nh_sites(client_account_id);
create index if not exists nh_sites_slug_idx on public.nh_sites(site_slug);

create table if not exists public.nh_site_assets (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.nh_sites(id) on delete cascade,
  client_account_id bigint not null references public.client_accounts(id),
  storage_path text not null unique,
  public_url text not null,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
  size_bytes bigint not null check (size_bytes between 1 and 5242880),
  created_at timestamptz not null default now()
);

create table if not exists public.nh_site_inquiries (
  id bigint generated always as identity primary key,
  site_id uuid not null references public.nh_sites(id) on delete cascade,
  client_account_id bigint not null references public.client_accounts(id),
  customer_name text not null check (length(btrim(customer_name)) > 0),
  contact_phone text not null check (length(btrim(contact_phone)) > 0),
  contact_email text,
  product_interest text,
  specifications jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'contacted', 'quoted', 'converted', 'closed')),
  created_at timestamptz not null default now()
);

create index if not exists nh_site_inquiries_site_idx on public.nh_site_inquiries(site_id, created_at desc);

create or replace function public.nh_forward_inquiry_to_cases()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.support_cases (
    client_account_id,
    line_user_id,
    department,
    subject,
    detail,
    urgency,
    status
  ) values (
    new.client_account_id,
    null,
    'sales',
    'Website Lead: ' || new.customer_name,
    'Phone: ' || new.contact_phone || ' | Interest: ' || coalesce(new.product_interest, 'General') || ' | Specs: ' || new.specifications::text,
    'high',
    'open'
  );
  return new;
end;
$$;

drop trigger if exists nh_forward_inquiry_to_cases_trg on public.nh_site_inquiries;
create trigger nh_forward_inquiry_to_cases_trg
  after insert on public.nh_site_inquiries
  for each row execute function public.nh_forward_inquiry_to_cases();

alter table public.nh_sites enable row level security;
alter table public.nh_site_assets enable row level security;
alter table public.nh_site_inquiries enable row level security;

revoke all on table public.nh_sites from anon, authenticated, public;
grant select, insert, update, delete on table public.nh_sites to authenticated;
grant select on table public.nh_sites to anon;
grant all on table public.nh_sites to service_role;

revoke all on table public.nh_site_assets from anon, authenticated, public;
grant select, insert, update, delete on table public.nh_site_assets to authenticated;
grant select on table public.nh_site_assets to anon;
grant all on table public.nh_site_assets to service_role;

revoke all on table public.nh_site_inquiries from anon, authenticated, public;
grant insert on table public.nh_site_inquiries to anon, authenticated;
grant select, update on table public.nh_site_inquiries to authenticated;
grant all on table public.nh_site_inquiries to service_role;

create policy "Tenants can view own sites" on public.nh_sites
  for select to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can insert own sites" on public.nh_sites
  for insert to authenticated
  with check (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can update own sites" on public.nh_sites
  for update to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint)
  with check (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can delete own sites" on public.nh_sites
  for delete to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Public can view published sites" on public.nh_sites
  for select to anon
  using (status = 'published');

create policy "Tenants can view own site assets" on public.nh_site_assets
  for select to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can insert own site assets" on public.nh_site_assets
  for insert to authenticated
  with check (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can update own site assets" on public.nh_site_assets
  for update to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint)
  with check (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can delete own site assets" on public.nh_site_assets
  for delete to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Public can view assets of published sites" on public.nh_site_assets
  for select to anon
  using (exists (
    select 1 from public.nh_sites s
    where s.id = nh_site_assets.site_id and s.status = 'published'
  ));

create policy "Public can submit site inquiries" on public.nh_site_inquiries
  for insert to anon, authenticated
  with check (exists (
    select 1 from public.nh_sites s
    where s.id = nh_site_inquiries.site_id
      and s.client_account_id = nh_site_inquiries.client_account_id
      and s.status = 'published'
  ));

create policy "Tenants can view own inquiries" on public.nh_site_inquiries
  for select to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

create policy "Tenants can update own inquiries" on public.nh_site_inquiries
  for update to authenticated
  using (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint)
  with check (client_account_id = (auth.jwt() -> 'user_metadata' ->> 'client_account_id')::bigint);

commit;
