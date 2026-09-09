# Neurohands: goal acceptance record

Prepared 9 September 2026 from the user's updated 12-part **Combined Goal and Working Instructions**, the checked-out source, test definitions, Git history and saved observation records. This is an acceptance map, not a completion certificate or a claim that Jarvis and Aria independently evaluated themselves.

The reviewed source baseline is commit `899628db273cd26b6b2ed21590e5ad151e5a7bdb` (PR #7). The observations below are dated; they are not a fresh remote inspection. New work and live checks must record their own commit, deployment, observation time and result. Existing tests were inspected for coverage here, not rerun for this document.

## Evidence boundaries

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Current `src/`, `web/`, `supabase/` and `test/` | Implementation and intended regression coverage | Deployment, live behavior or complete requirement coverage |
| `docs/recovery-manifest.json`, `docs/import-manifest.json`, `docs/PHASE1_STATUS.md` | Source recovery provenance and recorded initial backup/restore checks | Inventory of every former-account asset or a full production backup |
| Private `.tmp/live-evidence/20260909-0740-progress.json` | PR #7 deployed, exact commit returned by `/version`, 101 Railway tests passed, `/ready` returned 200 | Successful customer AI answers or the full pilot |
| Private `.tmp/live-evidence/20260909-1410-progress.json` | Dated profile checks, no active customer bindings or Aria runs, and a claim-RPC timeout observation | Current account access, zero future incidents or an established timeout cause |
| Private `.tmp/live-evidence/20260909-1438-jarvis-failure.json` | Real founder greeting received a failure notice: Gemini timed out after 15,003 ms; Groq returned 401; no AI answer succeeded | Provider token cost, cause of the primary delay or a successful Aria test |
| `docs/LIVE_STATUS.md` | Earlier bounded provider diagnostic, deployment and usage instrumentation history | Current AI availability; its 8 September successful Gemini probe is superseded for current response health by the 9 September failed request |

Keep raw customer content, source hashes tied to private files, LINE identifiers, upload tokens, credentials and detailed test answers in private evidence storage. Public reports can link commits, tests and sanitized results. Several older documents still say deployment is pending, the bucket is empty, or there are 59 tests; use their dates and the newer evidence above rather than presenting those statements as current.

The full goal has **no reliable completion percentage**. The previously reported 3/4 pilot-preparation checks are not 75% of Phase 1 or of the workforce platform. None of the 12 broad requirements below is fully accepted.

## 1. Understand and preserve existing work

**State: partially established.** Recovery manifests preserve downloaded-file hashes and recovered source provenance. `docs/originals/`, Git history, `docs/PHASE1_STATUS.md`, `docs/LIVE_STATUS.md` and `docs/WEBHOOK_RECOVERY.md` record changes, tests, incidents and recovery limits. Current source, the disabled workspace foundation and future roadmap are distinguishable.

**Acceptance still needed:** maintain one dated decision/change/test/issue record that references each new revision and requirement; reconcile outdated status statements after fresh verification. Preserve the complete original scope as changes are prioritized. A reader must be able to identify what is prepared, locally tested, uploaded, deployed, verified live, incomplete or planned without inferring success from a test count.

**Priority:** ongoing, starting with this inventory and the current incident.

## 2. Consolidate ownership safely

**State: incomplete.** The destination repository is `tanadanaitan-prog/neurohands-ai-agent`. Earlier browser evidence verifies destination GitHub ownership and Supabase organization ownership; the 9 September profile record confirms Railway's destination email. That same record shows the GitHub connector still using `neurohandsadmin-ops`. The inspected original eight public tables and 131 records have recorded backup, isolated restore and preservation checks. The complete former Railway deployment, original repository history, integrations and Storage inventory are not reconciled.

**Acceptance still needed:** verify all three current identities; gain authorized access to the former assets; enumerate repositories and full history, database records/schema, original files and hashes, environment configuration, domains, scheduled jobs and integrations. Store backups privately, restore and compare them, then verify destination operation. Resolve the connector identity mismatch without granting unnecessary access to the former account. Record a reconciliation for every source asset. Retire source resources only after destination proof and the user's applicable authorization.

**Priority:** Phase 1, parallel read-only inventory where access allows; no source retirement yet.

## 3. Complete Phase 1 first

**State: deployed foundation; live proof incomplete.** `src/server.js` implements the LINE gateway, founder Jarvis commands, Aria tools and signed upload portal. Phase 1 migrations define client activation, document records, evidence and encrypted webhook intake. `test/pilot-proof.test.js` exercises upload → KNC registration → activation → document answer → authorized persisted trace with simulated external services. It also covers wrong-client/unbound/revoked access, denied tools, persistence failures, unsupported extraction and rejected LINE delivery. `test/phase1-db.test.js` and `test/webhook-inbox.test.js` use isolated PostgreSQL for transactional and queue behavior. Recorded live evidence includes one parsed KNC document, deployed code and real LINE replies; the latest incident record has zero active customers and zero Aria runs.

**Acceptance still needed:** fix or isolate the current provider failure within verified free allowances, then use the second personal LINE account for the complete KNC/AGT-001 proof. Record original-object ownership/hash, activation binding, exact deployed revision, distinctive question, actual correct reply, completed agent run, authorized successful `read_document`, matching client/department/source and delivery evidence. Run controlled live unauthorized-access and provider-failure cases without exposing another client's data or inventing test users. Check interruption/redelivery recovery and a tested rollback path. Review all failures before tagging a freeze candidate.

**Priority:** current delivery milestone. An HTTP 200, completed webhook or delivered error notice is not acceptance of a successful AI answer. Phase 2 stays disabled until the baseline is accepted.

## 4. Build a configurable AI workforce

**State: experimental definition builder, not connected workforce execution.** `web/src/main.js` has sign-in, department/team creation, agent editing, drag-and-drop and alternative move controls. `src/platform/` handles verified Supabase identity, workspace access, optimistic revisions and immutable published definitions. `test/workspace-db.test.js` covers database role, tenant and revision boundaries. The separate workspace migration remains unapplied in the recorded remote baseline; `/studio` is behind `ENABLE_STUDIO`, and `/api/studio/config` reports `runtimeConnected: false`. The current editor accepts name, role, responsibilities, instructions, department, team, tools and model settings; it does not yet implement the complete requested objective, manager and data-source configuration.

**Acceptance still needed:** persist and validate every required agent field; verify sign-in/session/logout and cross-role access in the rendered website; test drag and keyboard movement, reload and conflicting edits. Connect published definitions to real individual/team/department/organization execution and LINE activation. Verify test, activate, update, pause and retire controls stop or change runtime behavior, not only a database label. Add sales, marketing, operations, finance, HR, research, IT, data analysis and AI engineering incrementally with representative capability tests.

**Priority:** Phase 2 after the accepted Phase 1 baseline.

## 5. Develop a capable engineering team

**State: planned.** Agent names and a generic tool loop do not establish an engineering team. Current runtime tools read business information, register tasks and escalate; there is no implemented requirements-to-build pipeline that creates or deploys websites, software, ERP modules, integrations, automation or hardware artifacts.

**Acceptance still needed:** implement requirements → acceptance criteria → design → assignment → build → test → review → authorized deployment → monitoring with recorded ownership and dependency decisions. Demonstrate representative working products using architecture, development, database, testing, security, deployment and hardware responsibilities as applicable. ERP cases must prove business rules, deterministic calculations, permissions and audit trails. Hardware cases need supported specifications, schematics, component lists, firmware, simulations and assembly instructions. Label each result as designed, simulated, prototyped or physically tested; physical verification requires actual equipment, materials and qualified review. Preserve inspected-source and technical-documentation references used to resolve knowledge gaps.

**Priority:** staged Phase 2 milestones; no assertion that Aria or Jarvis can currently deliver these products autonomously.

## 6. Connect each agent to authorized knowledge and tools

**State: bounded business tools and document provenance exist; connector registry planned.** `TOOL_SCHEMAS`, `TOOL_HANDLERS` and `executeToolWithLog` in `src/server.js` implement explicit tool permission checks and client context. `src/lib/document-parser.js` records original-file SHA-256, extraction limits and partial/unsupported states; original files are retained. Jarvis has founder operational commands. Workspace `TOOL_CATALOG` entries such as `search_knowledge` are definitions, not proof of implemented search or an installed connector.

**Acceptance still needed:** a registry of authorized sources, allowed actions, client boundaries, credential ownership, connection health and freshness; tested revocation, permission changes, timeouts and write approval. Verify data-source assignment reaches the executing agent. Preserve references in answers and distinguish missing, partial, outdated and unsupported content. Validate authorized Jarvis visibility separately from client-scoped Aria access. DOCX extraction currently omits images/layout; spreadsheets omit formatting/charts/formula recalculation; PDF remains stored-only.

**Priority:** Phase 1 tool/source proof now; general connectors after freeze.

## 7. Make message handling a verifiable workflow

**State: partial single-agent workflow.** `handleMessage`, `runAgent`, the tool loops, `agent_runs`, `tool_calls` and the encrypted inbox provide routing, context/permissions, bounded tool execution and persisted results. Founder messages route to Jarvis before customer activation; a second personal LINE account is required to exercise Aria. Code stores run status and checks tool/delivery failures, but does not implement an explicit requirements/dependencies plan or individual-versus-team dispatcher for general work. Jarvis/Concierge plain chat is not a customer `agent_run`.

**Acceptance still needed:** each request's intent, requirements, essential clarifications, context/permissions, retrieved evidence, plan/assignees, permitted actions, outcome verification, answer and record must be inspectable. Test missing-information behavior, multi-agent dependencies, team selection and failure paths. Separate transport completion, model availability, tool success, correctness and actual delivery; the 9 September incident proves those are different outcomes.

**Priority:** Phase 1 real request evidence, then generalized workflow execution.

## 8. Apply mathematics and optimize performance purposefully

**State: measurements and bounded parsing exist; optimization unproved.** `src/lib/model-metrics.js` tracks per-run attempts, durations and provider-reported token fields, including unknown usage. Parser limits and fixed model deadlines bound some operations. `test/model-metrics.test.js` checks concurrent attribution and partial/unknown values. There is no demonstrated task-level constrained optimization, scheduling algorithm, vector/RAG pipeline or MCP comparison. Selecting the last five stored facts is not a validated memory or retrieval strategy.

**Acceptance still needed:** define task objectives, constraints, dependencies and resource limits; use deterministic calculations/statistics/probability/graphs/scoring/optimization only where justified. Compare a simple baseline with model choice, context size, caching, chunking, metadata filters, keyword/vector retrieval, ranking, freshness and MCP/API variants using the same correctness and permission criteria. Retain changes only when measured improvement preserves successful task completion. Record actual input/output/total/reasoning/cache usage separately, CPU/RAM scope and full customer latency; do not interpret missing usage as zero or a single small probe as capacity evidence.

**Priority:** free-allowance verification and Phase 1 measurements first; optimization experiments later under an explicit budget.

## 9. Support one-time and recurring work

**State: task capture, protected digest endpoint and message recovery exist; general scheduler planned.** Runtime tools create/list open tasks and Jarvis manages a checklist. `/cron/daily` requires its secret and pushes a digest when invoked. The webhook inbox persists before acknowledgment, deduplicates events and leases source processing; failed/uncertain work is retained rather than blindly replayed. This does not prove a scheduled job is configured, a follow-up executes automatically, or exactly-once external effects. The Codex progress heartbeat is separate from a Neurohands customer scheduler.

**Acceptance still needed:** every one-time/recurring job defines outcome, owner, deadline/schedule, time zone, dependencies, resource limits and escalation. Verify due execution, daylight/date boundaries where relevant, restart recovery, duplicate prevention, bounded retries, pause/stop/cancellation and actual outcome recording. Test lost external receipts before permitting recovery so a retry cannot silently repeat business effects.

**Priority:** preserve Phase 1 queue behavior; general scheduling after freeze.

## 10. Benchmark and improve continuously

**State: regression suite and usage instrumentation, not a representative benchmark.** The last saved Railway build reports 101 passing tests. These cover useful security/failure/persistence invariants with mocks and isolated PostgreSQL, not real-world task success rates. The single successful 8 September Gemini diagnostic is a connectivity sample; the later real Jarvis request failed. No Aria customer benchmark, team assessment or meaningful capacity/load percentile is established.

**Acceptance still needed:** register each observe → problem → proposal → implementation → test → baseline comparison → accept/revert experiment. Use previously unseen basic/intermediate/advanced cases at individual/team/department/organization levels. Report sample sizes, failures, limitations, requirement coverage, task success, first-attempt completion, accuracy, retrieval quality, tool success, reliability, latency, human intervention, resource use and user acceptance. Keep development examples separate from held-out cases. Test memory/workflow changes before production and increase autonomy only after demonstrated evidence.

**Priority:** define the Phase 1 baseline and collect real measurements; broader benchmark suite grows with capabilities.

## 11. Provide a concise daily progress and improvement report

**State: conversational updates and dated evidence exist; requested daily assessment format is not implemented in the product.** Jarvis's current `brief` is a deterministic orders/cases/tasks/checklist digest, not an independent operational assessment. There is no implemented Aria self-assessment workflow. Earlier recurring status checks described readiness too broadly; the incident evidence explicitly corrects that interpretation.

**Acceptance still needed:** a daily report follows yesterday's progress → implementation → tests → results → evaluation → next action. Cite the revision, dated observations and limitations; list unresolved problems and one highest-priority improvement. Include coordination/reliability/resources/oversight and understanding/document accuracy/clarity/speed/unresolved requests. Until agents actually generate evidence-backed assessments, label these sections **technical lead's assessment of Jarvis operations** and **technical lead's assessment of Aria client service**. Do not fabricate agent quotations or recommendations. Future agent-generated recommendations remain proposals to evaluate; report delivery requires a real delivery record.

**Priority:** immediate reporting discipline; automated in-product assessments are later work.

## 12. Maintain accountability, budget and delivery discipline

**State: security/recovery controls exist; $0 compliance unverified.** Runtime secrets are excluded from Git; code and tests cover role/client isolation, signed access and approval scopes. Recovery manifests and queue incident procedures preserve a recovery path. `src/server.js` remains a complete replacement server file. Model telemetry does not enforce a dollar budget. Private allowance/plan/invoice evidence is absent from the reviewed records, and the earlier illustrative paid Gemini rate does not establish an actual charge or a free allowance.

**Acceptance still needed:** verify the current account-specific free allowance, billing state, remaining usage, reset/expiry and hard spending controls for Railway, Supabase, every model provider, LINE and any added tool/service before incurring usage. A successful API key or a $0 invoice so far does not prove the next action is free. Keep a dated allowance register; do not buy credits, upgrade plans or run potentially billable probes/load tests while the allowance is unknown. Prevent automatic fallback to an unverified paid provider. Establish resource limits and handling for exhaustion, unknown usage and failed calls, which may still consume allowance. Continue local/mock verification where remote $0 use is unproved. Do not silently stop an existing live service merely to make a budget claim; report any conflict and the concrete zero-cost options. Verify recovery after changes and record authorization for real external effects.

**Priority:** immediate constraint on the current incident and all subsequent milestones.

## Current milestone and acceptance sequence

Work one delivery milestone at a time. Read-only ownership and allowance verification support Phase 1; they are not a reason to implement unrelated Phase 2 features early.

| Order | Next check | Evidence required to close it |
| --- | --- | --- |
| 1 | Establish the $0 operating boundary | Account-specific allowances, remaining quantities/reset dates, billing/spend controls and permitted test envelope; uncertainty remains explicit |
| 2 | Restore a reliable AI response within that boundary | Correct configured provider credentials, controlled real request, provider outcome and actual LINE answer; no key disclosure or invented token total |
| 3 | Complete KNC/Aria document proof | Second-account activation, original ownership/hash, correct distinctive answer and matching authorized successful document trace, run and delivery |
| 4 | Finish controlled failure/recovery checks | Wrong-client/role/tool denial, model/DB/LINE failure behavior, redelivery/interruption evidence and recovery verification without duplicate effects |
| 5 | Reconcile source/destination assets and accept the baseline | Verified identities, preserved history/data/files/config/integrations, restored backups, destination operation and explicit unresolved-asset disposition |
| 6 | Freeze Phase 1 and start the next workforce milestone | Requirement-scoped acceptance record, known limitations, tested rollback and versioned baseline; only then enable reviewed Phase 2 work |

The second-account customer action, inaccessible source assets and unknown allowances are genuine dependencies. They do not justify claiming completion or endlessly restating status. Revalidate each blocker and take available independent action such as local incident tests, evidence reconciliation or review of the permitted next change. Do not generate additional model requests simply to produce progress updates.
