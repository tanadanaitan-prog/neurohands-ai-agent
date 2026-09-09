# Supabase Phase 1 readiness

Project `darxiaearohhnxiwhcbs` (`Neurohands - AI Agent`) belongs to the verified destination account's organization. On 2026-09-07 it initially contained eight legacy tables and 131 records, with no agent/document tables or Storage buckets.

## Applied and verified

- Migration `20260907123525_phase1_gateway_recovery.sql` is recorded remotely as `phase1_gateway_recovery`. The local filename matches the version assigned by the Supabase migration tool.
- Sixteen Phase 1 tables were added, bringing the total to 24 at that checkpoint. All tables have RLS enabled. Browser roles have no direct table grants; the gateway uses a server-only key and enforces client, department and tool permissions.
- Migration `20260907130303_phase1_webhook_inbox.sql` added an encrypted event inbox, bringing the total to 25. Browser roles have no queue access. A rolled-back service-role test verified deduplication, claims and uncertain classification after lease expiry; the queue is empty.
- Existing tables received account/lead-time columns and compatible message constraints. All 57 products, 14 edging services, 55 messages and five original settings were verified unchanged after migration. Two new settings were added.
- KNC Glass and Aria (`AGT-001`) are configured. No real client activation codes or LINE bindings have been created yet.
- `nh_activate_client` atomically redeems a hash of a random activation code. A live transaction checked activation, replay and the one-use limit, then rolled back; no self-test clients, bindings or codes remain. Anonymous/authenticated browser roles cannot execute that function or claim Jarvis approvals.
- Private Storage bucket `neurohands-docs` has `public=false`, a 10,485,760-byte limit, and allowed MIME types for XLSX, XLS, CSV, TXT, DOCX, PDF and binary uploads. The gateway validates extensions and reports unsupported/partial extraction honestly. No original Storage objects existed before setup.

## Jarvis operator runs — 9 September 2026

The reviewed `jarvis_operator_runs` migration is applied to project `darxiaearohhnxiwhcbs`. Supabase assigned version **`20260909155146`**. The file was initially generated locally with the CLI as `20260909153735_jarvis_operator_runs.sql`, then renamed to **`20260909155146_jarvis_operator_runs.sql`** to match the recorded remote version. Its SQL content was unchanged by the rename. Apply this migration once; do not use a blanket push that includes the unapplied workspace migration.

- `agent_runs.run_kind` defaults to `client`, retaining the requirement for a client account. Operator runs require a null client account, null agent code and the `operations` department; the two checks are validated remotely.
- `agent_runs.delivered_at` is nullable with no default. Only completed operator runs with a recorded delivery timestamp enter the indexed conversation-history query. Model completion alone does not establish delivery.
- `jarvis_notes.source_run_id` is a nullable, validated foreign key to the originating run, with its own index. Historical notes and explicit commands without a run stay compatible; a proposed operation and its approved tool execution can share the same evidence chain.
- Live preflight and postflight both found **0 agent runs and 0 Jarvis notes**. Ordered fingerprints of all pre-existing columns match exactly. No customer or operator test rows were inserted remotely.
- Both tables retain RLS, unchanged policies, and identical table/sequence ACLs. Anonymous and authenticated browser roles cannot select/insert/update/delete these tables; the service role retains its existing access.
- The security advisor remained at the same **25 informational `rls_enabled_no_policy` findings** for the existing server-only tables, with no added warnings/errors. These tables intentionally lack browser policies; their server-side access checks still require separate runtime verification. [Advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- `node --test test/jarvis-operator-db.test.js` passed all **8 reported tests** in isolated PostgreSQL, covering historical data/defaults, shape constraints, proposal foreign keys, unchanged access controls, and delivery-confirmed history ordering/index applicability. This is not a live model or LINE proof.

Detailed preflight/postflight results and the local SQL SHA-256 are in the Git-ignored `.tmp/live-evidence/20260909-jarvis-operator-migration.json`. This database change alone does not prove that the matching server revision has been deployed or that Jarvis/Aria can answer successfully.

## Backup and recovery

The original public schema and exact JSON data were saved privately under `.tmp/backups/`, which Git ignores. `scripts/verify-public-backup.js` restored all 131 records and seven sequence states in isolated PostgreSQL and verified exact values. Timestamp comparisons use UTC. Generated restore SQL and snapshots contain private data and must never be uploaded to GitHub.

The migration was also tested against that restored copy before live application. After application, server-side fingerprints verified every original record's original columns. The snapshot SHA-256 is recorded in `docs/PHASE1_STATUS.md`.

This is a tested backup of the existing public tables, not a complete Supabase project export. Platform roles, authentication configuration, deployment variables and original Railway resources remain outside that backup. The project contained zero Auth users and zero Storage objects at inspection.

The additive schema can remain if the server is rolled back; it preserves the old table layout and values. Do not drop the new tables or restore over a live database to undo a source change. Restore the private SQL into an isolated empty database first, compare records, then plan any recovery that affects live data. Sequence gaps left by rolled-back tests are expected.

## Before a production freeze

1. The durable inbox is applied and tested. Configure its private encryption key, verify actual LINE redelivery after deployment, and follow `docs/WEBHOOK_RECOVERY.md` for failed/interrupted events.
2. Deploy the matching server commit, configure secrets privately and verify the deployment version.
3. Run the real KNC upload → activation → answer → successful authorized `read_document` trace using LINE and the configured model. Test wrong-client access and provider failure on that deployment.
4. Reconcile the original deployment/project, domains, integrations and account access before retiring anything.

`check-readiness.sql` is a limited read-only diagnostic. It is not an end-to-end readiness certificate. The old v3.10 MASTER SQL was not recovered; this schema is a tested reconstruction from the complete server and inspected legacy database.

The earlier `agent_workspace_foundation` migration is separate, unapplied Phase 2 work. Do not run a blanket database push or apply it as a Phase 1 repair. The `/studio` website remains disabled until Phase 1 is proven.

The server key bypasses RLS. Keep it in Railway, never in browser code. Public browser login requires a separate publishable key and the Phase 2 access rules.

References: [Supabase API keys](https://supabase.com/docs/guides/api/api-keys), [private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals), [database functions](https://supabase.com/docs/guides/database/functions).
