# Neurohands documentation

Start with the [10 November integration audit](INTEGRATION_AUDIT_2026-11-10.md) and
[continuation snapshot](CONTINUATION_STATE.json), then inspect the current Git and
remote state before acting on dated observations. The snapshot is a manual
handoff, not a runtime controller or release approval.

This index covers the 31 documentation files present at revision `52bfc19`.
Three lab guides now live under `guides/lab/`; their original paths remain as
forwarding pages with the original section headings. Runtime, migration,
registered evidence and recovered-source paths retain their existing locations.

## Current status and history

| Document | Use it for |
| --- | --- |
| [Ordered project structure](architecture/PROJECT_STRUCTURE.md) | Folder reading order, platform flow, data catalog and Python checks. |
| [Process README](PROCESS_README.md) | Every package command, inputs, success evidence, local start/stop and cloud handoffs. |
| [Central knowledge and capability register](KNOWLEDGE_INDEX.md) | Saved Notion record, plugin/API/skill/memory boundaries and explicit-request updates. |
| [Integration audit — 10 November 2026](INTEGRATION_AUDIT_2026-11-10.md) | Dated platform checks, boundaries and next actions. |
| [Continuation snapshot](CONTINUATION_STATE.json) | Recorded revision, pending evidence, owners and approval boundaries. |
| [Project history and technical map](NEUROHANDS_PROJECT_HISTORY_AND_TECHNICAL_MAP.md) | Consolidated historical architecture, decisions and evidence; keep its dates in view. |
| [Connection matrix](APP_CONNECTION_MATRIX.md) | Dated connection observations and their limits. |
| [Live status](LIVE_STATUS.md) | Dated runtime incidents and acceptance evidence. |
| [Phase 1 status](PHASE1_STATUS.md) | Recovery history and remaining pilot work. |

## Delivery plans and acceptance controls

| Document | Use it for |
| --- | --- |
| [LINE adaptation plan](line-adaptation/README.md) | Verified feature/code/asset mapping, roles, skill, tracker and separate measurement targets. |
| [Goal acceptance](GOAL_ACCEPTANCE.md) | Required customer proof and the Phase 1/Phase 2 boundary. |
| [Project plan](PROJECT_PLAN.md) | Longer-term milestones; planned capabilities are not completion claims. |
| [Goal continuity plan](GOAL_CONTINUITY_PLAN.md) | Proposed continuity deliverables and their recorded stop conditions. |
| [Software Passports](SOFTWARE_PASSPORTS.md) | Admission, allowance and release-evidence boundaries. |
| [Untrusted execution boundary](UNTRUSTED_EXECUTION_BOUNDARY.md) | CI isolation controls and limits of local evidence. |

## Operating guides

| Document | Use it for |
| --- | --- |
| [Railway setup](RAILWAY_SETUP.md) | Recorded service/build settings; distinguish historical setup from current inspection. |
| [Provider setup](FREE_PROVIDER_SETUP.md) | Provider configuration history and verified-allowance requirements. |
| [Jarvis pilot](JARVIS_PILOT.md) | Operator capabilities, proposals and pending live acceptance. |
| [Upload architecture](LARGE_UPLOAD_ARCHITECTURE.md) | Existing and staged upload paths and activation prerequisites. |
| [Webhook recovery](WEBHOOK_RECOVERY.md) | Event recovery, duplicate-effect boundaries and encryption-key continuity. |

## Laboratory guides and evaluation

Lab instructions use synthetic data and retain their stated access, usage and
approval boundaries. Moving a guide does not install a model or connect a lab
agent to production. Run repository commands from the repository root.

| Document | Use it for |
| --- | --- |
| [Local LangGraph setup](guides/lab/LANGGRAPH_LOCAL_TEST.md) | Local chat, Studio and tracing setup; [previous location](LANGGRAPH_LOCAL_TEST.md). |
| [Local agent guide](guides/lab/LOCAL_AGENT_LAB.md) | Concierge, Aria and Jarvis lab usage; [previous location](LOCAL_AGENT_LAB.md). |
| [Third-model test](guides/lab/PUBLIC_MODEL_TEST.md) | Separate synthetic/public provider test; [previous location](PUBLIC_MODEL_TEST.md). |
| [Named-agent workflows](NAMED_AGENT_WORKFLOW.md) | Fixed local one-, two- and five-role experiments. |
| [Benchmark results](AGENT_BENCHMARK_RESULTS.md) | Dated measured attempts and remaining failures. |
| [Benchmark rubric](AGENT_BENCHMARK_RUBRIC.md) | Human review criteria for those attempts. |

## Recovery provenance and preserved originals

These are recovery records, not alternate application entry points. Preserve
them alongside their manifests; do not deploy a recovered copy in place of the
reviewed application.

| Record | Purpose |
| --- | --- |
| [Import manifest](import-manifest.json) | Recorded source-import provenance. |
| [Recovery manifest](recovery-manifest.json) | Recovered-server provenance and source references. |
| [Originals README](originals/README.md) | Context for the preserved source files. |
| [Original package](originals/package.json) | Preserved package definition. |
| [Original active menu](originals/richmenu-active.json) | Preserved active-user menu definition. |
| [Original public menu](originals/richmenu-public.json) | Preserved public menu definition. |
| [Truncated server](originals/server.js.truncated.txt) | Historical incomplete source retained for comparison. |
| [Recovered server](originals/server.v3.10.recovered.js.txt) | Preserved recovered source; active code remains in `src/server.js`. |
| [Original menu setup script](originals/setup-richmenu.js.txt) | Preserved setup-script source. |

The application [README](../README.md) remains the root entry point. Supabase
[deployment notes](../supabase/README.md), runtime source and machine-readable
registers remain in their existing folders. Local evidence under `outputs/` and
unfinished engineering/model-lab material are separate from this tracked index.
