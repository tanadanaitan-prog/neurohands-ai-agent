# Neurohands AI Agent: implementation and migration record

This records the longer-term user objective. It is not a declaration that any listed feature is complete. The revised objective places the v3.10 KNC/Aria document proof first; see `PHASE1_STATUS.md`. Work through one milestone at a time and preserve a verified Phase 1 baseline before expanding.

## Account and data migration

Move control of all Neurohands work from the former admin account to the user's new account, across GitHub, Supabase and Railway. Preserve repository history where accessible, database records, Storage objects, service variables, domains and deployment settings. Confirm destination access before removing any source access or retiring a deployment.

The confirmed destination repository is `tanadanaitan-prog/neurohands-ai-agent`. The source GitHub owner is `neurohandsadmin-ops`. A public API inventory on 2026-09-07 returned no public repositories for that owner; this does not prove there are no private repositories. The destination currently has only six top-level files and is missing the application's folders. The complete recovered local files remain available.

The connected Supabase project is `darxiaearohhnxiwhcbs`, now named `Neurohands - AI Agent`. Its existing eight public tables contain product/catalogue data and message history. They must be preserved. Authentication account email and organization ownership remain unverified.

Railway: signed in through destination GitHub user `tanadanaitan-prog`, email field empty, one workspace with zero projects. Original project/service IDs, variables and deployments remain unidentified. Supabase destination ownership has been verified in the browser; the organization has one member, the destination account, with Owner role.

## Required end state and evidence

| Requirement | Evidence needed before completion |
| --- | --- |
| Complete service/account migration | Source inventory reconciled against destination; ownership and sign-in confirmed; repository history/files, DB records and Storage object counts/hashes checked; Railway configuration and deployment preserved |
| Website with Supabase Auth and protected routes | Successful sign-in/logout and session renewal; anonymous requests denied; server validates identity; cross-workspace and role-escalation tests pass |
| Drag-and-drop organization builder | Create/edit named agents, roles, responsibilities, teams and departments; drag or keyboard-move an agent; reload and verify persisted placement; concurrent edits handled |
| Department coverage | Sales, marketing, finance, accounting, HR, R&D, IT, data analysis, AI engineering and operations supported without hardcoded single-agent routing |
| Deploy agents to website and LINE | Versioned agent definition; real website command run; expiring activation code bound to the correct workspace/agent; verified LINE webhook and reply; pause/revoke behavior tested |
| Workflow execution and scaling | Persistent job queue, leases, idempotency, bounded concurrency, retry/dead-letter handling, cancellation and approval gates; worker restart/recovery test and measured load test |
| Mathematical workflow/decision support | Explicit reproducible scoring/assignment algorithm with transparent inputs, evidence and limitations; deterministic tests and comparison metrics; no claim of guaranteed decision quality |
| Document reading and organization | Word/Excel/CSV/PDF ingestion, schema extraction, cleaning, validation and export; source provenance, access controls and failed-ingestion handling tested |
| RAG | Workspace/agent-scoped retrieval, relevance ranking with citations, no-data behavior, multilingual validation and cross-tenant leakage tests |
| MCP and external tools | Authenticated, approved connections; server-side secrets; discovery and invocation of permitted tools; timeout/SSRF/permission checks; write approvals and execution audit |
| Jarvis monitoring | Internal and external service health, job state, failures, approvals and measurable usage; real dashboard/digest; report delivery and data-access rules verified |
| Production deployment | All required configuration present, migrated schema verified, web/worker deployed to Railway, HTTPS/domain checks, end-to-end website and LINE tests, backup/restore and scaling documentation |

## Implementation approach

Finish the v3.10 document proof first. Preliminary authenticated workspace code and additive `nh_` tables are retained as Phase 2 work. They are disabled by default, and the workspace migration has not been applied remotely. Browser data requests use the user's verified Supabase identity and database row-level security. Privileged worker integrations remain server-only.

Next connect versioned deployment, LINE activation and the queued execution engine. Then implement structured document ingestion, retrieval, controlled MCP tools and Jarvis monitoring. Validate account migration independently from application feature completion. Do not enable live routing until the relevant access and execution paths are verified.

The local working branch is `codex/agent-platform`, based on the destination repository's `main` branch. Recovery files are being uploaded through the verified destination-account browser on remote branch `codex/phase1-recovery`; CLI and connector authentication remain unavailable. Upload, deployment and live acceptance are separate milestones.
