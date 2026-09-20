# Neurohands connection matrix

Production connection evidence was observed on 16 September 2026. The storage
plan and staged-upload notes were updated on 17 September 2026. The local
Ollama boundary was rechecked on 18 September 2026. A connection
means the named boundary has current evidence; it does not automatically give
every agent permission to use that service.

| Boundary | Current evidence | Status | Agent access |
| --- | --- | --- | --- |
| GitHub -> Railway | Production reports commit `a315fdd0cad03a5339abb87440c83061fc401dbe`; Railway deployment `8cbb1ef5-6b15-4d79-87e3-98c239f42bd5` succeeded | Connected | Deploy pipeline only |
| LINE -> Railway | Signed webhook requests reach the service and completed handlers have been observed | Connected | Production Concierge, Aria and Jarvis routing only |
| Railway -> Gemini -> LINE | Six post-repair runs returned usable Gemini HTTP 200 responses and completed their LINE webhook handlers | Connected; answer quality not yet accepted | Production agent runtime only |
| Railway -> Supabase | `/ready` passes with required runtime configuration; the connected project is healthy and its private `neurohands-docs` bucket was inspected | Connected | Server-side scoped business tools; service credentials never enter prompts |
| LangSmith Studio -> local LangGraph | `http://127.0.0.1:2024/info` and `/ok` return HTTP 200 | Connected while this laptop and Studio are running | Local synthetic lab only |
| Local LangGraph -> Ollama | Ollama `0.34.2` responds on `127.0.0.1:11434`; `qwen3.5:4b` returned the correct fixed arithmetic answer and completed one permitted fictional Aria order-tool loop | Connected while this laptop is running | Local synthetic lab only; Llama checking and embeddings are not yet connected |
| Local lab -> LangSmith trace storage | One fixed synthetic Aria trace was uploaded and read back successfully | Connected for explicit synthetic traces | Ordinary chats and bulk benchmarks remain untraced |
| Local named teams -> production LINE | No authenticated bridge or production deployment exists | Not connected | Must pass local permission, duplicate-action and workflow tests first |
| Ollama -> production fallback | Railway cannot reach the laptop's loopback address | Not connected | Gemini currently carries production requests |

The production and local lab environments are intentionally separate. A Codex
connector, a dashboard login or an API key being present does not equip an
agent. Each usable connector also needs a fixed agent identity, client and
department scope, an allowlisted operation, idempotency, timeouts, safe errors
and an audit record.

## Storage limit relevant to uploads

The deployed portal and live private bucket still limit a file to 10 MiB.
Supabase confirms that the connected organization is on Free, which permits at
most 50 MB per file and includes 1 GB total file storage. A feature-gated TUS
implementation is staged on the development branch for an exact 50,000,000-byte
ceiling; it is designed to send 6 MiB chunks from the browser directly to
Storage and keep file bytes out of Railway. Local mocked-Storage tests exercise
that behavior, but no live transfer has proved it. The feature remains disabled
until the bucket, quota and cleanup controls are ready and controlled acceptance
passes. The required configuration, verification limits and extraction
boundary are documented in the
[large-file upload architecture](LARGE_UPLOAD_ARCHITECTURE.md).

Evidence details and limitations are recorded in
`artifacts/benchmarks/2026-09-16-line-connectivity.json`.
