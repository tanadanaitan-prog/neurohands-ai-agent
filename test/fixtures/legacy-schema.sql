-- Schema only from the connected legacy database; no business records.
set standard_conforming_strings = on;

set timezone = 'UTC';

create table public."clients" (
  "id" bigint generated always as identity not null,
  "line_user_id" text,
  "name" text,
  "company" text,
  "price_tier" text default 'normal'::text not null,
  "assigned_rep" text,
  "created_at" timestamp with time zone default now()
);

create table public."glass_types" (
  "id" bigint generated always as identity not null,
  "product_code" text not null,
  "family" text not null,
  "glass_name" text not null,
  "thickness_mm" numeric(5,1),
  "price_per_sqft" numeric(10,2) not null,
  "discount_pct" numeric(5,2) default 0,
  "min_sqft" numeric(5,2) default 0,
  "measure_base" text not null,
  "active" boolean default true,
  "updated_at" timestamp with time zone default now()
);

create table public."edging_services" (
  "id" bigint generated always as identity not null,
  "service_code" text not null,
  "service_name" text not null,
  "price_per_sqft" numeric(10,2),
  "price_rule" text,
  "active" boolean default true
);

create table public."orders" (
  "id" bigint generated always as identity not null,
  "order_no" text not null,
  "client_id" bigint,
  "glass_type_id" bigint,
  "edging_service_id" bigint,
  "width_mm" numeric(10,1),
  "height_mm" numeric(10,1),
  "qty_sheets" integer default 1,
  "usage_application" text,
  "quoted_price" numeric(12,2),
  "quote_approved_by" text,
  "stage" text default 'received'::text not null,
  "promised_date" date,
  "on_track" boolean default true,
  "notes" text,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now()
);

create table public."production_queue" (
  "id" bigint generated always as identity not null,
  "order_id" bigint,
  "machine" text default 'M1'::text,
  "wheel_type" text,
  "sqft" numeric(10,2),
  "est_minutes" numeric(10,1),
  "start_time" timestamp with time zone,
  "end_time" timestamp with time zone,
  "status" text default 'queued'::text
);

create table public."messages" (
  "id" bigint generated always as identity not null,
  "line_user_id" text,
  "client_id" bigint,
  "direction" text,
  "text_content" text,
  "answered_by" text,
  "question_type" text,
  "status" text default 'sent'::text,
  "reviewed_by" text,
  "created_at" timestamp with time zone default now()
);

create table public."scores" (
  "id" bigint generated always as identity not null,
  "rep_name" text,
  "period" date,
  "avg_response_min" numeric(8,2),
  "followups_done" integer default 0,
  "orders_closed" integer default 0,
  "accuracy_pct" numeric(5,2),
  "tone_pass_pct" numeric(5,2),
  "within_5min_pct" numeric(5,2)
);

create table public."settings" (
  "key" text not null,
  "value" text
);

alter table public."clients" add constraint "clients_price_tier_check" CHECK ((price_tier = ANY (ARRAY['normal'::text, 'special'::text, 'vip'::text])));

alter table public."clients" add constraint "clients_pkey" PRIMARY KEY (id);

alter table public."clients" add constraint "clients_line_user_id_key" UNIQUE (line_user_id);

alter table public."glass_types" add constraint "glass_types_family_check" CHECK ((family = ANY (ARRAY['decorative_interior'::text, 'tempered_exterior'::text])));

alter table public."glass_types" add constraint "glass_types_measure_base_check" CHECK ((measure_base = ANY (ARRAY['sqft'::text, 'mm'::text])));

alter table public."glass_types" add constraint "glass_types_pkey" PRIMARY KEY (id);

alter table public."glass_types" add constraint "glass_types_product_code_key" UNIQUE (product_code);

alter table public."edging_services" add constraint "edging_services_pkey" PRIMARY KEY (id);

alter table public."edging_services" add constraint "edging_services_service_code_key" UNIQUE (service_code);

alter table public."orders" add constraint "orders_stage_check" CHECK ((stage = ANY (ARRAY['received'::text, 'confirmed'::text, 'production'::text, 'shipping'::text, 'delivered'::text, 'cancelled'::text])));

alter table public."orders" add constraint "orders_pkey" PRIMARY KEY (id);

alter table public."orders" add constraint "orders_order_no_key" UNIQUE (order_no);

alter table public."production_queue" add constraint "production_queue_status_check" CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text])));

alter table public."production_queue" add constraint "production_queue_pkey" PRIMARY KEY (id);

alter table public."messages" add constraint "messages_direction_check" CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text])));

alter table public."messages" add constraint "messages_answered_by_check" CHECK ((answered_by = ANY (ARRAY['bot'::text, 'rep'::text])));

alter table public."messages" add constraint "messages_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'sent'::text, 'rejected'::text])));

alter table public."messages" add constraint "messages_pkey" PRIMARY KEY (id);

alter table public."scores" add constraint "scores_pkey" PRIMARY KEY (id);

alter table public."settings" add constraint "settings_pkey" PRIMARY KEY (key);

alter table public."orders" add constraint "orders_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

alter table public."orders" add constraint "orders_glass_type_id_fkey" FOREIGN KEY (glass_type_id) REFERENCES glass_types(id);

alter table public."orders" add constraint "orders_edging_service_id_fkey" FOREIGN KEY (edging_service_id) REFERENCES edging_services(id);

alter table public."production_queue" add constraint "production_queue_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id);

alter table public."messages" add constraint "messages_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

alter table public."clients" enable row level security;

alter table public."glass_types" enable row level security;

alter table public."edging_services" enable row level security;

alter table public."orders" enable row level security;

alter table public."production_queue" enable row level security;

alter table public."messages" enable row level security;

alter table public."scores" enable row level security;

alter table public."settings" enable row level security;

grant INSERT on table public."clients" to "postgres" with grant option;

grant SELECT on table public."clients" to "postgres" with grant option;

grant UPDATE on table public."clients" to "postgres" with grant option;

grant DELETE on table public."clients" to "postgres" with grant option;

grant TRUNCATE on table public."clients" to "postgres" with grant option;

grant REFERENCES on table public."clients" to "postgres" with grant option;

grant TRIGGER on table public."clients" to "postgres" with grant option;

grant TRUNCATE on table public."clients" to "anon";

grant REFERENCES on table public."clients" to "anon";

grant TRIGGER on table public."clients" to "anon";

grant TRUNCATE on table public."clients" to "authenticated";

grant REFERENCES on table public."clients" to "authenticated";

grant TRIGGER on table public."clients" to "authenticated";

grant INSERT on table public."clients" to "service_role";

grant SELECT on table public."clients" to "service_role";

grant UPDATE on table public."clients" to "service_role";

grant DELETE on table public."clients" to "service_role";

grant TRUNCATE on table public."clients" to "service_role";

grant REFERENCES on table public."clients" to "service_role";

grant TRIGGER on table public."clients" to "service_role";

grant INSERT on table public."glass_types" to "postgres" with grant option;

grant SELECT on table public."glass_types" to "postgres" with grant option;

grant UPDATE on table public."glass_types" to "postgres" with grant option;

grant DELETE on table public."glass_types" to "postgres" with grant option;

grant TRUNCATE on table public."glass_types" to "postgres" with grant option;

grant REFERENCES on table public."glass_types" to "postgres" with grant option;

grant TRIGGER on table public."glass_types" to "postgres" with grant option;

grant TRUNCATE on table public."glass_types" to "anon";

grant REFERENCES on table public."glass_types" to "anon";

grant TRIGGER on table public."glass_types" to "anon";

grant TRUNCATE on table public."glass_types" to "authenticated";

grant REFERENCES on table public."glass_types" to "authenticated";

grant TRIGGER on table public."glass_types" to "authenticated";

grant INSERT on table public."glass_types" to "service_role";

grant SELECT on table public."glass_types" to "service_role";

grant UPDATE on table public."glass_types" to "service_role";

grant DELETE on table public."glass_types" to "service_role";

grant TRUNCATE on table public."glass_types" to "service_role";

grant REFERENCES on table public."glass_types" to "service_role";

grant TRIGGER on table public."glass_types" to "service_role";

grant INSERT on table public."edging_services" to "postgres" with grant option;

grant SELECT on table public."edging_services" to "postgres" with grant option;

grant UPDATE on table public."edging_services" to "postgres" with grant option;

grant DELETE on table public."edging_services" to "postgres" with grant option;

grant TRUNCATE on table public."edging_services" to "postgres" with grant option;

grant REFERENCES on table public."edging_services" to "postgres" with grant option;

grant TRIGGER on table public."edging_services" to "postgres" with grant option;

grant TRUNCATE on table public."edging_services" to "anon";

grant REFERENCES on table public."edging_services" to "anon";

grant TRIGGER on table public."edging_services" to "anon";

grant TRUNCATE on table public."edging_services" to "authenticated";

grant REFERENCES on table public."edging_services" to "authenticated";

grant TRIGGER on table public."edging_services" to "authenticated";

grant INSERT on table public."edging_services" to "service_role";

grant SELECT on table public."edging_services" to "service_role";

grant UPDATE on table public."edging_services" to "service_role";

grant DELETE on table public."edging_services" to "service_role";

grant TRUNCATE on table public."edging_services" to "service_role";

grant REFERENCES on table public."edging_services" to "service_role";

grant TRIGGER on table public."edging_services" to "service_role";

grant INSERT on table public."orders" to "postgres" with grant option;

grant SELECT on table public."orders" to "postgres" with grant option;

grant UPDATE on table public."orders" to "postgres" with grant option;

grant DELETE on table public."orders" to "postgres" with grant option;

grant TRUNCATE on table public."orders" to "postgres" with grant option;

grant REFERENCES on table public."orders" to "postgres" with grant option;

grant TRIGGER on table public."orders" to "postgres" with grant option;

grant TRUNCATE on table public."orders" to "anon";

grant REFERENCES on table public."orders" to "anon";

grant TRIGGER on table public."orders" to "anon";

grant TRUNCATE on table public."orders" to "authenticated";

grant REFERENCES on table public."orders" to "authenticated";

grant TRIGGER on table public."orders" to "authenticated";

grant INSERT on table public."orders" to "service_role";

grant SELECT on table public."orders" to "service_role";

grant UPDATE on table public."orders" to "service_role";

grant DELETE on table public."orders" to "service_role";

grant TRUNCATE on table public."orders" to "service_role";

grant REFERENCES on table public."orders" to "service_role";

grant TRIGGER on table public."orders" to "service_role";

grant INSERT on table public."production_queue" to "postgres" with grant option;

grant SELECT on table public."production_queue" to "postgres" with grant option;

grant UPDATE on table public."production_queue" to "postgres" with grant option;

grant DELETE on table public."production_queue" to "postgres" with grant option;

grant TRUNCATE on table public."production_queue" to "postgres" with grant option;

grant REFERENCES on table public."production_queue" to "postgres" with grant option;

grant TRIGGER on table public."production_queue" to "postgres" with grant option;

grant TRUNCATE on table public."production_queue" to "anon";

grant REFERENCES on table public."production_queue" to "anon";

grant TRIGGER on table public."production_queue" to "anon";

grant TRUNCATE on table public."production_queue" to "authenticated";

grant REFERENCES on table public."production_queue" to "authenticated";

grant TRIGGER on table public."production_queue" to "authenticated";

grant INSERT on table public."production_queue" to "service_role";

grant SELECT on table public."production_queue" to "service_role";

grant UPDATE on table public."production_queue" to "service_role";

grant DELETE on table public."production_queue" to "service_role";

grant TRUNCATE on table public."production_queue" to "service_role";

grant REFERENCES on table public."production_queue" to "service_role";

grant TRIGGER on table public."production_queue" to "service_role";

grant INSERT on table public."messages" to "postgres" with grant option;

grant SELECT on table public."messages" to "postgres" with grant option;

grant UPDATE on table public."messages" to "postgres" with grant option;

grant DELETE on table public."messages" to "postgres" with grant option;

grant TRUNCATE on table public."messages" to "postgres" with grant option;

grant REFERENCES on table public."messages" to "postgres" with grant option;

grant TRIGGER on table public."messages" to "postgres" with grant option;

grant TRUNCATE on table public."messages" to "anon";

grant REFERENCES on table public."messages" to "anon";

grant TRIGGER on table public."messages" to "anon";

grant TRUNCATE on table public."messages" to "authenticated";

grant REFERENCES on table public."messages" to "authenticated";

grant TRIGGER on table public."messages" to "authenticated";

grant INSERT on table public."messages" to "service_role";

grant SELECT on table public."messages" to "service_role";

grant UPDATE on table public."messages" to "service_role";

grant DELETE on table public."messages" to "service_role";

grant TRUNCATE on table public."messages" to "service_role";

grant REFERENCES on table public."messages" to "service_role";

grant TRIGGER on table public."messages" to "service_role";

grant INSERT on table public."scores" to "postgres" with grant option;

grant SELECT on table public."scores" to "postgres" with grant option;

grant UPDATE on table public."scores" to "postgres" with grant option;

grant DELETE on table public."scores" to "postgres" with grant option;

grant TRUNCATE on table public."scores" to "postgres" with grant option;

grant REFERENCES on table public."scores" to "postgres" with grant option;

grant TRIGGER on table public."scores" to "postgres" with grant option;

grant TRUNCATE on table public."scores" to "anon";

grant REFERENCES on table public."scores" to "anon";

grant TRIGGER on table public."scores" to "anon";

grant TRUNCATE on table public."scores" to "authenticated";

grant REFERENCES on table public."scores" to "authenticated";

grant TRIGGER on table public."scores" to "authenticated";

grant INSERT on table public."scores" to "service_role";

grant SELECT on table public."scores" to "service_role";

grant UPDATE on table public."scores" to "service_role";

grant DELETE on table public."scores" to "service_role";

grant TRUNCATE on table public."scores" to "service_role";

grant REFERENCES on table public."scores" to "service_role";

grant TRIGGER on table public."scores" to "service_role";

grant INSERT on table public."settings" to "postgres" with grant option;

grant SELECT on table public."settings" to "postgres" with grant option;

grant UPDATE on table public."settings" to "postgres" with grant option;

grant DELETE on table public."settings" to "postgres" with grant option;

grant TRUNCATE on table public."settings" to "postgres" with grant option;

grant REFERENCES on table public."settings" to "postgres" with grant option;

grant TRIGGER on table public."settings" to "postgres" with grant option;

grant TRUNCATE on table public."settings" to "anon";

grant REFERENCES on table public."settings" to "anon";

grant TRIGGER on table public."settings" to "anon";

grant TRUNCATE on table public."settings" to "authenticated";

grant REFERENCES on table public."settings" to "authenticated";

grant TRIGGER on table public."settings" to "authenticated";

grant INSERT on table public."settings" to "service_role";

grant SELECT on table public."settings" to "service_role";

grant UPDATE on table public."settings" to "service_role";

grant DELETE on table public."settings" to "service_role";

grant TRUNCATE on table public."settings" to "service_role";

grant REFERENCES on table public."settings" to "service_role";

grant TRIGGER on table public."settings" to "service_role";
