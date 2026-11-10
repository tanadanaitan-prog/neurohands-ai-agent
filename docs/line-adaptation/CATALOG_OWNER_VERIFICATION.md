# PR23 catalog-owner review — operator instructions

Reviewed locally on 2026-11-10 against candidate commit `13d33051bd6d7f72e9a204097f72b1588734d542` in `outputs/la04-repair-20261110/checkout`. This is an ENG/QA handover, not adoption approval. No owner was chosen; no live database query, credential inspection, environment write, deployment, or customer-data transfer was performed for this review.

## Required decision

Keep `LEGACY_CATALOG_OWNER_CLIENT_ACCOUNT_ID` blank until an authorized business owner and operator verify that **one active client account owns every existing row in both `public.glass_types` and `public.edging_services`**, including inactive rows. Assigning this variable exposes the active portion of the whole legacy catalog to qualifying callers for that account. It does not label rows or create per-row tenant isolation. Mixed ownership, missing provenance, conflicting records, an inactive/missing account, or incomplete visibility means **leave it blank** and escalate for a separately reviewed schema/data migration. Safe denial is an availability gap, not completion of a price request. [S1, S2]

The value must be the positive decimal `public.client_accounts.id` database key. It is not a LINE user ID, `clients.id`, `client_code`, company name, Supabase organization/project owner, or application administrator ID. The recovery schema defines `id` as a bigint identity and keeps `client_code`, `company`, and `active` as separate fields. Neither a seeded account nor a test fixture proves catalog ownership. [S3, S4]

## Authorized operator procedure

1. In Supabase Dashboard, select the intended project and environment using the private release record. Confirm the project identity before opening tables; the recorded schema snapshot is historical evidence, not a live-state guarantee. Use your existing approved operator access. Do not copy API keys, connection strings, LINE IDs, customer rows, or rates into this chat, Git, or the handover.
2. Open **Table Editor → schema `public` → `client_accounts`**. Using a candidate supplied by authorized business records, apply an exact `id` filter (or an exact `client_code` filter to locate that candidate). Inspect only that candidate's `id`, `client_code`, `company`, and `active`. Confirm the database identity matches the intended legal/business entity and `active` is true. Do not pick the first, lowest, only visible, seeded, or conveniently named account. If the record is missing or ambiguous, stop.
3. Run section A of `review/CATALOG_OWNER_READ_ONLY.sql` in SQL Editor with approved read access. Review the complete column lists for all three tables. The snapshot has no owner/account column in either catalog. If live columns differ, tables are missing, or privileges hide metadata, stop for engineering review before section B. PostgreSQL shows only metadata accessible to the current role. [S3; PostgreSQL columns reference below]
4. With full-table visibility confirmed by the authorized database operator, run section B. Replace only `<VERIFIED_CLIENT_ACCOUNT_ID>` with the candidate's exact decimal `id` in a private working copy. Retain aggregate counts privately. Require a valid identifier and exactly one matching active account. Counts partition all catalog rows into active, inactive, and null-active totals; limited/RLS-filtered visibility cannot establish completeness. Errors or zero counts are not ownership evidence. The template selects no customer rows or catalog values.
5. Reconcile **both entire catalogs**, not a sample or only active rows, against controlled import manifests, source price lists, contracts/business records, and the business owner's knowledge. Reference existing private records rather than exporting live rates. Establish which business supplied and owns every row, coverage of later imports/updates, and whether inactive rows could be reactivated. Matching account names, counts, historical orders, application labels, and schema alone cannot prove ownership. If row-by-row provenance cannot be established from approved records, stop with ownership unverified.
6. Record private sign-off: project/environment; observation time; exact candidate `id` and corroborating `client_code`/company; complete-catalog coverage and aggregate counts; provenance record references; reviewer names/roles; unresolved exceptions; and an explicit statement that both catalogs belong wholly to this one account. Business owner signs the ownership decision; engineering verifies identifier/configuration implications; QA records acceptance limits. No configuration change is authorized by this document. Any later configuration/adoption action remains subject to existing release holds and approval.

## ENG/QA risks and acceptance boundaries

- The guard requires matching configured/caller account IDs, a nonblank LINE identity, and a database response confirming that account is active. It then queries active catalog rows without a row-owner predicate. Correct caller context remains essential; this helper does not independently prove the LINE user's binding. Review the upstream binding path and both tool/menu entry points. [S1, S5]
- Menu access uses the newest eligible binding, not an explicit account selector. A user with several bindings may receive denial even when another binding belongs to the owner. Profile scoping excludes a profile from another account; it does not establish catalog provenance. [S5, S6]
- Product tools return at most 100 rows (menu 30), edging tools at most 100 (menu 20); product search filters the bounded retrieved subset. A successful response does not prove full-catalog search/completeness. [S1, S5]
- Synthetic owner/non-owner, blank configuration, inactive account, missing identity, and database-error cases establish local guard behavior only. They do not establish live bindings, database permissions/RLS, correct rates, legitimate ownership, LINE delivery, or production acceptance. The application guard does not replace database grants/RLS review. [S2, S7; Supabase security guide below]
- Minimum later controlled acceptance: approved owner receives only intended data through tools/menu; non-owner and unactivated callers receive no rates; blank owner and inactive owner deny; errors do not masquerade as empty success; profile stays in the current account. Keep real data and receipts in approved private systems. No live test was run here.

## Source anchors

All code paths below are relative to the candidate checkout; line numbers refer to the reviewed commit.

- S1: `src/lib/catalog-access.js:3–45` — identifier validation, authorization, unscoped catalog queries and bounds.
- S2: `docs/line-adaptation/LA04_REPAIR.md:45–56,112–119` — whole-catalog owner prerequisite, availability gap, separate pilot and holds.
- S3: `supabase/catalog/observed-public-schema.json:2–8,146–150,181–186,193–203` — snapshot date/source and relevant columns.
- S4: `supabase/migrations/20260907123525_phase1_gateway_recovery.sql:5–12,227` — account definition and historical seed; neither proves ownership.
- S5: `src/server.js:547–555,573–575,633–637,1079–1091` — active bindings, configured guard, tool/menu hooks.
- S6: `src/server.js:612–620` — current-account profile scoping.
- S7: `test/la04-data-access.test.js:51–128` — synthetic access/error cases; not rerun by this document review.

Official references fetched 2026-11-10: [PostgreSQL read-only transaction syntax](https://www.postgresql.org/docs/current/sql-begin.html), [metadata visibility](https://www.postgresql.org/docs/current/infoschema-columns.html), and [Supabase grants and RLS](https://supabase.com/docs/guides/api/securing-your-api). The skill's Markdown changelog endpoint returned an unsupported-content-type error; its [HTML changelog](https://supabase.com/changelog) was fetched as fallback. No platform/SDK change is proposed.


Continue with [ENG/QA handover](ENG_QA_HANDOVER_PR23.md) and the [LINE acceptance plan](LINE_ACCEPTANCE_PR23.md).
