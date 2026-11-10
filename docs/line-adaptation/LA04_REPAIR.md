# LA-04 response, ownership and document repair

Later [ordinary final-response correction](FINAL_RESPONSE_VALIDATION_PR23.md)
closes the review's inherited P2 in draft. The counts and application revision
below remain the original LA-04 evidence.

Continue with the [ENG/QA handover](ENG_QA_HANDOVER_PR23.md),
[owner verification](CATALOG_OWNER_VERIFICATION.md) and
[draft LINE test steps](LINE_ACCEPTANCE_PR23.md). Review/adoption remains pending.

Draft for ENG/QA review. Baseline: `7b686696121b1930619183bd4ace5894b1912609`
(PR22). This is an isolated follow-on patch; neither PR21 nor PR22 has been
adopted by this work. No production configuration, migration, model/LINE call or
customer document was used.

## Reproduced behavior and changes

| Area | Before | Draft behavior |
| --- | --- | --- |
| Empty final after a successful tool | No usable final; fallback could continue a tool-enabled model cascade | One same-provider/model, text-only synthesis with prior tool results and no tools. A requested tool, refusal, filtering, malformed or truncated synthesis is not accepted. |
| Runner failure after Checking | No terminal notice | One safe terminal notice, with the original failure retained. Unknown final-send completion is never blindly retried. |
| Checking still in flight | Final/terminal push could precede Checking | Await the already-started bounded Checking request before pushing final/terminal text. This orders local requests; actual device delivery after ambiguous network timeouts is unverified. |
| Legacy prices | Global product/edging queries reachable across account contexts and from public menu | Shared ownership guard for tools/menu: blank owner denies access; only the configured, matching active account may read the whole legacy catalog. |
| Profile | A LINE user's profile from an old account could enter another account's result; missing account could claim found | Filter the LINE profile to the current account; missing, mismatched or explicitly inactive account returns not found. |
| Document extraction | Blank text, invalid UTF-8 CSV and text renamed as XLSX could claim parsed/complete | Reject empty extraction and invalid CSV text; XLSX requires a ZIP signature before parsing. Original/source hash remains recorded. |
| Document read | Parsed labels could make empty summaries readable; partial status could claim complete | Content-presence check, safe source/content field allowlist and conservative completeness. Valid zero/false and legacy headers/sample remain readable. |

These are deterministic synthetic reproductions, not proof that the historical
production incident had these exact causes or exposed actual customer data.

## File and instruction mapping

- `src/lib/post-tool-response.js` and response sections of `src/server.js`:
  empty-envelope detection, safe synthesis validator and serialized delivery.
- `src/lib/catalog-access.js` and tool/menu/profile hooks in `src/server.js`:
  caller/owner checks and scoped profile output. The existing database facade and
  client/department document query remain in use.
- `src/lib/document-parser.js` and the `read_document` hook: extraction and stored
  result truthfulness. Upload size, storage settings and image handling are unchanged.
- `.env.example`: blank `LEGACY_CATALOG_OWNER_CLIENT_ACCOUNT_ID`, documented below.
- Six `test/la04-*.test.js` files: 56 distinct regression/negative checks.
  Existing Aria sourcing fixture now explicitly sets its synthetic catalog owner.
  Existing test assertions and provider/release contracts are not weakened.

The underlying [Supabase API security guide](https://supabase.com/docs/guides/api/securing-your-api)
distinguishes grants and row authorization. The legacy tables have no account
column in the recorded schema: filtering an invented column is not a repair.
See the [official changelog](https://supabase.com/changelog), checked 2026-11-10.
Provider response finish/block fields were checked against the
[Gemini response reference](https://ai.google.dev/api/generate-content?hl=en).
No SDK or API-version upgrade is part of this patch.

## Required owner decision before any catalog adoption

Leave `LEGACY_CATALOG_OWNER_CLIENT_ACCOUNT_ID` blank until the operator verifies
which ONE active client owns every row in the legacy glass/edging tables. This
draft intentionally disables catalog access when ownership is unassigned. Setting
an ID assigns the whole catalog, not individual rows. Do not pick an owner from a
test fixture or reuse this mechanism as per-row multitenancy. Multiple private
catalogs require a separately reviewed schema/data migration and acceptance test.

Public prospects receive an activation message instead of private prices. Missing
owner configuration remains a legitimate service availability gap; safe denial is
not counted as successful completion of an authorized price request.

## Before/after evidence

| Frozen cases | Recorded before | After repair |
| --- | --- | --- |
| Original response cases, 6 | 1 pass / 5 fail | Same six pass; 11 added negative cases also pass (17 total). |
| Catalog cases, 13 | 4 pass / 9 fail | 13 pass. |
| Original profile cases, 2 | 1 pass / 1 fail | Same two pass; three QA account cases also pass (5 total). |
| Document parser/gateway cases, 11 | 4 pass / 7 fail | 11 pass. |
| Separate document access cases, 6 | 3 pass / 3 fail | 6 pass. |
| In-flight Checking interleavings, 4 | 0 pass / 4 fail on the initial repair | 4 pass after bounded LA04-R2. |
| QA missing/mismatched/inactive account cases, 3 | 0 pass / 3 fail after initial profile fix | 3 pass; included in the five profile cases above, not additional. |

Final focused command:

```text
node --test test/la04-response.test.js test/la04-delivery-order.test.js test/la04-data-access.test.js test/la04-profile-access.test.js test/la04-documents.test.js test/la04-document-access.test.js
```

Observed result: **56 passed, 0 failed**. Repeated independent review runs use
these same cases; they are not additional benchmark samples. Full suite/source
and structure results are recorded in the [verification receipt](references/LA04_VERIFICATION.json).

The first full baseline run could not connect to localhost under the sandbox;
the next exposed absent checkout-local dependency paths. After granting test-only
localhost access and linking the existing pinned workspace dependencies, the
unchanged baseline passed **539/539**. No compatibility assertion was relaxed or
package changed. Initial environment failures remain in the task-local evidence.

## Review and iteration history

Three specialists implemented response, data and document units. Each had two
implementation attempts at most; a different specialist reviewed its result.
Independent response QA found the in-flight Checking race despite 17 passing
tests. That unit stopped; the coordinator recorded bounded follow-on LA04-R2,
reproduced four interleavings, fixed the ordering, then obtained independent
21-case response/order recheck. Data QA also found the missing-account success
claim; three reproductions failed before its focused guard and passed afterward.

An initial coordinator document-test fixture returned no audit row and therefore
failed on the fixture, not the document bug. The corrected fixture's actual
three-pass/three-fail baseline is the comparison above; both logs are preserved.

## Resource measurement and remaining limits

Successful empty-post-tool recovery uses exactly three simulated model requests
and one tool execution in the fixture. The additional synthesis is bounded to one
request; it is not free reasoning. No real token, charge, CPU/RAM or model-latency
measurement was obtained, and no efficiency saving is claimed.

PDF/OCR, DOCX images/layout and formula recalculation remain unsupported. XLSX's
signature check is not a complete format or archive-security validation; legacy
XLS can still parse real cell text from differently named source formats. Never
claim all spreadsheet formats or embedded content were validated/read.

Database failures, provider authentication/quota blocks, absent owner configuration
and real LINE delivery can still prevent completion. Source and local tests do
not replace an authorized end-to-end test. The separate 60-case campaign remains
NOT_RUN and 95-99% remains unestablished.

Next: ENG/QA review of the exact draft revision and configuration prerequisite;
then a separately authorized controlled pilot. LA-05/06 feature expansion and
calendar/runtime adoption stay behind their existing dependencies and decisions.
