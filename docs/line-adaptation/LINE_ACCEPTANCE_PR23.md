# PR23 LINE acceptance runbook — DRAFT / NOT RUN

Current tested application reference: `8de7c61f2c22699d9dec0dfe9a64ef2557984f13`; the original handover was prepared at `13d33051...`. **Pending ENG/QA review and approval.** This document authorizes no deployment, LINE message, model/API request, database/configuration change or spending. No such action was performed while preparing it. Historical deployment/provider claims in older docs are not current verification.

## 1. Preflight and approval record

ENG/QA must approve the exact revision, controlled environment, test identities, synthetic client/department, minimal writes, usable existing free allowance, evidence destination, rollback and cleanup owner before execution. Record approver, time with timezone and scope. If approved for live execution later, require `/version` to match the approved deployment commit and record `/ready` using separately authorized checks. The current tested application reference is `8de7c61...`; a later documentation-only deployment head must be recorded separately and its application files shown unchanged. An unreviewed source difference requires revised review.

Verify privately, without copying secrets: founder LINE identity matches `FOUNDER_LINE_ID`; second personal LINE identity is neither founder nor an active admin; approved client is active; intended department has the reviewed customer agent/allowlist; webhook, inbox, schema and Storage prerequisites exist. Review current provider admission/catalog prerequisites with the catalog owner. Configuration/`health`/readiness status is **not** a real model or LINE conversation test. Stop before inference if usable allowance or authorization is unverified; do not reset blocks or rotate settings as a diagnostic.

Use a disposable approved synthetic client where possible. Do not assume KNC is synthetic or expose existing business documents. Reuse an approved test binding/document if it provides the same evidence; otherwise approve one activation-code record, one customer binding and one tiny upload plus their normal audit/inbox/run writes. No new account or schema setup is implied.

## 2. Identities and exact interface

### Connect only the approved test channel after approval

1. ENG deploys the approved commit to the approved test environment and verifies
   its version/readiness and schema/storage prerequisites. Creating an environment
   may cost money: do not create one without a verified $0 option and approval.
2. In LINE Developers Console, select the intended provider, then the **test**
   Messaging API channel, then **Messaging API**. Privately confirm its secret and
   access token match that test server. Never put the values in this packet.
3. Under **Webhook URL**, choose **Edit**, enter
   `https://<approved-test-domain>/webhook`, then **Update → Verify** and require
   **Success**. Turn **Use webhook** on. The placeholder is not a real URL.
4. Check the test OA's response settings so a manual/automatic reply is not
   mistaken for an agent answer. Add that test OA as a friend on both test
   identities and use separate one-to-one chats.

LINE supports only one webhook endpoint per channel. Do not replace production's
webhook to test this draft. If no separate approved setup exists, stop live work
and use offline tests until an operator approves a controlled alternative.
These steps follow the official [setup guide](https://developers.line.biz/en/docs/messaging-api/building-bot/)
and [receiving guide](https://developers.line.biz/en/docs/messaging-api/receiving-messages/),
checked 2026-11-10. Verification Success alone does not prove a model answered.

Use private one-to-one chats with the intended Neurohands bot. **Founder routes to Jarvis before customer activation; the founder account cannot prove Aria acceptance.** The second personal account must activate through the customer route. If it already has multiple bindings, review them first: customer routing uses the most recently activated active binding, not a department-switch command.

The following are literal supported text commands; replace angle-bracket placeholders before sending:

| Account | Commands used in this runbook | Expected result |
| --- | --- | --- |
| Founder | `help`, `health`, `agents`, `runs`, `events`, `trace: <run_id>` | Command list, configuration/recorded blocks, registry, recent runs, failed/uncertain events, recorded trace. No model generation for these commands. |
| Founder | `upload: <CLIENT> sales`, `docs: <CLIENT>`, `doc: <DOC_CODE>` | Explicit scoped portal link, document list, parsed summary. Avoid bare founder `upload`: it selects the first client account. |
| Founder | `code: <CLIENT> sales`, `codes` | One random single-use full private activation code, then hints/usage only. Issuing a code writes immediately; it is not a proposal. |
| Founder | `note: <synthetic text>`, `learn: <synthetic text>`, `market: <synthetic text>`, `pending`, `yes`, `no`, `notes` | Pending operator note; same operator confirms or rejects; confirmed notes only. `yes` targets that operator's latest pending proposal. |
| Customer | `activate <FULL_PRIVATE_NH_CODE>`, `upload` | Sales access activation; then customer-scoped seven-day upload link. The shortened hint is insufficient. |

Do not infer extra commands from natural-language examples. `task:`/`done:` and confirmation of business actions are outside the minimal run: they write business records. Direct LINE file attachments are acknowledged as **not read**; they do not replace portal upload.

## 3. Controlled sequence after approval

1. **Baseline:** founder sends `help`, `health`, `agents`, `pending`. Resolve any pre-existing proposal privately; never send a blind `yes` or reject unrelated work. Record the actual registry mapping; do not assume the name Aria proves `AGT-001` or its permissions.
   Then send `What is 12 + 5? Reply with the number only.` Require `17` and a
   real model-backed operator run. Stop before file/code writes if it fails.
2. **One fixture:** reuse an approved source or create `pr23-qa.csv` containing `reference,note` and a single row with a unique nonsecret marker such as `PR23-QA-<approved-run-tag>,Synthetic acceptance fixture`. Keep original bytes/hash privately. Founder sends `upload: <CLIENT> sales`; open the returned portal only in the approved environment and upload once. Capture document code, parsed status and ownership. Use `docs: <CLIENT>` and `doc: <DOC_CODE>` to inspect it. This small plain CSV avoids large-upload/parser feature tests. A success banner alone is insufficient: verify original object ownership, SHA-256 and readable extracted marker through approved read-only evidence access.
3. **Jarvis real model test:** founder sends natural-language prompt `Read document <DOC_CODE> for <CLIENT> sales and give its exact reference and note; cite the document code.` This is a prompt, not a special command. Require correct source-grounded content and a completed delivered operator run. Then ask `What reference did that document contain?` to test bounded follow-up context. Use `runs` and `trace: <run_id>`; verify scoped successful document-tool evidence, not just a fluent answer.
4. **Optional minimal proposal test:** if explicitly included in approved writes, send one `note: PR23 QA synthetic preference <run-tag>`, then `pending`, then `no`; expect pending then cancelled and no confirmed note. A separate approved `yes`/`notes` case is needed to prove confirmation; keep unrelated pending work absent. The `learn:`/`market:` variants need not each be written for the minimal pilot.
5. **Aria:** reuse an approved second-account sales binding if suitable. Otherwise founder issues `code: <CLIENT> sales` once and shares the full code privately through an authorized human channel. Second personal account sends `activate <FULL_PRIVATE_NH_CODE>`; expect `SALES access activated` (menu update can independently fail). Check binding and single use privately, then send `upload` to verify its scope without uploading again. Send `For this connection check, reply with the single word READY.` and require `READY` from a real model-backed customer run. Ask the same distinctive document question. Require the actual correct LINE answer, intended customer agent, matching client/department and authorized successful `read_document` trace. Founder may inspect evidence with `runs`/`trace:`; founder conversation is not the customer run.

   Do not use an ungrounded arithmetic answer as Aria's smoke-test oracle: the
   current customer guard replaces digit-containing answers when no tool has
   succeeded (`src/server.js:1033-1036` at the tested application commit). This
   differs from Jarvis. Keep numeric customer acceptance tied to a successful
   authorized source/tool. Check actual model-attempt evidence; a canned reply
   alone cannot establish inference.

6. **Catalog, only after verified owner configuration:** the activated owner
   account asks about one known authorized product/service; compare the answer
   with the privately verified source, not another model. From an unactivated
   account, the products menu must not disclose rates. A genuine wrong-client
   live test needs another approved nonstaff identity/context; founder access
   is privileged and cannot stand in for that negative test. If it is unavailable,
   record NOT_RUN and retain the offline isolation evidence. Blank ownership
   should deny access, but that is not a successful legitimate price lookup.

## 4. Negative cases and deterministic failures

Record separately what was inspected, simulated and actually executed. Cover unactivated/revoked users, wrong client, unbound department, inactive client, missing `read_document` permission, non-operator Jarvis access, another operator's private history/notes, same-owner proposal approval, and no duplicate execution after repeated confirmation. Reuse isolated fixtures for cases requiring role/binding/allowlist changes; do not mutate live records or create extra identities without specific approval. Customer prompts cannot reliably exercise an unbound-department API case. A group-chat rejection is source/test covered; do not add real group participants merely to demonstrate it.

Keep empty-post-tool synthesis, blocked/empty output, persistence/provider failure, uncertain final delivery and delayed/in-flight `Checking...` interleavings **offline and deterministic**. Do not induce live delays, outages, revoked permissions or empty model answers. Expected invariants: bounded text-only synthesis without repeating tools/writes; Checking request settles before final/terminal push; terminal failure remains failure; no blind second final send. Actual device delivery after ambiguous timeouts remains unproved by local request ordering.

## 5. Evidence, stop and cleanup

For each case record revision/environment, approver, timestamp/timezone, pseudonymous role, exact sanitized prompt, expected/actual result, webhook event/run IDs, actual LINE delivery and latency. Privately correlate `agent_runs` classification/status/input/output/iterations/`llm_metrics`, `messages` direction/status/answered_by, inbox status, tool name/allowed/status and scoped output. Jarvis requires `run_kind=operator`, null client/agent, operations department and `delivered_at`; customer proof requires matching client/department/intended agent and readable document evidence. Preserve measured provider/model/attempts/token/timing fields when available; missing usage stays unknown. A sent error or completed webhook is not successful AI acceptance.

Stop on scope mismatch, private-data leakage, provider block, incorrect/empty answer, missing evidence or uncertain delivery. Inspect `pending`, `events` and trace before retries. No replay of uncertain actions. Retain private evidence; keep raw codes, links/tokens, LINE IDs and private content out of public handover. Cleanup needs an approved owner/process for synthetic Storage/document records, test binding/code and any note/proposal. There is no inspected LINE cleanup command; do not improvise SQL, erase audit history or claim automatic expiry removed the data.

Source anchors: `src/server.js:492-557,1134-1278,1325-1359,1365-1415,1425-1568,2060-2075`; `src/lib/jarvis-tools.js:1-13,82-169`; `test/jarvis-runtime.test.js:140-273,445-531`; `test/pilot-proof.test.js:151-241,320-374`; `docs/JARVIS_PILOT.md:49-73`; `docs/line-adaptation/LA04_REPAIR.md:12-18,102-116`. Commands above were checked against source; no live result is asserted.


Continue with [ENG/QA handover](ENG_QA_HANDOVER_PR23.md) and [catalog owner verification](CATALOG_OWNER_VERIFICATION.md).
