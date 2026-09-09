# Provider setup and the $0 test requirement

Updated 9 September 2026. The current replacement route is **direct OpenAI / `gpt-4.1-mini`**. Its private key authenticates, but generation is blocked by account credit. OpenRouter is a separate optional alternative.

## What is working, and what is blocked?

The owner confirmed that the saved replacement key came from OpenAI's platform. Using a key against a different provider's endpoint can produce an authentication rejection; OpenAI, Groq and OpenRouter keys are not interchangeable.

| Check | Observed result | What it establishes |
| --- | --- | --- |
| OpenAI authenticated model list | HTTP 200 | The key authenticates with OpenAI. |
| One `gpt-4.1-mini` request, maximum eight output tokens | HTTP 429, `credit_balance_exhausted`, 1,742 ms | No usable answer; generation is currently blocked by account credit. Usage was not reported. |
| Real Jarvis and Aria conversation with this model | Pending | No successful end-to-end conversation is claimed. |

The owner reported promotional/free credits, but the generation result shows that usable credit is not currently available to this request. Stop further generation tests until the correct account/project has verified usable allowance. Do not buy credits or enable automatic purchases under the current $0 requirement.

`gpt-4.1-mini` supports Chat Completions and function calling. It is a priced API model, not an inherently free model. Existing eligible promotional credits may cover usage only when they are available for the account and request. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

## Verified deployed OpenAI configuration

The following settings and the presence of the private key were verified in the Railway container for the PR #9 runtime release. Store secret values only in Railway Variables or a private local `.env`; do not paste them into chat or this repository.

| Variable | Value |
| --- | --- |
| `GEMINI_ENABLED` | `false` |
| `FALLBACK_PROVIDER` | `openai` |
| `FALLBACK_BASE_URL` | `https://api.openai.com/v1` |
| `FALLBACK_MODELS` | `gpt-4.1-mini` |
| `FALLBACK_MODEL` | Empty |
| `FALLBACK_API_KEY` | The owner's private OpenAI API key |

The `FALLBACK_` variable names are retained for compatibility. With Gemini disabled, this route handles requests directly; it does not wait for a Google failure. The explicit OpenAI base URL is required in this version.

**The Gemini disable flag is now deployed.** PR #9's runtime release `16a0cbe` implements it, and the new container has `GEMINI_ENABLED=false`. The earlier September 9 revision `c57de7e` lacked this behavior. Keep the saved Gemini credential for a future verified configuration. Deployment and non-AI health checks passed; no inference requests were made during release verification, and the account-credit block remains unresolved.

## Deploy code, then verify AI within usable allowance

1. Complete code review and local checks, including tests with `GEMINI_ENABLED=false`. The combined Jarvis repair also requires the operator-run migration **before** the application deployment; follow the [Jarvis deployment order](JARVIS_PILOT.md#deployment-order).
2. Verify that the Railway deployment fits within its existing allowance and $0 new spending. Deploy the reviewed revision with the intended private variables. The AI credit block does not prevent this code-only deployment; do not run inference requests or provider diagnostics as deployment hooks.
3. Check the deployed commit, `/ready` and provider settings. These checks do not require AI generation. Readiness validates configuration and application dependencies; it does not authenticate the model or check its balance.
4. Before any inference request, confirm the key belongs to the intended OpenAI account/project and that existing promotional/free allowance is usable and unexpired. Resolve the reported account-credit issue without purchasing credit. Do not assume a model-list HTTP 200 proves generation credit exists.
5. Only within that verified usable allowance, perform one bounded plain-response test. Record status, model, elapsed time and reported usage. Do not repeatedly retry a credit-balance error.
6. Complete the founder [Jarvis acceptance checks](JARVIS_PILOT.md#live-acceptance) and the separate [second-account Aria document test](../README.md#documents-and-customer-activation).
7. Verify actual LINE delivery, source accuracy, correct client/department, allowed successful tool calls and run traces. Record unknown usage as unknown, not zero.

A tool conversation may require several model requests. Neither a tiny connectivity test nor a token counter establishes the monthly bill, a hard spending limit or supported customer capacity.

## Optional alternative: OpenRouter

If a different verified free route is chosen, OpenRouter's `openai/gpt-oss-120b:free` remains a candidate. It requires an **OpenRouter-issued key**, even though the model name begins with `openai/`. The OpenAI key currently saved in Railway cannot be reused for this route.

| Variable | Alternative value |
| --- | --- |
| `GEMINI_ENABLED` | `false` |
| `FALLBACK_PROVIDER` | `openrouter` |
| `FALLBACK_BASE_URL` | Empty; the server selects OpenRouter's official API |
| `FALLBACK_MODELS` | `openai/gpt-oss-120b:free` |
| `FALLBACK_MODEL` | Empty |
| `FALLBACK_API_KEY` | A separate private OpenRouter key |

Before any test, verify the [model's current availability and tool support](https://openrouter.ai/openai/gpt-oss-120b:free), the account's [current limits](https://openrouter.ai/docs/api_reference/limits), and its usable free allowance. Keep the `:free` suffix; do not silently switch to a paid model when free capacity is unavailable. Selecting an alternative remains separate from proving that it works.

## Failure and recovery

The runtime recognizes explicit account-wide authentication, credit, spend and quota failures. After one such rejection, it stops trying other models on that route and skips that route for later requests in the same process. Another configured route can still run. Ordinary transient errors keep the existing bounded fallback behavior.

From the founder LINE account, send `health` for configuration and recorded account blocks without an AI request. `runs` and `trace: <id>` include safe failure reasons and distinguish actual requests from skipped routes. Existing commands and approvals remain available. No raw provider error body or private key is included.

After correcting an account problem within verified free allowances, redeploy to clear the process pause. It does not survive a restart, coordinate replicas, cancel in-flight requests or enforce a dollar budget. It is not a hard $0 guarantee.

OpenAI provides separate alerts and enforced spend limits; enforcement can lag, so a displayed credit balance or limit is not an instantaneous cutoff. Verify the key's organization, usable grant balance/expiry and applicable controls before more paid-model traffic. Do not buy credits or enable automatic purchases. [Spend controls](https://developers.openai.com/api/docs/guides/spend-limits), [prepaid billing behavior](https://help.openai.com/en/articles/8264644).

The optional [Inkling third-model configuration](PUBLIC_MODEL_TEST.md) is restricted to a separate synthetic harness and never receives private business requests.

- **401/403:** check the provider endpoint, key issuer and permissions. Trying another model does not repair a rejected credential.
- **Credit-balance or quota error:** stop tests and check the account allowance. The observed `credit_balance_exhausted` response is not evidence that a short delay will fix the request. [OpenAI error guidance](https://developers.openai.com/api/docs/guides/error-codes).
- **Rate limit or timeout:** record the failure and inspect its actual cause. Do not label the answer successful or replay a business action that may already have run.
- **Incomplete provider configuration:** repair it before accepting a new deployment. Readiness must reject a configuration with no enabled provider.

Preserve `WEBHOOK_ENCRYPTION_KEY`, LINE credentials, customer bindings and stored documents. A provider-only change does not require re-uploading documents or a schema change; the separate Jarvis operator-history feature does require its reviewed migration.
