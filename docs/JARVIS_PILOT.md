# Jarvis conversational pilot

**Status: deployed and health checked; live AI acceptance remains blocked by account credit.** [PR #9](https://github.com/tanadanaitan-prog/neurohands-ai-agent/pull/9) released this Jarvis runtime as `16a0cbe` on 9 September 2026. Railway deployment `1b371129-a52e-4072-8b35-9119ff430006` succeeded; `/version` matched the release commit and `/ready` returned `ready: true`. See [provider status](FREE_PROVIDER_SETUP.md). The examples below are still pending live tests.

Both local verification and the Railway build passed **157 tests**, with syntax/menu validation and the build passing. Tests use simulated providers and isolated databases. Release checks made no inference requests; the actual LINE conversations below still require usable credit and live acceptance.

## What changes for the owner?

The earlier Jarvis interface handled specific commands and answered general messages using a business digest. This repair lets a normal conversation request approved business lookups, refer to a short recent conversation, and propose notes or actions for confirmation.

| Capability in the repair | Example | How it helps |
| --- | --- | --- |
| Find active clients and inspect business information | “Show me the recent orders for KNC sales.” | Uses business tools instead of relying only on a prebuilt digest. |
| List and read uploaded documents | “List KNC sales documents, then read the document I select.” | Retrieves the chosen client's document and keeps a tool record that can be checked. |
| Follow a recent conversation | “Explain the second point from your last answer.” | Uses bounded history from this operator's delivered conversations. |
| Propose a durable operator note | “Please remember that I prefer short Thai summaries.” | Creates a proposal; the note becomes confirmed only after the operator sends `yes`. |
| Propose an approved client action | “Create a follow-up task for KNC sales.” | Shows a scoped proposal before creating a task or other supported business record. |
| Inspect results and failures | `runs`, then `trace: <run_id>` | Shows recorded tools, outcomes and available model usage. |

Jarvis remains the founder/staff interface. Aria remains the activated customer's agent. A founder conversation does not activate or prove the separate customer route. Operator runs are classified separately and are not assigned to KNC or another arbitrary client.

## Memory is finite

- **Recent history:** at most four completed operator conversation turns with recorded delivery. Each turn contains a user message and an assistant answer, each limited to 1,500 characters in the next request. Failed, undelivered or wrongly scoped runs are excluded.
- **Confirmed notes:** at most ten recent confirmed notes proposed by this operator. Up to the first 1,000 characters of each note are included in context. Pending/rejected notes and confirmed action proposals are excluded.
- **Business data:** documents, orders and tasks remain in the database. A historical answer is not proof that the underlying data is still current; Jarvis should use tools for current information.

This is application-managed context, not retraining the AI model or unlimited recall. A note can remain stored even when it is outside the ten-note context window. Operator context must not include another operator's private conversation or notes.

## Approvals and commands

Natural-language actions produce a proposal. Read its company, department and details before confirming. If a request fails while saving a proposal, send `pending` to check its state before trying again.

| Command | Purpose |
| --- | --- |
| `help` | List supported commands. |
| `health` | Show AI configuration and account blocks recorded in this process, without calling a model. |
| `brief` | Show the current operations digest. |
| `upload: KNC sales` | Create a secure portal link for that client and department. |
| `docs: KNC` / `doc: <document-code>` | List or inspect uploaded documents. |
| `note: <fact>` / `learn: <fact>` / `market: <fact>` | Propose a note in the general, learning or market category. |
| `pending` | Show the latest pending proposal belonging to this operator. |
| `yes` / `no` | Confirm or reject that pending proposal. |
| `notes` | Show this operator's recent confirmed notes. |
| `runs` / `trace: <run_id>` | Inspect recorded execution and available usage. |
| `events` | Inspect failed or interrupted incoming events. |

Supported conversational business changes are proposals for a follow-up task, support case, human-escalation record or customer fact. Saving an escalation record does not prove that a human received a notification. Recording a task does not mean a scheduler will execute it.

This pilot has **no Internet search, browser, code execution, autonomous scheduling or agent-delegation tool**. It does not build websites or coordinate departments. Those remain later workforce capabilities. Direct LINE file attachments are not parsed; use the upload portal.

## Deployment order

1. Complete review and local verification of the runtime, tools, context and database migration. Keep the existing deployment and recovery evidence available.
2. Apply the reviewed [`jarvis_operator_runs` migration](../supabase/migrations/20260909155146_jarvis_operator_runs.sql) before deploying the new server. It adds explicit operator classification and delivery evidence while preserving client-run account requirements. Check existing data and access restrictions afterward.
3. Verify that the Railway deployment fits within its existing allowance and the **$0 new spending** requirement. A code-only deployment can proceed within that allowance while AI account credit remains blocked; do not run model requests as deployment diagnostics.
4. Deploy the reviewed source with its matching variables. `GEMINI_ENABLED=false` requires this updated code. Preserve private credentials and `WEBHOOK_ENCRYPTION_KEY`.
5. Verify `/version` against the intended commit and check `/ready`. These checks do not require AI generation. Do not send inference requests or start the live acceptance below until the provider has verified usable existing promotional/free credit and the `credit_balance_exhausted` block is resolved. A successful deployment or healthcheck is not a successful conversation.

The older server can be restored through a reviewed source/deployment rollback while the additive migration remains in place. Preserve recorded operator runs; do not delete history or automatically replay uncertain actions during recovery.

## Live acceptance

Run these only after deployment and usable allowance have been verified. Keep private document content and detailed evidence out of the public repository.

1. **Conversational document lookup:** from the founder LINE account, ask for KNC sales documents, choose one and ask a distinctive question about its content. Compare the answer with the original. Check the run's client-scoped, allowed and successful document tool record.
2. **Follow-up context:** ask a follow-up that refers to that conversation without restating everything. Verify that it uses the correct document and previous exchange. Confirm that only completed, delivered turns enter the next request's history.
3. **Note approval:** send `note: I prefer short summaries in Thai.` Check that it is pending, send `yes`, then `notes`. In a later conversation, ask which summary format was saved. Confirm the note belongs to this operator and appears only after approval.
4. **Trace and delivery:** use `runs` and `trace: <run_id>`. Verify the operator classification, actual LINE reply, outgoing record, delivery marker, tool outcomes and available token/timing measurements. Missing usage remains unknown.
5. **Failure boundaries:** verify through controlled tests that revoked/non-operator identities cannot invoke Jarvis, another operator's context is excluded, business actions do not execute before approval, and failed or uncertain work is not silently replayed. Record which checks were simulated and which were actually run live.
6. **Separate Aria acceptance:** use the second personal LINE account, activate it with the full private code, and complete the customer document question with a correct answer and authorized trace. The founder tests do not replace this step.

Only after the evidence is recorded should these capabilities be described as live and accepted. Report observed response time, usage, failures and remaining limits rather than estimating capacity from a single short probe.
