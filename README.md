# Neurohands AI Agent

Recovered v3.10 Express server for the LINE concierge, Aria agent, Jarvis operator console, and document upload portal. This local recovery targets [tanadanaitan-prog/neurohands-ai-agent](https://github.com/tanadanaitan-prog/neurohands-ai-agent).

**Current milestone:** stabilize the v3.10 KNC Glass / Aria pilot before enabling the larger agent platform. The recovered source and local tests are included here. A live Railway / LINE proof has **not** passed. The connected Supabase project lacks the document and agent schema and Storage bucket. See [Phase 1 evidence and recovery](docs/PHASE1_STATUS.md) and [Supabase readiness](supabase/README.md).

| Location | Contents |
| --- | --- |
| `src/server.js` | Complete recovered server, with the fixes listed below |
| `src/lib/security.js` | Secret comparison and Supabase request headers |
| `scripts/setup-richmenu.js` | Local validation and manual LINE menu setup |
| `config/rich-menus/` | Menu button actions and coordinates |
| `assets/rich-menus/` | Both original PNG images, with corrected filenames |
| `supabase/` | Database readiness notes and a read-only schema check |
| `test/` | Local regression checks with external services mocked |
| `docs/originals/` | Original downloaded files and unmodified recovered source |
| `docs/import-manifest.json` | Downloaded file sizes and SHA-256 hashes |
| `docs/recovery-manifest.json` | Complete source recovery provenance |
| `.env.example` | Configuration names with blank credentials |
| `railway.json` | Build, start and process-health settings |

The downloaded `server.js` ended halfway through a string. The complete source was recovered from `NEUROHANDS v3.docx` in Downloads. Every character of the downloaded source before its final newline matches the recovered beginning. Original Downloads files were left in place.

## Run locally

Use Node.js 24. From this folder:

```powershell
npm ci
Copy-Item .env.example .env
```

Enter credentials privately in `.env`, then:

```powershell
npm run check
npm test
npm start
```

Open `http://localhost:3000/` to check that the process started. That response does not verify Supabase, LINE, AI models, or database readiness. The checks and tests can run without real credentials. `.env`, dependency installations, temporary recovery files and generated ZIP packages are excluded from Git.

## Connections to finish

1. Review the recovered project in `tanadanaitan-prog/neurohands-ai-agent`, prepared through the `codex/phase1-recovery` branch. Browser access is verified as the destination account. Credentials, local dependencies and generated packages are excluded from Git.
2. Review the database differences in `supabase/README.md`, recover or design the v3.10 migration, and configure the private document bucket. No live database changes were made during this import.
3. Once the database is ready, connect that GitHub repository to the intended Railway service, using this folder as the repository root. The included Railway configuration runs the checks and tests, starts the server, and checks `/`.
4. Populate Railway Variables using `.env.example` as the name list. Put secret values directly into Railway. Set `PUBLIC_URL` to the HTTPS deployment URL, or use Railway's `RAILWAY_PUBLIC_DOMAIN`.
5. Set the LINE webhook URL to the deployment's `/webhook` endpoint and verify it in the LINE Developers console. Only publish the menus after confirming the intended LINE channel.

The configuration preserves `SUPABASE_SERVICE_KEY` as the variable name and supports a server-only `sb_secret_` key as well as a legacy service-role JWT. The Phase 1 application uses LINE identity, activation bindings, signed upload links and shared backend API secrets. The separate `/studio` website and its Supabase Auth routes are experimental and disabled unless `ENABLE_STUDIO=true`. They require a separate public `SUPABASE_PUBLISHABLE_KEY` and the included workspace migration, which has not been applied remotely. Do not apply that Phase 2 migration as a replacement for the missing v3.10 schema.

`GEMINI_MODEL=gemini-3.6-flash` and `FALLBACK_PROVIDER=groq` in the example reflect the supplied Railway screenshots. Model availability and provider credentials have not been tested. Configure supported fallback model names explicitly for the provider you use.

Screenshots included revealed credentials. Replace the Gemini, LINE, Supabase and fallback API credentials and the Jarvis activation secret before the new deployment. The screenshot values and screenshots themselves were not copied into this project.

## Rich menus

```powershell
npm run richmenu:check
```

This reads both JSON and PNG files, checks LINE image limits, and validates all button bounds. The images remain at their original 1664 × 928 pixels. The JSON now matches those dimensions and the visible cards instead of the original 2500 × 1686 grid.

The following command performs real external changes: it creates two LINE menus, uploads both images, stores their IDs in Supabase `settings`, and sets the public menu as the default:

```powershell
npm run richmenu:setup
```

This command has not been run against LINE. Repeating it creates new menu IDs. Existing per-user links are not automatically migrated to the new active menu; activation links users through the server. If setup fails partway, use the logged menu IDs to inspect the partial setup before rerunning it.

## Changes made during recovery

- Updated the start command for `src/server.js` and repaired the menu asset paths.
- Disabled `/api/agent/run` and `/cron/daily` unless their respective secrets are configured and match the request. Removed the built-in staff activation passphrase.
- Added constant-time secret comparison and rejected unsigned, malformed, expired or tampered upload tokens.
- Restored the missing system instruction message in the fallback model's tool loop.
- Sent modern Supabase secret keys through `apikey`; retained legacy JWT compatibility.
- Pinned direct dependency versions and added `package-lock.json`. Updated SheetJS from the obsolete npm package to the official 0.20.3 release. Overrode the transitive `qs` parser to 6.16.0 to address audit findings without changing Express major versions.
- Added local checks for authentication, webhook signatures, upload tokens, fallback instructions, and document parsing. Tests do not call real external services.

The document proof now runs in local tests with simulated providers, including wrong-client access, revoked/unbound identities, denied tools, failed storage/database operations and failed trace persistence. It verifies a distinctive value on the second spreadsheet sheet, beyond the original 20-row sample. Originals are retained with SHA-256 provenance; extraction limits produce `partial` status. PDF files remain stored-only. This is not a live model, LINE, database or deployment proof.

Activation-code usage updates are still nontransactional, codes are predictable, and operator approvals need further access-control review before a production freeze. The final database schema must accept `partial` extraction status and longer UUID-suffixed document codes. The contact address in `BRAND_COPY.contact` is still a placeholder. See the Phase 1 record for all remaining acceptance checks.

References: [Railway configuration](https://docs.railway.com/config-as-code/reference), [LINE rich-menu images](https://developers.line.biz/en/reference/messaging-api/#upload-rich-menu-image), [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys), [SheetJS installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).
