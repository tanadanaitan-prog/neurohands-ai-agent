# PR23 ENG/QA handover — DRAFT

**Latest draft correction:** [ordinary final-response validation](FINAL_RESPONSE_VALIDATION_PR23.md)
locally closes the inherited P2, with 623 full-suite tests passing. The earlier
[read-only review and catalog counts](review/PR23_READONLY_REVIEW_20261110.md)
remain historical evidence. Catalog ownership and formal approval are unverified.

Review [PR23](https://github.com/tanadanaitan-prog/neurohands-ai-agent/pull/23).
Tested application commit: `8de7c61f2c22699d9dec0dfe9a64ef2557984f13`.
Base: PR22 / `7b686696121b1930619183bd4ace5894b1912609`. This stacked PR is
not a standalone approved change to main. Review its unadopted base and database
prerequisites too. No merge, configuration, deployment, live test or spending is
authorized by this packet. No message was sent to ENG/QA or Grok.

## Read in this order

1. [Repair and comparison](LA04_REPAIR.md) and [verification receipt](references/LA04_VERIFICATION.json): exact reproductions, source, results, hashes and limitations.
2. [Catalog owner verification](CATALOG_OWNER_VERIFICATION.md) and optional [read-only SQL](review/CATALOG_OWNER_READ_ONLY.sql): establish ownership without guessing or changing data.
3. [LINE acceptance plan](LINE_ACCEPTANCE_PR23.md): separate founder/Jarvis and customer/Aria steps, outcomes, evidence and cleanup.
4. Copy the [blank decision record](review/PR23_SIGNOFF.template.json) to a private approved location. All decisions remain pending.

At preparation PR23 was open/draft, its CI passed and GitHub contained no reviews.
Refresh the exact head/review state before any decision. Local specialist review
is evidence, not formal ENG/QA approval. Documentation-only additions retain the
application evidence above; they do not mean application tests were rerun.

## ENG checklist

- Response functions and `src/lib/post-tool-response.js`: one same-provider/model
  answer-only synthesis; no completed-tool replay; blocked/truncated, malformed or
  tool-calling recovery is not accepted; unknown final sends are not retried.
- Checking request: final/terminal push waits for the existing 10-second-bounded
  reply to settle. Local ordering does not guarantee device display order after
  an ambiguous timeout.
- `src/lib/catalog-access.js` and tool/menu hooks: blank owner denies prices;
  exact configured active owner is required. This protects one legacy catalog,
  not per-row client catalogs. Check trusted upstream bindings/allowlists and
  newest eligible menu binding.
- Profile/document hooks: exclude foreign client profiles; missing, mismatched or
  explicitly inactive account cannot report found. Preserve the account/department
  document predicate.
- Parser/result helper: no empty readable summary or complete claim on partial
  status; zero/false and legacy content retained; source/content allowlisted.
  PDF/OCR, DOCX images/layout and recalculation remain unsupported. ZIP signature
  checking is not complete archive/format validation.
- Verify environment and schema prerequisites independently. PR23 changes no
  package, migration or cloud setting. Never blanket-apply pending migrations.

## QA replay

Use an isolated checkout, Node 24 and locked dependencies, without a production
`.env`. Follow the reviewed repository setup (`npm ci --ignore-scripts` avoids
lifecycle scripts). Localhost test servers must work and compatibility checks
need checkout-local `node_modules`. Capture actual revision, command, exit,
pass/fail/skipped counts and raw log hash.

```text
git status --short
git rev-parse HEAD
node --version
node --test test/pr23-final-validation.test.js test/la04-response.test.js test/la04-delivery-order.test.js test/la04-data-access.test.js test/la04-profile-access.test.js test/la04-documents.test.js test/la04-document-access.test.js
npm test
npm run check
python -B -m unittest discover -s scripts/tests -p test_line_adaptation.py -v
python -B scripts/check_project_structure.py --output outputs/pr23-review-structure.json
```

Recorded at the tested application revision: **623/623 full**, including all
**84 new LA-04/final-validation cases**, and source check exit 0. The unchanged
planning guards previously passed 17/17; original baseline was 539/539. Refresh
structure/link checks and CI after documentation updates; runtime/test/config
changes need new relevant verification. Source checking permits inspection of an
incomplete release register; it does not set `releaseAccepted=true`.

Correct unauthorized refusal passes. A blocked legitimate price request remains
noncompletion. Preserve failures and unknown usage. The separate 60-case campaign
and 95-99% reliability/efficiency goal are unestablished.

## Decisions and next actions

1. ENG/QA record reviewers, exact PR head/application commit, evidence, conditions
   and decision. Keep the PR draft while pending. CI or this packet cannot approve it.
2. Operator/business owner complete catalog provenance privately; mixed/unknown
   ownership keeps the variable blank. Verify predecessor schema/runtime needs,
   provider allowance and test identities.
3. Obtain separate approval for a controlled environment, exact build, test OA,
   permitted writes/model requests, $0 allowance, rollback and cleanup. Prefer a
   separate test OA/environment. One webhook endpoint per LINE channel means
   replacing production's endpoint diverts production traffic; do not do so as
   a test shortcut. A free environment/allowance is not assumed available.
4. Execute the LINE plan within that scope, collect delivered answers and persisted
   evidence, then seek acceptance. No production rollout follows automatically.

LINE documents HTTPS, Verify/Use webhook and the one-endpoint rule in its
[setup guide](https://developers.line.biz/en/docs/messaging-api/building-bot/).
Its [receiving guide](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
requires signature verification. Checked 2026-11-10; no webhook was changed.
