# Phase 1: v3.10 KNC document proof

Updated 2026-09-07. This record separates observations from earlier reports. No production proof or complete account migration is claimed.

## Sources reviewed

- The user's revised goal objective, supplied in this task on 2026-09-07.
- Neurohands Master Document, compiled 2026-09-06, and its source text.
- The referenced conversation `Project Document Summary`.
- Complete server recovered from `NEUROHANDS v3.docx`; provenance is in `recovery-manifest.json` and original source in `originals/`.
- The downloaded scripts, menu definitions and images, repository state and connected Supabase project.

The earlier master document reports a working v3.10 deployment, 25 tables, KNC/AGT-001 seeds, private document storage and last known good commit `8c9c439`. These are **reported**, not established by the currently connected resources.

## Verified account and resource observations

- GitHub browser: `tanadanaitan-prog`, desired destination email Primary and Verified. Target repository: `tanadanaitan-prog/neurohands-ai-agent`; public visibility. Before this import it contained six root files, no application folders.
- The source-account screenshot spells the email `neurohands.admin`, whereas the goal's `neruohands.admin` spelling appears inconsistent. The source account's present access and private repository inventory remain unverified.
- Supabase browser: desired destination email, sole Owner of organization `ygwhgtvzaoajkokgcaby` (Neurohands). Project `darxiaearohhnxiwhcbs`, `Neurohands - AI Agent`, is healthy.
- Connected database: eight public tables. Approximate inventory reported by Supabase: 57 glass products, 14 edging services, 55 messages, five settings; no client or order rows. No document Storage buckets or objects; no vector or pg_cron extension. Sixteen tables required by the recovered runtime are missing. The existing messages constraints also conflict with the runtime's `received` status and agent identities.
- Railway browser: linked to `tanadanaitan-prog`; email field empty; only one visible workspace, with zero projects. Existing service/project ID and deployed commit remain unknown.
- A request to the reported production health URL timed out from this environment. A timeout does not establish that the service is down.

## Verified local behavior

`npm run check` and `npm test` pass (30 reported tests including suites). Tests use simulated HTTP providers; workspace migration tests use isolated PostgreSQL through PGlite. They do not contact production services.

The pilot integration test uploads a workbook, verifies KNC registration and original-file hash, activates a test client, exercises the model/tool exchange and finds the distinctive value `KNC-PILOT-739261` on the second sheet. It checks a successful, allowed `read_document` record linked to the run and document.

Negative cases cover another client, unbound department, unactivated/revoked identity, denied tool permissions, database failures, missing trace persistence, rejected LINE responses and unconfirmed uploads. Concurrent uploads retain separate immutable originals. CSV quoting/multiline fields and exact long integer strings are preserved. Partial extraction and unsupported files are labeled.

## Remaining acceptance evidence

1. Locate the original Railway deployment and reconcile its Supabase project with the currently connected eight-table database. Inventory source repositories/history, variables, domains, jobs and integrations.
2. Back up the actual database/schema and original Storage files, plus deployment configuration, before consequential remote changes. Verify restore in an isolated destination. No complete production backup exists yet.
3. Recover or construct and test the missing v3.10 schema. Preserve existing records and constraints intentionally. The `nh_` workspace migration is separate Phase 2 work, not a v3.10 schema repair.
4. Fix atomic activation usage and predictable activation codes; review operator identity, approvals and remaining tenant fallback paths. Test model transport failure and webhook retry/recovery before freeze.
5. Deploy the complete replacement package using the intended Railway service; verify the deployed commit and dependencies.
6. Run the proof with the real private bucket, activated KNC LINE user, configured provider and Aria. Record the uploaded file's hash/code, account ownership, answer, run ID and authorized successful document trace. Run wrong-client and provider-failure checks on that deployment.

Only after all these checks pass should the baseline be tagged/frozen and Phase 2 enabled. No claim of measured capacity, completed RAG, MCP, autonomous Jarvis or guaranteed correctness is supported yet.

## Recovery procedure for this package

- Original Downloads files remain unchanged; unmodified recovered source and menu metadata are retained in `docs/originals/`.
- Work is uploaded on a recovery branch before promotion to `main`. Preserve the pre-import `main` commit (`176bc4311e071471e0e4d696d9ad9248ea1c27d4`) for repository rollback. That commit contains only six root files and is **not** a working server baseline.
- Revert a source change using a normal revert commit, then redeploy the previously verified Railway deployment when one has been identified. Do not reset history or remove the source account until destination operation is proven.
- Failed upload registration writes no Storage object. Failed extraction persistence can leave a `pending` document record plus its original object; inspect that record and object before retrying. Never delete originals just to clear an error.
- Before enabling these server changes, ensure the document table accepts `pending`, `parsed`, `partial`, `unsupported`, `failed` statuses and sufficiently long document codes. Source files alone cannot repair the absent database.
- Credentials belong in private runtime configuration, never in GitHub, test fixtures, screenshots or this record. All test credentials and `.invalid` endpoints are inert fixtures.

LINE supports retrieving incoming content by message ID. This version deliberately uses the Document Portal; it does not implement incoming-file retrieval. Reference: https://developers.line.biz/en/reference/messaging-api/#get-content
