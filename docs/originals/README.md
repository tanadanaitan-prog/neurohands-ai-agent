# Neurohands — AI Agent Platform (v3.10)

LINE-based multi-agent platform for businesses: customer-facing agents with verified tools, a secure document portal, per-client isolated data, and a founder operator console (Jarvis) with a full evidence chain.

## What this is (agent, not bot)
- **Aria (AGT-001)** — customer-facing business agent (sales / data / planning / operations). Understands objectives, plans, calls only permitted tools, answers from live data only.
- **Jarvis** — founder operator console: digests, runs, traces, activation codes, upload links, gated tool execution.
- **Concierge** — brand voice for prospects (never exposes private data).
- **Document Portal** — signed 7-day upload links; Excel / Word / CSV parsed server-side; files stored per client in private Supabase Storage.
- **Evidence chain** — every run in `agent_runs`, every tool call in `tool_calls`; `trace:` shows input → tools → output.

## Architecture
LINE webhook → Railway (Node.js/Express `server.js`) → Supabase (Postgres + pgvector + Storage)
LLM cascade: Gemini (primary) → fallback provider (Groq / OpenRouter / Mistral / Cerebras; comma-separated model list tried in order)

## Repository
| File | Purpose |
|---|---|
| `server.js` | Entire platform: webhook, agent runtime, tools, Jarvis, portal, cron, API |
| `package.json` | Dependencies: express, xlsx, mammoth |
| `richmenu-public.json` / `richmenu-active.json` | LINE rich menus (prospect / activated client) |
| `scripts/setup-richmenu.js` | Uploads menu images + links menus (run once per redesign) |

## Environment variables (Railway)
| Name | Value |
|---|---|
| LINE_CHANNEL_SECRET | LINE Developers → Basic settings |
| LINE_CHANNEL_ACCESS_TOKEN | LINE Developers → Messaging API |
| SUPABASE_URL | Supabase → Settings → API → Project URL |
| SUPABASE_SERVICE_KEY | Supabase → Settings → API → service_role key |
| GEMINI_API_KEY | aistudio.google.com |
| GEMINI_MODEL | e.g. gemini-2.5-flash |
| FOUNDER_LINE_ID | Founder LINE user ID (permanent Jarvis access) |
| JARVIS_ACTIVATION_CODE | Staff activation passphrase |
| NEUROHANDS_API_KEY | Protects /api/agent/run |
| CRON_SECRET | Protects /cron/daily |
| FALLBACK_PROVIDER | groq / openrouter / mistral / cerebras |
| FALLBACK_API_KEY | Key for the fallback provider |
| FALLBACK_MODEL | Single model (comma list also accepted) |
| FALLBACK_MODELS | Optional comma-separated cascade list |
| FALLBACK_BASE_URL | Optional custom OpenAI-compatible base URL |
| PUBLIC_URL | Optional override for portal links (else Railway domain) |

## Deploy
1. Railway → New Project → Deploy from GitHub repo `neurohands-bot`.
2. Add the variables above.
3. Railway → Settings → Networking → Generate Domain.
4. LINE Developers → Messaging API → Webhook URL = `https://<your-domain>/webhook` → Verify → Use webhook ON.
5. Supabase: run the MASTER SQL (idempotent: creates all tables, pgvector extension, storage bucket, seeds) → **restart the project**.
6. Rich menus: place two 2500×1686 PNGs in `scripts/`, then `node scripts/setup-richmenu.js`.

## Database (Supabase, schema public)
- Base: clients, glass_types, edging_services, orders, messages, settings, faq_knowledge, bot_feedback
- Jarvis: staff_activations, jarvis_notes, jarvis_checklist, jarvis_audit_log, jarvis_changelog
- Platform: client_accounts, activation_codes, client_agent_bindings, agent_registry, agent_runs, tool_calls, agent_memory, agent_tasks, support_cases, escalations, client_documents, knowledge_chunks (pgvector)
- Storage: private bucket `neurohands-docs`, per-client folders `CODE/DEPT/YYYY-MM/`

## Activation & tenancy
- Founder: `code: KNC sales` → generates `KNC01SAL`-style code (3-letter client + 2 digits + dept code).
- Client: `activate KNC01SAL` → binding created, active rich menu linked, Aria enabled for that department.
- Isolation: every tool and document query is filtered by `client_account_id`; cross-client reads are impossible by construction.

## Jarvis commands (founder LINE)
brief · agents · runs · trace: <id> · memory: · code: <CLIENT> <dept> · codes · upload · upload: <CLIENT> <dept> · docs: <CLIENT> · doc: <CODE> · act: <tool> {json} (+yes/no) · task: · done: · checklist · note:/learn:/market: (+yes/no) · whois: <ID> · help

## HTTP endpoints
- `POST /webhook` — LINE events (signature-verified)
- `GET /upload?t=<token>` / `POST /api/upload?t=<token>` — signed document portal
- `POST /cron/daily` — daily digest push (header `x-cron-secret`)
- `POST /api/agent/run` — programmatic agent run (header `x-api-key`)
- `GET /` — health

## LLM cascade & model updates
Gemini first; on quota/error the fallback provider is tried with each model in `FALLBACK_MODELS` (then `FALLBACK_MODEL`) in order, caching the first that works. To upgrade brains: change variables only — no code change.

## Version history
v1 sales bot → v2 Jarvis console → v3.0–3.2 agent runtime + evidence chain → v3.3–3.6 menus, portal, multi-model fallback → v3.7–3.10 cascade hardening, upload handlers, master SQL, pgvector schema.

## Roadmap (Phase 2, post-freeze)
Reflection loop (nightly self-review) · task scheduler (due follow-ups auto-execute) · embeddings wiring for `knowledge_chunks` (semantic_search tool) · analytics tools (lead-time forecast, anomaly flags) · per-client daily backups.
