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
