# Compatibility, quality and efficiency measurement

The [evaluation design](references/evaluation-design.json) defines three measures:

| Measure | Calculation | Current result |
| --- | --- | --- |
| M1 contract compatibility | Passing frozen assertions / all required assertions; report execution coverage too. | NOT_RUN; null percentage. |
| M2 task acceptance/reliability | Independently accepted outcomes / all scheduled runs; report first-attempt/final outcome and environment. | NOT_RUN; null percentage. |
| M3 efficiency | All campaign resources / accepted tasks, compared at equivalent outcomes with a frozen paired baseline. | NOT_MEASURED; no savings claim. |

Use 95% as a proposed pilot fraction and 99% as a release ambition for a declared
eligible scope. Do not claim 99% of all LINE features or a population guarantee.
Efficiency is not another arbitrary percentage: distinguish using 95% of baseline
resources from saving 95%. Missing usage is null, not zero. Include failed work,
retries, research/review overhead and coordination in resource totals.

All privacy, authority, tenant isolation and duplicate-effect cases are hard
gates. Any failure blocks acceptance; unrun critical cases remain unverified.
Do not average them away with successful easy cases. Correct refusal passes only
when the frozen oracle expects refusal; safely blocking a legitimate task remains
noncompletion.

## Discovery and qualification

The tracker proposes 60 unique synthetic cases: 20 contracts, 24 workflow tasks
and 16 critical cases. This is a coverage-first discovery campaign, not a
statistically representative live benchmark. Freeze/refine its oracles against
the actual implementation before running it. Keep missing, blocked, failed and
NOT_RUN cases in the report. Do not repeat favorable cases to inflate a sample.

The design's [NIST exact-binomial reference](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm)
explains the separate confidence calculation. Its illustrative all-success bounds
are arithmetic examples, not measured Neurohands reliability. Qualification needs
representative independent tasks, a stated interval and all failures retained.

## Evidence receipt

The offline scorecard accepts a frozen campaign ID, exact source revision and
environment, plus one result per case: `pass`, `fail`, `blocked` or `not_run`.
Executed outcomes need different producer/reviewer identities and evidence paths
with SHA-256 hashes under the supplied evidence root. It rejects duplicate case
IDs, changed campaign/oracle digests, unregistered/self-review identities,
missing/mismatched evidence and an
enabled native consumer-only capability declaration.

The frozen digest binds campaign cases/oracles, source and contract versions,
registered actors, acceptance targets, feature scope and all four mandatory hard
gates. Sandbox/live labels require
matching declared operator scope and hashed runtime evidence. Work-item acceptance
requires explicit scope, independent registered QA and the bounded attempt count.
These are validation checks on an approved ledger; registry labels are not login
authentication, cryptographic approval or independently observed runtime behavior.

Receipts are declarations backed by files. This helper does not authenticate the
reviewer, independently judge model answers, execute APIs, enforce permissions or
prove the truth of a log. Independent QA inspects the artifact/oracle and run
provenance. Keep a local fixture score distinct from sandbox/live outcomes.

## Compare and improve

For a future comparison, freeze matching tasks, model/provider/settings, hardware,
budgets, cache policy and grading revision; counterbalance run order. Preserve
all attempts. Compare resources only when quality is equivalent or better and
hard gates pass. Report paired deltas, latency distribution and sample count.
The current CLI does not assert a baseline improvement from a single receipt.

For each work item: plan → owner/reviewer assignment → one bounded execution →
actual evidence → independent comparison → separate measurements → one focused
improvement or close/stop. Two implementation attempts and one improvement cycle
are the local limits. Keep historical attempts and source revisions; do not
silently rewrite the baseline or oracle after seeing a result.
