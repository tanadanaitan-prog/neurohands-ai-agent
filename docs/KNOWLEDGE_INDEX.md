# Central knowledge and capability register

Recorded 10 November 2026. This is the continuation entry point for the current
organization task. It does not implement the separate September
[continuity-engine proposal](GOAL_CONTINUITY_PLAN.md) or approve a release.

## Open the central record

[Neurohands — Knowledge & Evidence | 2026-11-10](https://app.notion.com/p/Neurohands-Knowledge-Evidence-2026-11-10-4141c2ab14e380de891cf0911b5cd202)
is saved under the founder-supplied Tasks database. Access still requires the
workspace's existing permissions; this link does not make the page public.

At **2026-11-10 11:51:48 UTC / 18:51:48 Bangkok**, a browser reload confirmed all
seven summary sections and the attached 36-file evidence archive persisted.
The archive was prepared at 10:45:55 UTC from organization revision
`8925e0d20e635b24c2d1241be05dd614951fd6a6`. Its preparation-time documents still
say unpublished; the later page and publication receipt supersede only that
publication status. Preserve the archive as recorded evidence.

The local archive's SHA-256 is
`299550eaf9be79ba90bf42cd02e990bdae2123fec13dfc8882b906b49eb093c6`.
The attachment appeared as 65.1 KiB after reload. Download verification timed
out, so remote byte integrity is **not verified**. Local hashes do not prove
that a remote attachment is byte-identical.

## Which source is authoritative?

| Question | Evidence to use |
| --- | --- |
| What source was reviewed? | Exact Git commit and repository path; branch names can move. |
| What was running or configured? | Dated direct platform observation, deployed revision and scoped runtime evidence. |
| What was tested? | Command, revision, exit status and raw result; distinguish synthetic, local and live tests. |
| What is planned, accepted or still unknown? | Dated Notion decisions and [continuation snapshot](CONTINUATION_STATE.json), with owners and original approval scope. |
| What changes may go live? | Specific founder approval and the applicable acceptance evidence; a green test or document is insufficient. |

Notion indexes findings and evidence. Git remains the source-code record;
platform observations are time-bound. Neither replaces customer acceptance.

## Plugins, APIs, skills and memory

These entries describe observed engineering access and inspected source, not
a guarantee that every role can use every service. Recheck before acting.

| Capability | Purpose and evidence | Access and continuation boundary |
| --- | --- | --- |
| GitHub connector / reviewed CLI | Source and PR/CI inspection used in this audit; see [integration audit](INTEGRATION_AUDIT_2026-11-10.md). | Engineering access; no general GitHub tool is granted to Jarvis. Work in a separate branch; preserve main approval. |
| Supabase connector | Metadata, migration history, RLS/grants and health observed in the audit. | No customer rows or secret exports. Application database access is implemented separately in [gateway](../src/server.js) and [repository](../src/platform/repository.js). |
| Railway connector | Recorded service, deployment and non-secret configuration metadata. | Engineering access is not an agent deployment tool. Configuration/deployment changes need their existing approvals. |
| Notion browser access | Seven-section record and archive saved and read back; direct Notion connector unavailable during publication. | Explicit-request knowledge updates through the authorized workspace. No background sync or agent Notion tool was established. |
| LINE Messaging API | Webhook, reply/delivery and role routing in [gateway](../src/server.js). | Platform features, role tool permissions and live success are different claims. Full second-account customer proof remains pending. |
| Configured model APIs | Gateway adapters and [provider guide](FREE_PROVIDER_SETUP.md). | Reconfirm current free allowance before inference. Connector availability does not prove model authentication or answer quality. |
| LangGraph / Ollama / LangSmith | [Local lab](guides/lab/LOCAL_AGENT_LAB.md), [graph](../src/agent/graph.mjs), optional tracing. | Synthetic local experiments; last service checks did not establish current connectivity. No automatic local/cloud failover is claimed. |
| General MCP runtime | No generic application MCP integration found in inspected source/script/package paths. | Codex's connectors do not automatically equip customer agents. Any new runtime tool needs scoped implementation and tests. |
| Supabase and computer-use skills | Engineering guidance used for platform inspection and authorized Notion browser publication. | Local assistant instructions; not imported into production agent prompts or permissions. |
| Token-efficiency skill | Scoped guidance for avoiding repeated reads, unnecessary output and unsupported savings claims. | Current assistant review process only; no provider/model setting or agent code optimization was applied by using the skill. |
| Efficiency/evidence and research reviewers | User-requested independent checkpoint reviews on 10 November. | Receive compact checkpoints; not continuous observers. Research uses primary docs and relevant public implementations; social posts require corroboration. |
| Production agent memory | Scoped records, delivered operator context and notes described in [audit](INTEGRATION_AUDIT_2026-11-10.md#memory-training-and-unfinished-folders) and [Jarvis context](../src/lib/jarvis-context.js). | Customer data stays in its existing authorized store; do not export it to this knowledge index. |
| Local workflow memory | Synthetic state and handoffs in [workflow](../src/agent/workflow.mjs). | Separate from live customer memory; a local test does not prove production persistence. |
| Project knowledge / assistant memory | Dated Git documentation, evidence archive and Notion index support continuation. | Records are not model weights, model training, guaranteed recall or permission to copy private assistant memory. |

## Update when the user asks

1. Read the latest dated Notion entry and continuation snapshot. Record the
   requested outcome, exact revisions, allowed paths and acceptance evidence.
2. Inspect changed source and relevant platform metadata. Use the appropriate
   available connector first; state any access failure or unknown value.
3. Research only decisions needing verification. Prefer current official docs
   and relevant public implementations. Compare applicability, not popularity.
4. Make authorized changes on an isolated branch. Run relevant checks and
   preserve raw errors/results. Keep historical results tied to their revision.
5. Request independent evidence/efficiency review at meaningful checkpoints and
   method review when choosing an approach. Reviewers do not grant authority.
6. Append a named, dated record with UTC/Bangkok time, source revision, changed
   items, tests, decisions, owner and unresolved gaps. Update the index; keep
   earlier evidence unchanged. Never include credentials or customer content.
7. Reload/read back the saved Notion content and record page ID, verification
   time and any mismatch. Verify attachment bytes if a byte-integrity claim is
   required; otherwise state the limit. Report only the outcome actually proven.

Recommended record name: `YYYY-MM-DDTHHMMSSZ__TOPIC`. The first archive contains
platform/source map, audit, repository comparison, lessons/decisions and queue.
This is an explicit-request procedure, not an autonomous scheduler.

## Current delivery and adoption

The organization changes are in draft PR21, based on PR13's candidate branch.
The original working folder retains its unfinished files; main and production
were not changed by organization or Notion publication. ENG/QA review and a
scoped adoption decision remain outstanding. Resolve this boundary before
describing the organization as adopted across the live system.

The [current state](CONTINUATION_STATE.json) and
[integration audit](INTEGRATION_AUDIT_2026-11-10.md) separately retain remaining
schema, provider-allowance, LINE pilot and release work. This organization task
does not silently expand into implementing those held operational changes.
