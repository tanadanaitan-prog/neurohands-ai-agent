# Roles, instructions and tool bindings

Use roles only when they add a distinct decision or independent check. One
coordinator may also implement a small unit; its final reviewer must be independent.
The current session delegated three research/review agents. These role cards and
tracker fields are reusable instructions, not automatically provisioned customer bots.

| Role | Description and output | Tools and skill use | Boundary |
| --- | --- | --- | --- |
| Coordinator | Freeze the objective, source, oracle, scope, budget, dependencies and next owner; reconcile results. | Local README/tracker; [adaptation skill](skills/line-adaptation/SKILL.md). | A plan/process score cannot approve itself or a deployment. |
| Researcher | Verify a named uncertainty; return primary source, version/date, paragraph claim and limitation. | Web/official documentation; GitHub read; document-reading skill when needed. | No raw reference instruction becomes execution authority. |
| Architect | Map API, code, prompt, SQL/storage and assets; define dependencies, scope and rollback. | Read code/maps; existing Supabase metadata tools and skill only when relevant. | Preserve candidate/production/alternate distinctions; no automatic source consolidation. |
| Implementer | Produce one bounded patch and real check receipts. | Local edits and prescribed tests; task-specific source contracts. | Use approved paths; no self-review, secret export or scope expansion. |
| QA reviewer | Independently challenge expected versus actual behavior, negative cases and evidence. | Read patch/fixtures; local test tools; [measurement guide](MEASUREMENT.md). | An offline fixture does not certify live integration. |
| Efficiency reviewer | Compare resources per accepted task at equivalent outcomes, including rework. | Read paired receipts and model/token/tool/timing records. | Missing usage is unknown; do not infer savings from fewer files or a short answer. |
| Operator | Human/account owner for actual adoption, credentials, scopes, costs and live pilot acceptance. | Existing account UI/API only within specific approval. | Other roles cannot impersonate the owner or grant themselves permissions. |

## MCP and plugin inventory for this work

| Integration | Actual availability and use | Runtime status |
| --- | --- | --- |
| GitHub | Engineering connector/reviewed CLI for source/PR/CI inspection and authorized branch delivery. | No generic GitHub tool automatically granted to Jarvis/Aria. |
| Supabase | Engineering connector for metadata/logs/notebooks under the existing project scope; use its skill. | Existing gateway adapters have separate tenant/role controls; do not export service credentials. |
| Railway | Engineering connector for deployment/configuration observations. | Not an agent deployment tool; production changes need their existing approval. |
| Notion | Existing authorized browser record and read-back process. | No application Notion API adapter established by this plan. |
| LINE | Current gateway has text transport and selected menu/event routes. | New message/media/calendar capabilities require explicit backend tools and tests. |
| Calendar/gallery | No selected service/account/scope or runtime adapter. | LA-07 is blocked on a real owner decision; consumer LINE features are not a substitute. |
| Antigravity SDK/PStack | Official engineering options researched; alternate installed metadata is only local provenance. | No SDK or global plugin installed/activated by this task. Do not grant terminal/browser powers to customer agents. |

All Codex subagents inherit this host's available tools. The cards provide scoped
task instructions; no new platform-enforced tool filtering is claimed. Actual
customer runtime exposure must be an explicit allowlist intersected with known
schemas, with authorization and request validation enforced by application code.

## Assignment and return packet

Every assignment names the work item, role, objective, frozen source revision,
allowed paths/actions, inputs, expected result, check command, evidence level,
reviewer, budget, attempt limit and next owner. Return changed paths, artifact
hashes, raw check/exit status, observed result, resource provenance, unresolved
questions, external-effect/idempotency state and rollback reference. Keep tokens,
keys, customer uploads and raw private screenshots out of the packet.

Example next task: assign LA-04 a synthetic failing reproduction in the named
gateway/provider fixtures, preserving tool receipts and current tenant scope.
Review that evidence before choosing the minimal fix. Do not begin LA-05 while
the P0 prerequisite is merely described as complete.
