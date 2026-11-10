-- PR23 operator template. Review ../CATALOG_OWNER_VERIFICATION.md first.
-- No real account, customer, rate, credential, or catalog row data is embedded.
-- Run section A first; inspect all columns and stop on schema/visibility mismatch.
-- Run each section as a complete block, not selected fragments.

-- SECTION A: schema metadata only; no column defaults or table rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT table_schema, table_name, ordinal_position, column_name,
       data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('client_accounts', 'glass_types', 'edging_services')
ORDER BY table_name, ordinal_position;

ROLLBACK;

-- SECTION B: aggregates only. Run after schema review and confirmation that the
-- approved operator has complete visibility of these tables (not an RLS subset).
-- Replace ONLY the placeholder below, privately, with the independently verified
-- public.client_accounts.id. Do not use a LINE ID, client code, or fixture value.
-- Leaving the placeholder intact produces valid_decimal_identifier=false and zero candidate hits.
-- Counts/one active account cannot prove whole-catalog ownership or provenance.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT 'glass_types' AS table_name,
       count(*) AS total_rows,
       count(*) FILTER (WHERE active IS TRUE) AS active_rows,
       count(*) FILTER (WHERE active IS FALSE) AS inactive_rows,
       count(*) FILTER (WHERE active IS NULL) AS null_active_rows
FROM public.glass_types
UNION ALL
SELECT 'edging_services' AS table_name,
       count(*) AS total_rows,
       count(*) FILTER (WHERE active IS TRUE) AS active_rows,
       count(*) FILTER (WHERE active IS FALSE) AS inactive_rows,
       count(*) FILTER (WHERE active IS NULL) AS null_active_rows
FROM public.edging_services;

WITH candidate AS (
  SELECT '<VERIFIED_CLIENT_ACCOUNT_ID>'::text AS account_id
)
SELECT
  CASE WHEN candidate.account_id ~ '^[1-9][0-9]{0,18}$'
       THEN candidate.account_id::numeric <= 9223372036854775807
       ELSE false
  END AS valid_decimal_identifier,
  (SELECT count(*) FROM public.client_accounts AS account
   WHERE account.id::text = candidate.account_id) AS exact_candidate_rows,
  (SELECT count(*) FROM public.client_accounts AS account
   WHERE account.id::text = candidate.account_id
     AND account.active IS TRUE) AS exact_active_candidate_rows
FROM candidate;

ROLLBACK;

-- Require valid_decimal_identifier=true, exact_candidate_rows=1,
-- exact_active_candidate_rows=1 AND complete external provenance + sign-off.
-- Unknown/mixed ownership => keep LEGACY_CATALOG_OWNER_CLIENT_ACCOUNT_ID blank.
-- This template changes no schema, rows, policies, grants, or environment values.
