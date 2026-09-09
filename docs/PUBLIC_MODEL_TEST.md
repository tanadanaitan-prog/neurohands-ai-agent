# Third model: Inkling synthetic test

The third configuration uses OpenRouter's `thinkingmachines/inkling-small:free` for a **manual synthetic test only**. It is not an automatic fallback for Jarvis, Aria, customer messages, uploaded documents or stored memories. The owner selected this restricted use on 9 September 2026.

OpenRouter lists zero prompt/completion pricing and tool support for this endpoint. Its notice prohibits confidential/personal inputs and says prompts and outputs are logged for model improvement. Its free capacity is limited. [Model and data-use notice](https://openrouter.ai/thinkingmachines/inkling-small:free).

## Railway variables

Keep the existing Gemini and OpenAI variables. Add these separately to the Neurohands service:

| Variable | Value |
| --- | --- |
| `THIRD_PROVIDER` | `openrouter` |
| `THIRD_API_KEY` | A separate OpenRouter-issued key, entered privately |
| `THIRD_MODEL` | `thinkingmachines/inkling-small:free` |
| `THIRD_BASE_URL` | `https://openrouter.ai/api/v1` |

The three non-secret values were staged on 9 September. No third-key variable was present in the inspected service; its location remains to be confirmed. An OpenAI key cannot substitute for an OpenRouter key. Do not overwrite `FALLBACK_API_KEY` with the third key.

## What the test proves

After the reviewed script is deployed and the correct key is present, run `node scripts/check-public-model.js` in the Railway console. This is a manual action; builds, health checks and deployments do not invoke it.

The harness supplies a fictional order, lets the model request one synthetic tool, and checks an exact total: three units at seven each equals **21**. It makes at most two model requests, each capped at 128 output tokens. The endpoint and free model are fixed; invalid overrides are rejected before sending a request.

The harness reads no business files, database, LINE conversation or stored memory. It accepts no freeform user prompt. The report records verification status, call count, elapsed time and reported token usage; unknown usage remains unknown. A missing key makes no request.

A pass proves only this small tool-and-calculation example. It is not the KNC document proof, a business-data approval, a representative benchmark, or a capacity guarantee. Record the deployed revision and actual report before claiming a live pass. Do not keep retrying exhausted free capacity.
