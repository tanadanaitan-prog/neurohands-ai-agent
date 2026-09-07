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

- GitHub browser: `tanadanaitan-prog`, desired destination email Primary and Verified. Target repository: `tanadanaitan-prog/neurohands-ai-agent`; public visibility. Before this import it contained six root files, no application folders. PR #1 merged 38 verified files to `main` at `1f86a3cbeb44f734905246a5cf16903ce9d869dc`.
- The source-account screenshot spells the email `neurohands.admin`, whereas the goal's `neruohands.admin` spelling appears inconsistent. The source account's present access and private repository inventory remain unverified.
- Supabase browser: desired destination email, sole Owner of organization `ygwhgtvzaoajkokgcaby` (Neurohands). Project `darxiaearohhnxiwhcbs`, `Neurohands - AI Agent`, is healthy.
- Initial database: eight public tables, with 57 glass products, 14 edging services, 55 messages and five settings; no client or order rows, no Auth users and no Storage buckets/objects. No vector or pg_cron extension was installed.
- Applied `20260907123525_phase1_gateway_recovery`: now 24 public tables, all RLS-enabled, no direct browser-role table grants. KNC and Aria are seeded. The 16 missing tables and message constraint differences are repaired. All 131 original records' original values were verified unchanged by database-side fingerprints. Two new settings were added.
- Applied `20260907130303_phase1_webhook_inbox`: now 25 public tables, including an RLS-protected encrypted inbox and linked agent runs. A live service-role transaction checked deduplication, claim and expired-lease classification, then rolled back with zero queue rows remaining. Browser roles cannot read or invoke the queue.
- Created private `neurohands-docs` bucket, 10 MB limit, with document MIME allowlist. It is still empty pending the real upload proof.
- A live service-role transaction tested activation, replay and a one-use limit and was rolled back. No test clients, activation codes, bindings or audit rows remain. Browser roles cannot invoke the privileged activation/approval functions.
- Railway browser: linked to `tanadanaitan-prog`; email field empty; only one visible workspace, with zero projects. Existing service/project ID and deployed commit remain unknown.
- A request to the reported production health URL timed out from this environment. A timeout does not establish that the service is down.

## Verified local behavior

`npm run check` and `npm test` pass (59 reported tests including parent tests). HTTP tests use simulated providers; database migration tests use isolated PostgreSQL through PGlite. They do not contact production services. Live database self-tests are recorded separately above.

The pilot integration test uploads a workbook, verifies KNC registration and original-file hash, activates a test client, exercises the model/tool exchange and finds the distinctive value `KNC-PILOT-739261` on the second sheet. It checks a successful, allowed `read_document` record linked to the run and document.

Negative cases cover another client, unbound department, unactivated/revoked identity, denied tool permissions, database failures, missing trace persistence, rejected LINE responses and unconfirmed uploads. Concurrent uploads retain separate immutable originals. CSV quoting/multiline fields and exact long integer strings are preserved. Partial extraction and unsupported files are labeled.

New activation codes contain 128 random bits and only their SHA-256 hashes are stored. SQL tests verify transactional rollback on failed audit, single-use limits, same-user replay, disabled accounts, revoked bindings and refusal to overwrite another tenant. PGlite serializes submissions; multi-connection load testing is not claimed. Jarvis claims only the proposer's pending approval, and failed actions are never labeled executed. Disclosed staff passphrases cannot enroll arbitrary users. Private account operations are restricted to direct LINE chats; upload access is revoked when the link issuer loses access.

## Completed public-data recovery checks

The private legacy snapshot SHA-256 is `4d6c9475a9036a55fee8eea7f3eb29364b778411ace2da494b8d90275d442267`. All 131 records and seven sequence states restored exactly in isolated PostgreSQL. The migration was then applied to that restored copy and every original value compared again. Live post-migration fingerprints also matched. Snapshots, generated restore SQL and detailed proofs remain in Git-ignored `.tmp/backups/`; they contain private business data and are not public artifacts.

## Remaining acceptance evidence

1. Locate the original Railway deployment and reconcile its Supabase project with the currently connected eight-table database. Inventory source repositories/history, variables, domains, jobs and integrations.
2. Finish the full source-system backup/inventory, including deployment configuration and any original Storage objects once located. The inspected public-table backup and restore are complete; a complete production-system backup is not.
3. The reconstructed v3.10 schema and private bucket are applied and verified. Real application use of every relevant table remains to be checked through the deployed workflow. The `nh_` workspace migration remains separate, unapplied Phase 2 work.
4. Atomic activation, random codes, operator identity, scoped approvals, revoked upload issuers and model failure checks are implemented and tested. Durable webhook intake and recovery now pass local and live database checks; actual LINE redelivery and broader operational review remain before freeze. See `WEBHOOK_RECOVERY.md`.
5. Deploy the complete replacement package using the intended Railway service; verify the deployed commit and dependencies.
6. Run the proof with the real private bucket, activated KNC LINE user, configured provider and Aria. Record the uploaded file's hash/code, account ownership, answer, run ID and authorized successful document trace. Run wrong-client and provider-failure checks on that deployment.

Only after all these checks pass should the baseline be tagged/frozen and Phase 2 enabled. No claim of measured capacity, completed RAG, MCP, autonomous Jarvis or guaranteed correctness is supported yet.

## Recovery procedure for this package

- Original Downloads files remain unchanged; unmodified recovered source and menu metadata are retained in `docs/originals/`.
- Work is uploaded on a recovery branch before promotion to `main`. Preserve the pre-import `main` commit (`176bc4311e071471e0e4d696d9ad9248ea1c27d4`) for repository rollback. That commit contains only six root files and is **not** a working server baseline.
- Revert a source change using a normal revert commit, then redeploy the previously verified Railway deployment when one has been identified. Do not reset history or remove the source account until destination operation is proven.
- Failed upload registration writes no Storage object. Failed extraction persistence can leave a `pending` document record plus its original object; inspect that record and object before retrying. Never delete originals just to clear an error.
- The applied document schema accepts `pending`, `parsed`, `partial`, `unsupported`, `failed` and long document codes. Approval records left `executing` after a crash require review of tool evidence before retrying; never execute them blindly.
- Queue events in `received` can resume after a restart. Events left `processing` past their lease become `uncertain` and require evidence review; never blindly replay them. Preserve `WEBHOOK_ENCRYPTION_KEY` during rollback so pending encrypted input stays readable.
- Credentials belong in private runtime configuration, never in GitHub, test fixtures, screenshots or this record. All test credentials and `.invalid` endpoints are inert fixtures.

LINE supports retrieving incoming content by message ID. This version deliberately uses the Document Portal; it does not implement incoming-file retrieval. Reference: https://developers.line.biz/en/reference/messaging-api/#get-content
