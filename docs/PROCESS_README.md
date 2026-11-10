# Process README — start, verify and continue

Reviewed 10 November 2026. Read this before running a command. Run commands from
the intended repository checkout, and record its exact commit. PR21 remains a
draft; using this guide does not approve its adoption or a production release.

## Start a work session

1. Read the [continuation snapshot](CONTINUATION_STATE.json),
   [knowledge register](KNOWLEDGE_INDEX.md) and current task/approval scope.
2. Run `git status --short` and `git rev-parse HEAD`. Preserve existing changes.
   The local original folder, PR21 checkout and deployed main are different states.
3. Check `node --version` (the package requires Node 24), `npm --version`, and
   `python --version` when using the structure checker (Python 3.11 or newer).
   Follow the [root setup](../README.md) if locked dependencies are missing.
4. Choose the process below. Keep credentials in the relevant private environment
   file; never copy them into a README, test output, Notion or a support message.
5. Record objective, owner, expected result and permitted actions. Verify current
   allowance before any model or trace request. The latest health snapshot did
   not verify provider authentication or credits.

## Every package command

These 26 names correspond to [package.json](../package.json). A command is a
starting point, not evidence it passed. Checks may write local result files.

| Script | Command | Purpose and prerequisites | Guide / expected evidence |
| --- | --- | --- | --- |
| `start` | `npm start` | Start the Express gateway; loads private `.env` if present. May access configured services. Use approved test credentials for local work. | [Setup](../README.md), [Railway](RAILWAY_SETUP.md); inspect startup, `/version` and `/ready` separately. |
| `check` | `npm run check` | Source syntax and local contracts; includes non-publishing rich-menu validation. | [Setup](../README.md); exit 0 and captured output. |
| `test` | `npm test` | Node test suite with the installed dependencies. | [Setup](../README.md); record current pass/fail/skipped counts and revision. |
| `richmenu:check` | `npm run richmenu:check` | Validate local menu definitions/assets. | [Setup](../README.md); local validation only. |
| `richmenu:setup` | `npm run richmenu:setup` | Publish/link LINE menus using private credentials; changes the channel. | [Setup](../README.md); requires specific channel/design approval. |
| `build` | `npm run build` | Build the web application from Vite configuration. | [Web preview below](#web-preview); generated `web/dist` is not deployment acceptance. |
| `passport:check` | `npm run passport:check` | Validate local software-passport records. | [Passports](SOFTWARE_PASSPORTS.md); passing does not verify accounts/allowance. |
| `safe-response:check` | `npm run safe-response:check` | Run the local customer-safe response checker. | [Checker](../scripts/check-customer-safe-responses.js); record output/exit status, not live response acceptance. |
| `release:audit` | `npm run release:audit` | Inspect release controls with incomplete evidence allowed. | [Passports](SOFTWARE_PASSPORTS.md); inspect partial controls even when command succeeds. |
| `release:gate` | `npm run release:gate` | Require the complete release controls. | [Passports](SOFTWARE_PASSPORTS.md); expected to fail while acceptance is incomplete. |
| `provider:check` | `npm run provider:check` | Check local provider contracts. | [Checker](../scripts/check-provider-contracts.js); does not authenticate or call a model. |
| `untrusted-pr:check` | `npm run untrusted-pr:check` | Validate the repository's isolation workflow. | [Boundary](UNTRUSTED_EXECUTION_BOUNDARY.md); capture result; not an arbitrary-code safety guarantee. |
| `dev:web` | `npm run dev:web` | Run the laptop Vite preview; interactive actions may require a separate backend. | [Web preview below](#web-preview); verify the printed URL and UI independently. |
| `lab:check` | `npm run lab:check` | Offline synthetic graph/echo check with network disabled by the harness. | [Local setup](guides/lab/LANGGRAPH_LOCAL_TEST.md); zero model/network requests. |
| `lab:trace` | `npm run lab:trace` | Upload a fixed synthetic trace to LangSmith, subject to its admission/allowance checks. | [Local setup](guides/lab/LANGGRAPH_LOCAL_TEST.md); requires private key and verified allowance. |
| `lab:studio` | `npm run lab:studio` | Checks/starts local Ollama before launching Studio, including when an echo graph is intended. | [Agent lab](guides/lab/LOCAL_AGENT_LAB.md); verify local service, then choose a graph. |
| `lab:chat` | `npm run lab:chat` | One fixed synthetic local-model question; may start local Ollama through the helper. | [Local setup](guides/lab/LANGGRAPH_LOCAL_TEST.md); response plus actual timing/usage. |
| `lab:chat:trace` | `npm run lab:chat:trace` | Fixed synthetic model check with optional LangSmith export. | [Local setup](guides/lab/LANGGRAPH_LOCAL_TEST.md); model and trace acceptance are separate. |
| `lab:agent:trace` | `npm run lab:agent:trace` | Fixed synthetic agent/tool check with gated trace export. | [Agent lab](guides/lab/LOCAL_AGENT_LAB.md); verify tool result and trace separately. |
| `lab:agent:check` | `npm run lab:agent:check` | Eleven synthetic tool/state workflows through local Studio API; requires server at port 2024 and its model. | [Agent lab](guides/lab/LOCAL_AGENT_LAB.md); review assertions and actual answer content. |
| `lab:benchmark:baseline` | `npm run lab:benchmark:baseline` | Measure plain local model on the fixed rubric. | [Agent lab](guides/lab/LOCAL_AGENT_LAB.md), [rubric](AGENT_BENCHMARK_RUBRIC.md); retain exact model/settings and human review. |
| `lab:benchmark:equipped` | `npm run lab:benchmark:equipped` | Measure equipped local agent against the same rubric. | [Agent lab](guides/lab/LOCAL_AGENT_LAB.md); compare equivalent attempts; preserve prior outputs. |
| `lab:team:check` | `npm run lab:team:check` | Deterministic named-workflow self-check. | [Named workflows](NAMED_AGENT_WORKFLOW.md); plumbing/scope evidence, not model quality. |
| `lab:team:conformance` | `npm run lab:team:conformance` | Synthetic named-workflow conformance cases. | [Named workflows](NAMED_AGENT_WORKFLOW.md); record case results and failures. |
| `lab:team:model:check` | `npm run lab:team:model:check` | Dry-run the real-model workflow harness configuration. | [Named workflows](NAMED_AGENT_WORKFLOW.md); dry-run does not prove inference. |
| `lab:team:model` | `npm run lab:team:model` | Real local-model named workflow; requires approved local setup and synthetic inputs. | [Named workflows](NAMED_AGENT_WORKFLOW.md); use a new run/output location, retain failures. |

## Web preview

From the selected checkout, run `npm run dev:web` and open the URL printed by
Vite. The [configuration](../web/vite.config.mjs) binds to `127.0.0.1`, requests
port `5173`, uses base `/studio/`, and proxies `/api/studio` to a separately
running backend at `http://127.0.0.1:3000`. Use the printed port if it differs.

Rendering the UI does not establish working authentication, storage, a connected
agent runtime or production deployment. The inspected Studio router reports
`runtimeConnected: false`. Start a backend only with approved test configuration;
do not point experiments at private customer records.

Stop the foreground Vite or Studio process with **Ctrl+C** in its terminal.
Stopping a local server does not stop Railway production. Do not delete state,
signing keys, dependency folders or lock files as a shutdown method.

## Laptop lab preflight and recovery

The 10 November 19:20 Bangkok health snapshot found both local Ollama port 11434
and LangGraph port 2024 offline. That is a dated observation, not a permanent
condition. Recheck before a model task. The guides' earlier successful runs are
historical evidence and do not establish today's readiness.

Follow [local setup](guides/lab/LANGGRAPH_LOCAL_TEST.md) for private configuration
and [agent lab](guides/lab/LOCAL_AGENT_LAB.md) for model/graph selection. Preserve
the distinction that `lab:studio` initializes Ollama before starting its server;
use `lab:check` for an independent offline echo instead. Preserve
the configured model name and private paths. Do not download another large model,
switch providers or increase spending to bypass a failure. Separate offline
`lab:check`, local inference, Studio API checks and LangSmith tracing. No automatic
Ollama-to-cloud takeover is established by these instructions.

## Cloud and business processes

| Process | Read first | Required result and boundary |
| --- | --- | --- |
| GitHub review / continuation | [Knowledge register](KNOWLEDGE_INDEX.md), [structure map](architecture/PROJECT_STRUCTURE.md) | Work on the permitted branch, record exact revision, run relevant checks, obtain the applicable review. PR21 stays draft. |
| Supabase inspection / migration / recovery | [Supabase README](../supabase/README.md) | Inspect current metadata and applied versions. Test schema changes in isolation; no blanket migration push or live restore. |
| Railway deployment / health | [Railway setup](RAILWAY_SETUP.md), [current audit](INTEGRATION_AUDIT_2026-11-10.md) | Verify deployed commit and component health. Approval for docs/checks does not approve deployment. |
| LINE routing / Jarvis / Aria / Concierge | [Jarvis pilot](JARVIS_PILOT.md), [goal acceptance](GOAL_ACCEPTANCE.md) | Validate role, scope, permitted tools, answer and delivered trace. A reply alone is insufficient. |
| Webhook failures / replay | [Webhook recovery](WEBHOOK_RECOVERY.md) | Inspect retained-event state; resolve uncertain work before replaying; preserve encryption-key continuity. |
| Documents / upload | [Upload architecture](LARGE_UPLOAD_ARCHITECTURE.md), [Supabase README](../supabase/README.md) | Verify allowed format, client scope, actual bucket limit, storage receipt and parsing. A file link does not establish successful ingestion. |
| Daily digest / scheduled operations | [Gateway endpoint overview](../README.md), [Jarvis pilot](JARVIS_PILOT.md) | External trigger, private authorization and confirmed delivery are separate. Stored tasks are not autonomous calendar scheduling. |
| Notion records / follow-up | [Knowledge register](KNOWLEDGE_INDEX.md) | Append a named dated record when requested; reload/read back; retain earlier evidence and next owner. |

The local untracked architect/model-lab work has its own recorded proposals and
stop conditions. Read its existing start file before any separate assignment.
Sineid remains on hold. These processes are not enabled by creating documentation.

## Finish, hand off and continue

Record the exact command, revision, exit status, output location and scope.
Separate current results from recorded earlier tests. Report failures as failures
or unknowns; do not silently rerun uncertain business actions. Preserve the source
of each claim and review the changed behavior before release.

Update the continuation record with completed work, unresolved issue, next owner,
next bounded action and approval needs. Append the dated Notion entry and verify
it saved. Resume from that state on the next request. A README guides execution;
it does not create autonomous tools, grant access or establish release acceptance.
