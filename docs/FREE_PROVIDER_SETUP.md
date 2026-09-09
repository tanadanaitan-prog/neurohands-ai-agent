# Free provider pilot setup

Prepared 9 September 2026. The replacement is not accepted until its private key, live answer and Aria document trace pass. Do not treat this page as proof of a working connection.

## Why change the provider?

The saved Groq credential returned HTTP 401 both in a small generation probe and in an authentication-only check after a fresh Railway restart. Changing the model behind that rejected key cannot fix authentication.

The selected replacement is **OpenRouter / `openai/gpt-oss-120b:free`**. Its [official model page](https://openrouter.ai/openai/gpt-oss-120b:free) lists free prompt/completion tokens and tool calling. This is the same model family through another provider. Actual speed, Thai answers and document accuracy still need a live test.

## Private key: the owner's step

1. Sign in to [OpenRouter API Keys](https://openrouter.ai/keys) with the intended owner account and use its free allowance. Do not buy credits or select a paid model.
2. Create an API key and copy it directly into Railway → **Neurohands AI Agent** → **neurohands-ai-agent** → **Variables** → `FALLBACK_API_KEY`.
3. Save the value privately and tell the technical lead it is saved. Do not paste the key into chat, GitHub, a screenshot or this document. Deployment follows the code checks below.

## Prepared configuration

| Variable | Value |
| --- | --- |
| `GEMINI_ENABLED` | `false` |
| `FALLBACK_PROVIDER` | `openrouter` |
| `FALLBACK_MODELS` | `openai/gpt-oss-120b:free` |
| `FALLBACK_MODEL` | Empty |
| `FALLBACK_BASE_URL` | Empty; the server selects OpenRouter's official API |
| `FALLBACK_API_KEY` | The owner's private OpenRouter key |

Keep the `:free` suffix exactly. Do not reuse the Groq key for OpenRouter. Keep the saved Gemini key: `GEMINI_ENABLED=false` disables its runtime and diagnostic requests without deleting that credential. When the flag is absent, existing Gemini-first behavior remains. The new flag requires the matching code revision and a service restart.

## Verification and deployment

1. Run syntax/menu checks, the build and automated tests, including tests with `GEMINI_ENABLED=false`.
2. Review the change and confirm that the enabled provider has a private key. Readiness must fail if every provider is disabled or unconfigured.
3. Deploy the reviewed revision with the saved variables. Verify the deployed commit, `/ready` and configuration. These checks do not authenticate the provider.
4. Check the private key against OpenRouter's authenticated `GET /api/v1/key` endpoint. Record only safe allowance fields and status, never the key or raw account details. Resolve account/rate-limit issues without buying credits.
5. Within the verified allowance, make one bounded plain-response test and then the real second-account Aria document test described in the [README](../README.md#documents-and-customer-activation).
6. Compare the actual answer with its source and verify the client/department, allowed successful `read_document`, completed run and LINE delivery. Record reported tokens, elapsed time and any unknown usage.

OpenRouter's [Free plan](https://openrouter.ai/pricing) advertises limited daily requests. A tool conversation can need several model requests, so the request allowance is not a customer-conversation allowance. Capacity, model availability and account limits can change; verify [current limits](https://openrouter.ai/docs/api_reference/limits). Do not silently switch to the unsuffixed paid model when free capacity is exhausted.

## Failure and recovery

- **401/403:** investigate the correct provider, saved key and account permissions. Do not keep trying other models with the same rejected credential.
- **402/429:** inspect the account's allowance and reset information. Wait or use another explicitly verified free option; do not add credits automatically.
- **Timeout or unavailable model:** record the failed attempt. Do not label the answer successful or replay a business action that already ran.
- **No enabled provider:** keep the last healthy deployment while repairing configuration. The readiness check should reject the incomplete replacement.

Re-enable Gemini only after its allowance and operation are verified, by setting `GEMINI_ENABLED=true` and restarting. Preserve `WEBHOOK_ENCRYPTION_KEY`, LINE credentials, customer bindings and document storage. The provider change does not require a database migration or re-uploading customer documents.
