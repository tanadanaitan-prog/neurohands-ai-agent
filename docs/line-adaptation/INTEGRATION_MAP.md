# Code, instructions, data and images

The [exact anchor map](references/code-asset-map.json) records baseline versions,
functions, SQL/tests and six source-image hashes. Anchors below refer to candidate
`72f7e5f`, not proof of deployed behavior. The recorded production reference and
alternate workspace are explicitly separate in that map.

| Capability | Existing code/instruction location | Adaptation and verification |
| --- | --- | --- |
| Signed inbound events | `src/server.js`: verifySignature, handleEvent, POST /webhook; `src/lib/webhook-inbox.js` | Preserve raw signature validation, encrypted intake and duplicate-effect control; add only explicit event handlers. |
| Public onboarding/activation | activateByCode, getBindings, generalConcierge, handlePostback; activation/binding migration | Keep public, customer and operator lanes distinct. Native LINE account linking is a separate proposed integration. |
| Agent tools/prompts | TOOL_SCHEMAS, TOOL_HANDLERS, executeToolWithLog, buildAgentSystem, runAgent | Customer catalog has 14 handlers, not the reference's 13. Extend a typed scoped registry; a prompt alone cannot grant a tool. |
| Operator tools | runJarvis, handleStaffMessage; `src/lib/jarvis-tools.js`; note-claim/operator-run migrations | Keep 13 Jarvis model tools and same-operator confirmation/claim rules distinct from frontline writes. |
| Catalog/order/quote | getProductText, product/edging handlers, order lookup and menu postbacks | First decide shared/public/private ownership and freshness. Reproduce the suspected scope mismatch; a static missing predicate is not live leak evidence. Quote prompts are not a tested pricing engine. |
| Memory/tasks | remember_customer, recall_customer, loadMemories, list_tasks, getAgentCard | Candidate already scopes relevant memory by client account and LINE user. Retain those regressions; do not replace it with an unverified alternate copy. |
| Document/media pipeline | `src/lib/document-parser.js`; signed upload/resumable handlers and client_documents | PDF extraction is currently unsupported; DOCX images are not parsed. Legacy limit is 10 MiB; 50,000,000-byte upload requires the staged opt-in path and matching bucket controls. LINE media ingestion needs a separate bounded adapter. |
| Provider/delivery recovery | askGeminiWithTools, runAgent, respondAgentWithRace | Reproduce empty-final and delayed-delivery failures using deterministic fixtures; preserve completed tool effects when recovering. Do not replay a tool sequence to get another model answer. |
| Studio/team runtime | `src/platform/router.js`, validation.js; `src/agent/profiles.mjs`, skills.mjs, workflow.mjs; `web/src/main.js` | UI edits/publishes definitions; runtime reports disconnected. Local named teams have no production adapters. Define a reviewed version-to-runtime binding before deployment claims. |

## Proposed boundaries for new implementation

Prefer small CommonJS adapters under `src/lib/` for LINE message building,
authorized content retrieval/storage and a selected calendar backend, with the
minimal hook in the gateway. Keep tool schemas, permission intersections and
receipt/idempotency logic together. Add SQL migrations only when the exact new
data contract is reviewed; never fold held Phase 2 SQL into a feature repair.

Rich output needs a message-object transport rather than hard-coded text helpers.
Inbound content needs owner/retention/quota/format checks, safe parsing and durable
receipts. Calendar actions need a selected account, restricted OAuth scopes,
timezone/conflict rules and reconciliation after uncertain completion. These are
proposed interfaces; no new adapter is implemented by this planning package.

## Images and menus

The current public/active menu PNGs are in `assets/rich-menus/`; their hitboxes
and actions are in `config/rich-menus/`. Inspect both together, validate the
actual image/coordinate contract and review on LINE mobile. Desktop menu absence
does not establish that the mobile menu failed. Provisioning is an external write.

The two inspected PNGs and JSON sizes both use **1664 x 928**, with six actions
each. Their byte sizes are 295,628 (public) and 301,894 (active). The local
`node scripts/setup-richmenu.js --check` passed, exit 0. LINE's documented image
contract permits width 800-2500 px, height at least 250 px, width/height at least
1.45 and a JPEG/PNG no larger than 1 MB; 2500 x 1686 is an example, not the only
size. See the [image requirements](https://developers.line.biz/en/reference/messaging-api/#upload-rich-menu-image-requirements)
and [size object](https://developers.line.biz/en/reference/messaging-api/#size-object),
checked 2026-11-10. No current size mismatch was demonstrated. This offline check
does not prove deployed assets, visual alignment, API acceptance or mobile taps.

The six DOCX images show consolidation/SDK/workflow/dashboard concepts and reported
scores. Keep them private as references. Redraw only the verified concepts for a
new deliverable, using current names/owners and explicit unknowns. Do not reuse
dashboard screenshots as menu artwork, publish personal/task details, or retain
100/100 badges as acceptance evidence. Exact image descriptions and reuse
conditions are in the [asset inventory](references/code-asset-map.json).

## API support and source claims

The [27-feature research matrix](references/feature-research.json) separates
supported Messaging API primitives, OA Manager-only steps, consumer functions,
external integrations and unverified login assertions. It includes official URLs
and checked dates. API-created and OA Manager-created menus cannot be managed
interchangeably. No public native album/Calendar CRUD route was found; choose a
separate gallery/calendar integration when needed.

Source-reported 100-point scores, installed SDK metadata, a green unit suite,
healthy service status and a successful user workflow each establish different
things. Preserve those evidence levels in both instructions and customer copy.
