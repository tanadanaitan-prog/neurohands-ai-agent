# Neurohands AI Agent Organization Handbook (Multi-LLM Canonical Guide)

> **Mission:** From Thailand to the World — Helping humans learn and grow.  
> **Vision:** Build trustworthy, human-in-the-loop AI agent teams for LINE Official Accounts and web operations where every business keeps full ownership of its data.  
> **Schema Version:** `1.0.0` · **Teams:** 11 · **Agents:** 35

## 1. Non-Destructive Governance Principles

1. Non-destructive append-only learning: never erase or duplicate verified records; supersede via linked revisions.
2. Strict case-by-case individual learning isolation: each agent owns its own namespace and never mixes cases with another agent.
3. One major curated team learning ledger per team, maintained by that team's manager.
4. Central Command receives Founder commands, convenes Team Managers to plan and divide work, tracks manager follow-up, and requires final sign-off from Health, Security, and Audit teams.
5. Universal multi-LLM readability across GitHub, Supabase, Railway, LangSmith, and Notion.

## 2. Central Command & Multi-Team Execution Protocol

1. Founder submits task or command to Central Command.
2. Central Command convenes relevant Team Managers to discuss constraints, dependencies, and risks.
3. Central Command divides work into bounded, non-overlapping team assignments with acceptance checks.
4. Specialist agents execute inside their scope and append case-by-case learnings to their isolated individual namespace.
5. Each Team Manager verifies accuracy, curates verified patterns into the team's major learning ledger, and reports completion.
6. Final 3 Governance Teams (Health, Security, Audit) inspect runtime health, RLS/privacy/secrets, and append-only rule compliance before sign-off and channel report dispatch.

## 3. Connected Platforms (Single Source of Truth)

| Platform | Role | Identifier |
| --- | --- | --- |
| `github` | Canonical source code, org roster, migrations, tests, and JSON/JSONL learning ledgers | `https://github.com/tanadanaitan-prog/neurohands-ai-agent` |
| `supabase` | Multi-tenant PostgreSQL 17, app_metadata RLS, append-only individual & team learning tables, reports, and governance audit logs | `darxiaearohhnxiwhcbs` |
| `railway` | 24/7 production runtime serving /neurohands, /webhook, /api/trial/*, /api/org/*, /api/dashboard/*, and /assets/guides/*.png | `https://neurohands-ai-agent-production.up.railway.app` |
| `line_oa` | 1:1 chats, group chats, interactive Flex Cards, Quick Replies, and channel-routed reports | `/webhook` |
| `langsmith` | Optional non-blocking PII-free trace export for workflow runs, learning updates, and evaluations | `LANGSMITH_API_KEY` |
| `notion` | Human & multi-LLM readable executive hub for org chart, requirements, checklist, and synced learning lessons | `41f1c2ab-14e3-819f-8e2a-fc3e1e3dc07b` |

## 4. Organization Teams (11 Teams)

| Team ID | Team Name | Tier | Team Manager | Agents | Major Team Learning File |
| --- | --- | --- | --- | ---: | --- |
| `central-command` | Central Executive Command & Strategy Council | `command` | `cmd-director` | 3 | `platform/docs/org/learning/teams/central-command.json` |
| `line-biz-console` | LINE Business & Console Development Team | `operations` | `line-manager` | 4 | `platform/docs/org/learning/teams/line-biz-console.json` |
| `website-brand-ux` | Website & Brand Synchronized Specialist Team | `operations` | `web-manager` | 5 | `platform/docs/org/learning/teams/website-brand-ux.json` |
| `business-dx` | Business, Content & Digital Transformation Team | `operations` | `dx-manager` | 4 | `platform/docs/org/learning/teams/business-dx.json` |
| `ai-engineering-arch` | AI Engineering & Architecture Team (FE + BE) | `operations` | `eng-manager` | 4 | `platform/docs/org/learning/teams/ai-engineering-arch.json` |
| `customer-service` | Customer Service Team (Frontline) | `customer` | `cs-manager` | 3 | `platform/docs/org/learning/teams/customer-service.json` |
| `after-service` | After-Service & Care Team (Separate Role) | `customer` | `after-manager` | 3 | `platform/docs/org/learning/teams/after-service.json` |
| `sales-marketing` | Sales & Marketing Team | `growth` | `growth-manager` | 3 | `platform/docs/org/learning/teams/sales-marketing.json` |
| `health-monitor` | Final Governance Team 1 — Health & Reliability | `governance` | `health-manager` | 2 | `platform/docs/org/learning/teams/health-monitor.json` |
| `security-guard` | Final Governance Team 2 — Security & Privacy | `governance` | `sec-manager` | 2 | `platform/docs/org/learning/teams/security-guard.json` |
| `audit-compliance` | Final Governance Team 3 — Audit & Command Compliance | `governance` | `audit-manager` | 2 | `platform/docs/org/learning/teams/audit-compliance.json` |

## 5. Complete AI Agent Roster (35 Agents — Strictly Isolated Individual Learning)

| Agent ID | Display Name | Team ID | Level | Channels | Isolated Individual Learning File |
| --- | --- | --- | --- | --- | --- |
| `cmd-director` | Neurohands Central Director | `central-command` | Manager | `founder, line_user, web, notion` | `platform/docs/org/learning/individual/cmd-director.jsonl` |
| `cmd-planner` | Strategic Task Divider | `central-command` | Specialist | `founder, notion` | `platform/docs/org/learning/individual/cmd-planner.jsonl` |
| `cmd-synthesizer` | Cross-Team Reconciler | `central-command` | Specialist | `founder, notion, web` | `platform/docs/org/learning/individual/cmd-synthesizer.jsonl` |
| `line-manager` | LINE Ops Manager | `line-biz-console` | Manager | `line_user, line_group, founder` | `platform/docs/org/learning/individual/line-manager.jsonl` |
| `line-console-architect` | LINE Console & Flex Architect | `line-biz-console` | Specialist | `line_user, line_group` | `platform/docs/org/learning/individual/line-console-architect.jsonl` |
| `line-channel-tester` | LINE Channel & Report Specialist | `line-biz-console` | Specialist | `line_user, line_group, web` | `platform/docs/org/learning/individual/line-channel-tester.jsonl` |
| `line-connector-sync` | Platform Connector Engineer | `line-biz-console` | Specialist | `founder, web` | `platform/docs/org/learning/individual/line-connector-sync.jsonl` |
| `web-manager` | Website & Brand Director | `website-brand-ux` | Manager | `web, notion` | `platform/docs/org/learning/individual/web-manager.jsonl` |
| `web-brand-designer` | Brand Font, Mood & Visual Designer | `website-brand-ux` | Specialist | `web, line_user` | `platform/docs/org/learning/individual/web-brand-designer.jsonl` |
| `web-ux-architect` | Guided UX & Responsive Architect | `website-brand-ux` | Specialist | `web` | `platform/docs/org/learning/individual/web-ux-architect.jsonl` |
| `web-ux-device-tester` | Customer Multi-Device UX Tester | `website-brand-ux` | Specialist | `web, line_user` | `platform/docs/org/learning/individual/web-ux-device-tester.jsonl` |
| `web-color-sync-designer` | Synchronized UI Color Designer | `website-brand-ux` | Specialist | `web, line_user` | `platform/docs/org/learning/individual/web-color-sync-designer.jsonl` |
| `dx-manager` | Digital Transformation Manager | `business-dx` | Manager | `notion, web, founder` | `platform/docs/org/learning/individual/dx-manager.jsonl` |
| `dx-content-polisher` | Bilingual Content & Playbook Polisher | `business-dx` | Specialist | `web, line_user, notion` | `platform/docs/org/learning/individual/dx-content-polisher.jsonl` |
| `dx-workflow-optimizer` | Cross-Team Process Architect | `business-dx` | Specialist | `notion, founder` | `platform/docs/org/learning/individual/dx-workflow-optimizer.jsonl` |
| `dx-context-wording-specialist` | Context & Content Wording Specialist | `business-dx` | Specialist | `web, line_user, notion` | `platform/docs/org/learning/individual/dx-context-wording-specialist.jsonl` |
| `eng-manager` | Chief AI Architect | `ai-engineering-arch` | Manager | `founder, web, notion` | `platform/docs/org/learning/individual/eng-manager.jsonl` |
| `eng-frontend-specialist` | Frontend Interactive Engineer | `ai-engineering-arch` | Specialist | `web` | `platform/docs/org/learning/individual/eng-frontend-specialist.jsonl` |
| `eng-backend-guardrail` | Backend Data & Guardrail Engineer | `ai-engineering-arch` | Specialist | `web, line_user, line_group` | `platform/docs/org/learning/individual/eng-backend-guardrail.jsonl` |
| `eng-learning-curator` | Error & Learning Pattern Curator | `ai-engineering-arch` | Specialist | `notion, founder` | `platform/docs/org/learning/individual/eng-learning-curator.jsonl` |
| `cs-manager` | Customer Service Manager | `customer-service` | Manager | `line_user, line_group, web` | `platform/docs/org/learning/individual/cs-manager.jsonl` |
| `cs-aria-frontline` | Aria — Frontline Inquiry & Quote Specialist | `customer-service` | Specialist | `line_user, line_group, web` | `platform/docs/org/learning/individual/cs-aria-frontline.jsonl` |
| `cs-order-tracker` | Order & Lead-Time Desk Specialist | `customer-service` | Specialist | `line_user, line_group, web` | `platform/docs/org/learning/individual/cs-order-tracker.jsonl` |
| `after-manager` | After-Service Manager | `after-service` | Manager | `line_user, line_group, web` | `platform/docs/org/learning/individual/after-manager.jsonl` |
| `after-warranty-care` | Warranty & Claims Care Specialist | `after-service` | Specialist | `line_user, web` | `platform/docs/org/learning/individual/after-warranty-care.jsonl` |
| `after-retention-followup` | Post-Installation Follow-Up Specialist | `after-service` | Specialist | `line_user, web` | `platform/docs/org/learning/individual/after-retention-followup.jsonl` |
| `growth-manager` | Sales & Marketing Manager | `sales-marketing` | Manager | `line_user, line_group, web, notion` | `platform/docs/org/learning/individual/growth-manager.jsonl` |
| `sales-suri-closer` | Suri — Sales Qualification Specialist | `sales-marketing` | Specialist | `line_user, line_group, web` | `platform/docs/org/learning/individual/sales-suri-closer.jsonl` |
| `mkt-mira-campaigns` | Mira — Campaigns & Proposal Specialist | `sales-marketing` | Specialist | `web, notion, line_user` | `platform/docs/org/learning/individual/mkt-mira-campaigns.jsonl` |
| `health-manager` | Health & SLA Manager | `health-monitor` | Manager | `founder, web, notion` | `platform/docs/org/learning/individual/health-manager.jsonl` |
| `health-sla-sentinel` | Uptime & Connector Sentinel | `health-monitor` | Specialist | `founder, web` | `platform/docs/org/learning/individual/health-sla-sentinel.jsonl` |
| `sec-manager` | Chief Security Officer Agent | `security-guard` | Manager | `founder, web, notion` | `platform/docs/org/learning/individual/sec-manager.jsonl` |
| `sec-rls-redteam` | RLS, PDPA & Red-Team Specialist | `security-guard` | Specialist | `founder, notion` | `platform/docs/org/learning/individual/sec-rls-redteam.jsonl` |
| `audit-manager` | Chief Audit & Compliance Manager | `audit-compliance` | Manager | `founder, web, notion` | `platform/docs/org/learning/individual/audit-manager.jsonl` |
| `audit-rule-verifier` | Append-Only & Rule Compliance Auditor | `audit-compliance` | Specialist | `founder, notion` | `platform/docs/org/learning/individual/audit-rule-verifier.jsonl` |

## 6. How Any LLM or AI Agent Reads & Appends Verified Learning

- **Discover Organization**: `GET /api/org/roster` (secret-free universal manifest) or read `platform/config/org-roster.v1.json`.
- **Read Individual Case Learning**: `GET /api/org/learning/individual/:agentId` or read `platform/docs/org/learning/individual/<agentId>.jsonl`.
- **Append Individual Case Learning (No Duplicates, No Overwrites)**: `POST /api/org/learning/individual/:agentId` with unique `caseKey`; link revisions via `supersedesId`.
- **Read / Curate Major Team Learning**: `GET/POST /api/org/learning/team/:teamId` (curated only by that team's manager, Central Command, or Audit).
- **Central Council Planning**: `POST /api/org/council/plan` (divides Founder command across relevant Team Managers with mandatory Health, Security, and Audit sign-off).
- **Read & Create Channel-Routed Reports**: `GET/POST /api/org/reports` (`line_user`, `line_group`, `founder`, `web`, `notion`) or LINE Jarvis staff commands `org`, `report: read`, `report: create <title> | <channel> | <summary>`, `audit: org`.
- **Run 3-Team Governance Audit**: `GET /api/org/governance/audit` (Health + Security + Audit scorecard).
