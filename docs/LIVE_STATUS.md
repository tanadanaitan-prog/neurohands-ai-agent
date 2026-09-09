# Live pilot status

## Current checkpoint — 9 September 2026

- **Verified release:** [PR #11](https://github.com/tanadanaitan-prog/neurohands-ai-agent/pull/11) merged as `0ab9f09cfa68ab325fbdaf85ad0d1ddaa1580dc0`. Railway deployment `bd66d12d-ea46-4b5c-a830-ac47c8958e47` succeeded at 16:37 UTC (23:37 Bangkok), passing **189 tests with zero failures**, syntax/menu checks and the build. `/version` matched the release and `/ready` returned HTTP 200 with `ready: true`. The release adds safe account-failure classification, stopping repeated attempts on a rejected route, founder `health`/trace reporting, and a separate Inkling synthetic harness. These are deployment checks, not live AI acceptance.
- The owner selected `thinkingmachines/inkling-small:free` for synthetic/public inputs only. Three non-secret `THIRD_*` values are configured in Railway. The inspected service has no `THIRD_API_KEY`, and a value-free runtime check found no OpenRouter-format key in the intended model-key variables. Key location is awaiting clarification; no live Inkling request has been made. [Third-model setup](PUBLIC_MODEL_TEST.md).
- A fresh read-only database check at 16:39 UTC found one parsed KNC sales document, zero active customer bindings, zero Aria runs and zero operator runs. No webhook had arrived since the PR #11 release. Real founder and second-account customer acceptance remain pending.
- **Original document verified at 16:42 UTC:** an authenticated, read-only inspection from the deployed container downloaded the single KNC sales original from the private bucket. Its account, department, storage path, byte length and recorded SHA-256 matched; parsing the original again produced the same stored extraction. This used server credentials and does not establish customer authorization, an Aria tool trace or LINE delivery. No records were changed and no model was called. Detailed evidence remains private.
- **One parsing measurement:** the 4,449,026-byte original took 126.91 ms to parse again, using 225.288 ms user CPU and 20.169 ms system CPU. The separate inspection process reached 132,440 KiB peak RSS. CPU time is accumulated CPU work, not elapsed customer time; peak RSS covers the whole inspection process. Download/database time, model processing and LINE delivery are excluded. This one file is not a representative benchmark or capacity estimate.

- **Verified runtime release:** [PR #9](https://github.com/tanadanaitan-prog/neurohands-ai-agent/pull/9) merged as `16a0cbee733862872cd232826e2c4e86145e0846`. Railway deployment `1b371129-a52e-4072-8b35-9119ff430006` succeeded at approximately 16:04 UTC (23:04 Bangkok). Its build passed **157 tests, zero failures**. `/version` returned the exact release commit and `/ready` returned HTTP 200 with `ready: true`. These are deployment checks, not live AI acceptance; no inference requests were made during release verification.
- Earlier PR #7 (`899628db273cd26b6b2ed21590e5ad151e5a7bdb`) was deployed with 101 passing build tests. Readiness and delivery checks do not establish successful AI answers.
- The latest inspected real founder greeting failed: Gemini reached the application's 15-second request timeout; Groq rejected authentication with HTTP 401. LINE delivered the failure notice. The reason for Gemini's delay is not established.
- The owner reports replacing the Groq key. A Groq-only probe returned HTTP 401 in 96 ms. After committing the staged variables and explicitly restarting Railway, an authentication-only model-list request again returned 401. No successful Groq answer was established. Changing the model alone cannot repair a rejected API key.
- Earlier on September 9, PR #8 published the simpler README and goal acceptance record as `c57de7e5fc7c9b50d63ab98ad4f9855683f5ce77`; its build passed 101 tests. That revision preceded the PR #9 Jarvis runtime and did not implement the Gemini disable flag. Temporary pre-deploy diagnostics were removed.
- The owner clarified that the replacement key was issued by **OpenAI**, not Groq or OpenRouter. The new PR #9 container was verified with `FALLBACK_PROVIDER=openai`, `FALLBACK_BASE_URL=https://api.openai.com/v1`, `FALLBACK_MODELS=gpt-4.1-mini`, empty `FALLBACK_MODEL`, `GEMINI_ENABLED=false`, and the private key present. The deployed code now honors the disable flag.
- An authenticated OpenAI model-list request returned HTTP 200. One generation request to `gpt-4.1-mini`, limited to eight output tokens, returned **HTTP 429 / `credit_balance_exhausted` in 1,742 ms**. No usable answer or token usage was returned. Authentication is established; usable account credit and successful generation are not. The owner's report of promotional/free credits does not override this observed block. Further generation requests and purchases are paused.
- OpenRouter's `openai/gpt-oss-120b:free` was considered earlier and remains a separate alternative requiring an OpenRouter key and verified allowance. An OpenAI-issued key must not be sent to that route. See [provider setup and allowance checks](FREE_PROVIDER_SETUP.md).
- The **deployed** provider-switch and Jarvis repair adds operator-scoped delivered conversation history and confirmed notes, normal conversational business tools, approval proposals, and a distinct operator-run classification without assigning the operator to a client. Local checks and the Railway build passed; conversational and document acceptance remain pending while provider credit is blocked. See [Jarvis pilot](JARVIS_PILOT.md).
- The complete second-account Aria activation → document answer → authorized `read_document` trace remains pending. Jarvis founder replies and small provider probes do not satisfy that test.
- Work must stay within verified free allowances and **$0 new spending**. The last inspected Railway dashboard showed 28 trial days or $4.90 credit remaining; the connected Supabase organization's Free plan is now verified in the browser. The replacement-key issuer is confirmed as OpenAI; the earlier Groq assumption is superseded. Gemini's account billing tier remains unverified, and the observed OpenAI credit block must be resolved before more generation tests. Token measurements alone are not a spending cap.

See the [plain-language project overview](../README.md) and [full goal acceptance record](GOAL_ACCEPTANCE.md). The dated evidence below is historical, not a claim of current provider availability.

## Historical checkpoint — 8 September 2026

This dated record supersedes the deployment observations from 7 September in `PHASE1_STATUS.md` and `RAILWAY_SETUP.md`. It does not declare the full pilot or account migration complete.

## Deployed repair

- [PR #5](https://github.com/tanadanaitan-prog/neurohands-ai-agent/pull/5) merged as `606f3cf7234e5907b92dda6ce23a2d0d7dde5de5`.
- Railway deployment `8c53429b-1a31-4aa2-bfed-6ded28af0978` succeeded at 14:12 UTC (21:12 Bangkok).
- Public `/version` returned that exact commit; `/ready` returned HTTP 200 with `ready: true`.
- Both local and Railway build checks passed: 93 tests, syntax/menu validation and the Vite build. Simulated tests are not a live LINE proof.
- The repair catches model transport/timeouts, invalid JSON and unusable responses so the configured fallback can be attempted. Tool authorization and database errors retain their existing failure handling. Webhook failure logs now identify safe error categories and elapsed processing time.

## Actual provider diagnostic

One bounded, harmless request per provider ran inside Railway using its private variables. No answer content or keys were printed. The temporary pre-deploy command was removed after reading the results.

| Provider/model | Result | Request time | Reported usage |
| --- | --- | --- | --- |
| Gemini / `gemini-3.6-flash` | HTTP 200, usable response | 1,265 ms | 5 input, 2 visible output, 71 reasoning, 78 total tokens |
| Groq / `openai/gpt-oss-120b` | HTTP 401, authentication rejected | 57 ms | Unavailable |

The Groq key needs replacement in Railway's `FALLBACK_API_KEY`. `FALLBACK_MODELS=openai/gpt-oss-120b` is saved for the next deployment, avoiding the older implicit model list; no extra restart was triggered for this setting. This does not prevent testing the working Gemini primary. Do not copy keys into Git or this report. A healthy provider probe does not establish that a full document/tool conversation succeeds. [Groq's supported model list](https://console.groq.com/docs/models).

The Gemini numbers are a single tiny connectivity test, not a capacity benchmark. At Google's published standard paid rates on this date ($0.75/million input and $3.75/million output including reasoning), the illustrative token charge would be $0.0002775. The account's billing tier and actual invoice were not inspected; a billed amount is not claimed. [Pricing source](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.6-flash).

An earlier one-hour idle Railway sample averaged approximately 0.164 GB of memory and 0.00077 CPU usage as reported by Railway. These are application-host measurements, not the CPU/RAM used by Google's or Groq's models, and not per-customer measurements.

## Pilot evidence still required

One KNC sales document is uploaded and parsed. Aria is active and permitted to list/read documents. At the latest check there were no active customer bindings, Aria runs or successful `read_document` traces. The founder account routes to Jarvis; the customer test uses a second personal LINE account on the same OA.

The user has been asked to activate that account with the private unused activation code, then ask a distinctive question about the uploaded document. Acceptance requires the actual LINE reply plus a completed run/event, authorized successful document tool call, correct client/department scope and matching source content. Keep the private question, answer and detailed evidence outside the public repository.

Per-request model latency/token logs are available in the repair. The follow-up run-metering change records every provider attempt with its run, including retries, discarded answers and failures. Input, output, reasoning, cached input and provider-reported totals remain separate. Observed sums and unknown-attempt counts distinguish partial measurements from complete totals. Jarvis's founder `trace: <run_id>` includes reported tokens and run/model-request time; cost remains unpriced. The stored run timer excludes the initial authorization/run creation and LINE delivery, so it is not an end-to-end customer latency measurement.

Migration `20260908142249_agent_run_model_metrics` added one nullable `agent_runs.llm_metrics` JSONB column before the follow-up code deployment. Post-migration checks confirm the service role can write it, browser roles cannot read it and existing RLS remains enabled. There were zero agent runs before and after the migration; no customer run or document was fabricated. Security advisory results stayed at the same 25 informational notices for intentionally server-only tables with no browser policies.

The final follow-up local suite passed all 101 tests. A first full-suite attempt had a file-level gateway test runner failure without an inner assertion; the gateway standalone run and both subsequent full TAP captures passed. Railway's build provides a separate Linux check. Complete billed cost accounting and realistic load/latency percentiles remain unmeasured. The broader team website, account consolidation and Phase 2 remain unfinished.

## Current access and rollback

Railway's connected profile now confirms the destination email. The GitHub connector still uses the source account and cannot push to the destination repository; PR #5 was published through the authenticated destination GitHub browser session. This mismatch does not mean the destination repository ownership is wrong.

The previously deployed commit is `ea89e258fdbd518060b1ba176f65da005e78f493`, deployment `6b64fccf-52db-4d64-9614-e44b787d833f`. If the repair needs rollback, use a normal revert/deployment rollback while preserving runtime variables and `WEBHOOK_ENCRYPTION_KEY`. Do not automatically replay failed or uncertain LINE events. No database schema or stored document was changed by PR #5.
