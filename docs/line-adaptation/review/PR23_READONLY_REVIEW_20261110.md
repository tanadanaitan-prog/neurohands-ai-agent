# PR23 technical review and read-only catalog checks — DRAFT

Reviewed source head: `27f09acd4533d09709e57b0126af502191aab737`.
Tested application reference: `13d33051bd6d7f72e9a204097f72b1588734d542`.
PR23 was open, unmerged and draft; GitHub had no formal reviews. The isolation
workflow for that head passed. This technical review does not provide ENG/QA
approval, adopt code or approve live testing.

## Review finding: P2, inherited ordinary-final validation gap

No new defect was confirmed in this bounded PR-diff review, but four synthetic
cases reproduced an existing terminal-output problem. Ordinary nonempty post-tool
Gemini responses marked `SAFETY`/`MAX_TOKENS` and OpenAI-compatible responses
marked `content_filter`/`length` are returned without the stricter validation used
for PR23's additional synthesis. Locations at the reviewed application commit:
`src/server.js:887-904` and `src/server.js:963`. The new synthesis validator in
`src/lib/post-tool-response.js` does reject those recovery outputs.

The same direct-return paths exist in PR23's base `7b686696...`; this is an
inherited P2, not a demonstrated PR23 regression or actual customer exposure.
Each reproduction used two mocked requests and one tool, with no network call.
Recommend a separately bounded correction that validates ordinary final replies
without replaying completed tools. No source repair was performed in this review.
ENG/QA must record the disposition before treating LINE results as acceptance;
the recommendation is to fix it before that acceptance. Any limited smoke-only
exception needs an explicit reviewed scope; this packet grants no exception.

Independent response/recovery/Jarvis/admission/order rerun: **88/88 passed**, exit
0. This does not erase the counterprobe finding. Two last-loop recovery scenarios
also stopped at six mocked requests/four tools with no synthesis tool execution;
those fixture counts are not a universal request/cost bound or measured savings.

The independent data/document review found no new P0/P1/P2 within its scope. Its
two offline probes confirmed documented multi-binding denial and content/source
filtering. Trusted upstream bindings, bounded catalog search, partial extraction
and unsupported formats remain prerequisites/limits. These two probes are not a
new live benchmark. The full 595/595 suite result remains historical evidence at
the unchanged application commit; it was not rerun in full this turn.

## Live read-only catalog observations

Project: `darxiaearohhnxiwhcbs` / Neurohands - AI Agent, reported ACTIVE_HEALTHY.
Schema observation: **2026-11-10 15:12:07 UTC**. Aggregate observation:
**2026-11-10 15:12:44 UTC**. Each SQL call explicitly used a read-only,
repeatable-read transaction ending in rollback; `transaction_read_only=on`
was returned. Reader privileges confirmed full SELECT visibility and RLS bypass
for the checked tables; no roles, grants or policies were changed.

| Table | Total | Active | Inactive | Null active |
| --- | ---: | ---: | ---: | ---: |
| glass_types | 57 | 57 | 0 | 0 |
| edging_services | 14 | 14 | 0 | 0 |
| client_accounts | 1 | 1 | 0 | 0 |

The live catalog column lists contain no tenant/owner/account field and match
the relevant legacy-schema assumption. The active flag is present; all three
tables have RLS enabled. Catalog values, rates, company names, account IDs,
customer rows and credentials were not selected. Counts are dated observations,
not a freeze on future edits.

**Owner remains unverified.** One active account and 71 active catalog entries do
not establish a business relationship between them. No candidate account ID was
chosen or checked. Only the operator/business owner can reconcile the full price
lists/import provenance and confirm which business owns every row. Do not infer
the ID from a seed, test fixture or the fact there is only one visible account.

## Confirmations needed before a LINE test

1. **ENG/QA disposition:** review this P2, the exact draft head and its unadopted
   base/runtime/schema prerequisites. Close the finding or explicitly define a
   limited permitted test; formal decisions remain pending.
2. **Catalog provenance and configuration:** confirm the business and exact
   `public.client_accounts.id`, covering all 57 glass and 14 edging rows plus any
   changes since observation. Approve the single-owner configuration separately.
   Mixed/unknown provenance keeps the variable blank. Prices can be omitted from
   a separately approved non-catalog smoke test, but that would not accept catalog
   functionality.
3. **Test environment/channel and identities:** name the approved environment,
   exact deployment commit, test OA, founder/Jarvis identity and separate nonstaff
   customer/Aria identity, synthetic client and department. Do not divert the
   production webhook. A new test environment may have costs; none was created.
4. **Allowance and actions:** confirm currently usable existing free allowance,
   $0 spending boundary, bounded AI turns/model requests, and permitted writes
   (if needed: one code/binding, one tiny synthetic CSV and normal audit records).
   Confirm private evidence, rollback and cleanup owners. One AI turn can use
   multiple model calls; the `health` command does not prove allowance/inference.

Use the [catalog owner procedure](../CATALOG_OWNER_VERIFICATION.md),
[LINE acceptance plan](../LINE_ACCEPTANCE_PR23.md) and
[private sign-off template](PR23_SIGNOFF.template.json). All decision/approval
fields remain unfilled. No model call, LINE send, database write, environment
change, merge, deployment or approval was performed by this review.
