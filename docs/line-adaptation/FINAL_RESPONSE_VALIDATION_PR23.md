# PR23 ordinary final-response validation — draft correction

Application commit: `8de7c61f2c22699d9dec0dfe9a64ef2557984f13`.
Baseline: `857a9d546f8fa9a845999228d80dbdcdfef4ff4b`.
The inherited P2 found by the read-only review is corrected locally in this
draft. This technical result supplies no formal ENG/QA approval, main merge,
deployment or permission to test LINE/model services.

## Smallest source change

The ordinary final-return expressions in `askGeminiWithTools` and
`runOpenAIToolLoop` now use the existing `postToolText(provider, data)` validator.
Exactly two production expressions changed. The helper, request construction,
admission, model selection, tool execution and empty-final synthesis are unchanged.

Explicit blocked/truncated finish state, refusals and malformed safety metadata
are not returned as accepted ordinary final text. Gemini thought-only content
returns null; mixed thought/public output returns only public text. Valid
STOP/stop answers remain intact. The existing wrapper failover before any tool
execution remains unchanged; after a completed tool the existing no-restart
boundary applies. Rejecting an ordinary final does not add a helper request,
synthesis or replay of an earlier write.

Legacy responses missing finish metadata remain accepted for compatibility.
That is not evidence of provider-certified completion or answer quality. This
correction covers ordinary final text, not a new moderation policy for every
possible tool-call envelope or a guarantee of live model behavior.

## Reproduction, comparison and review

| Check | Actual result |
| --- | --- |
| Frozen 28 cases before repair | 10 passed, 18 failed, exit 1. |
| Same 28 cases after repair | 28 passed, 0 failed, exit 0. |
| Relevant provider/Jarvis/admission/order regressions | 116 passed, 0 failed, exit 0. |
| Independent focused replay | Same 116 passed, exit 0; not another 116 unique cases. |
| Independent probes and controls | 13 scenarios passed, exit 0; separate from suite count. |
| Full application suite | 623 passed, 0 failed/skipped, exit 0. Prior suite contained 595 cases. |
| Source/contract check | `npm run check` exit 0; release remains unaccepted. |
| Whitespace/syntax | Exit 0. Initial CR-line-ending failure and correction retained in evidence. |

Baseline failures cover 16 unsafe-final and two thought-content cases. Ten
valid/bounded-recovery controls already passed. Nonempty post-tool rejection
fixtures retained two mocked requests and one completed write, even with two
fallback models configured. No live request or token/cost measurement was made.
One implementation attempt was used, plus formatting-only cleanup; independent
QA found no unresolved defect in this bounded unit.

Replay the frozen cases with:

```text
node --test test/pr23-final-validation.test.js
```

Full results, hashes and private raw-log references are in the
[verification receipt](references/FINAL_RESPONSE_VALIDATION_VERIFICATION.json).
The earlier [read-only review](review/PR23_READONLY_REVIEW_20261110.md) remains
preserved as pre-fix evidence, not a claim that the correction is still absent.

## Primary contract references

The [official OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
distinguishes stop, token-limit and content-filter finish reasons and describes
the refusal field. Google's [official SDK finish-reason reference](https://googleapis.github.io/js-genai/release_docs/enums/types.FinishReason.html)
distinguishes STOP, MAX_TOKENS and SAFETY. Retrieved 2026-11-10. The direct Google
API URL redirected to an inaccessible page in the browsing tool, so this checked
official SDK reference supplied the enum definitions. No SDK/API upgrade occurred.

## Next owner and unchanged holds

ENG/QA review this exact candidate and its predecessor/runtime/schema needs.
Catalog provenance and its numeric owner ID remain unverified; leave ownership
unassigned until the authorized owner confirms it. Separately approve the test
OA/environment, free allowance/$0 budget, identities, bounded requests, permitted
synthetic writes and cleanup before executing the [LINE plan](LINE_ACCEPTANCE_PR23.md).
No database, configuration, LINE, provider account or production change occurred.
The separate 60-case campaign and 95-99% goal remain unestablished.
