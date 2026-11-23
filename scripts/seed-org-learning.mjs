#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadOrgRoster } = require("../src/lib/org-learning-store.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLATFORM_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PLATFORM_DIR, "..");
const LEARNING_DIR = path.join(PLATFORM_DIR, "docs", "org", "learning");
const REPORTS_PATH = path.join(PLATFORM_DIR, "docs", "org", "REPORTS_LEDGER.jsonl");
const HANDBOOK_PATH = path.join(PLATFORM_DIR, "docs", "org", "ORG_HANDBOOK.md");
const AGENTS_DIR = path.join(REPO_ROOT, ".agents", "agents");

const TEAM_SEED_PATTERNS = {
  "central-command": {
    pattern_key: "PAT-CMD-001",
    title: "Council Decomposition Before Execution + Mandatory 3-Team Governance Sign-Off",
    standard_playbook: "Every Founder request enters Central Command first, convenes only the relevant Team Managers to divide disjoint file and API ownership, tracks each manager's verification check, and requires independent Health, Security, and Audit sign-off before completion.",
    guardrail_rule: "Never mark a release complete without verified command exit code 0 after the final edit and explicit pass status from Health, Security, and Audit.",
    source_case_keys: ["CASE-CMD-DIR-001", "CASE-CMD-PLN-001", "CASE-CMD-SYN-001"],
  },
  "line-biz-console": {
    pattern_key: "PAT-LINE-001",
    title: "Retina 2500x1686 Rich Menus, Human-Friendly Flex Cards & Safe 1:1/Group Channel Routing",
    standard_playbook: "Serve 2500x1686 (<250 KB) PNG Rich Menus matching Midnight Navy + Electric Cyan branding, send interactive LINE Flex Cards (191:100 hero) with Quick Replies instead of plain text walls, support 1:1 & group testing (off|mention_only|keyword|always), and dispatch reports cleanly to chosen channels.",
    guardrail_rule: "Pin allowedLiffId and tenant clientCode subdomains, delete orphan Rich Menus on upload failure, never send operator Approve/Reject buttons to customer groups, and never block LINE webhook replies on optional LangSmith traces.",
    source_case_keys: ["CASE-LINE-MGR-001", "CASE-LINE-ARC-001", "CASE-LINE-TST-001", "CASE-LINE-CON-001"],
  },
  "website-brand-ux": {
    pattern_key: "PAT-WEB-001",
    title: "Hybrid Executive Brand Sync Across Web, Visual Guides & Phone/Tablet/Laptop Viewports",
    standard_playbook: "Synchronize /neurohands, LINE Rich Menus, and HTML-to-PNG visual guide cards on Midnight Navy (#060D28), Electric Cyan (#0F8CE8/#38BDF8), and Crisp White (#FFFFFF) with mission 'From Thailand to the World — Helping humans learn and grow.'",
    guardrail_rule: "Match 1200x628 visual guide cards with aspect-ratio 1200/628 object-fit:contain, verify zero horizontal overflow at 390px, 768px, and 1440px, and keep mobile sticky headers compact with scroll-margin-top >= 148px.",
    source_case_keys: ["CASE-WEB-MGR-001", "CASE-WEB-DES-001", "CASE-WEB-UX-001"],
  },
  "business-dx": {
    pattern_key: "PAT-DX-001",
    title: "Human-Friendly Bilingual Guided Playbooks & Clean Cross-Team Handoffs",
    standard_playbook: "Translate technical setup into clear 4-step interactive checklists (Sign Up -> Build Agent -> Test on Web -> Connect to LINE) with plain English + Thai copy and documented Notion runbooks.",
    guardrail_rule: "Eliminate unexplained acronyms and raw JSON instructions from customer-facing flows; every operational change updates the canonical Notion checklist without erasing prior records.",
    source_case_keys: ["CASE-DX-MGR-001", "CASE-DX-CPY-001", "CASE-DX-OPT-001"],
  },
  "ai-engineering-arch": {
    pattern_key: "PAT-ENG-001",
    title: "Fail-Closed Guardrails, Normalized Schemas & Error-to-Regression-Test Loop",
    standard_playbook: "Separate pure domain logic from HTTP/LINE adapters, enforce atomic SQL RPCs and PGlite PostgreSQL 17 tests, respect explicit GEMINI_MODELS without silent downgrades, and turn every caught defect into a DEV_LESSONS_LEDGER.json record plus an automated regression test.",
    guardrail_rule: "Never fall open on database errors (return C06_DATABASE_DEGRADED_RESPONSE), never guess module exports or SQL column names without reading first, and never copy monorepo-only tests into the standalone deployment repo.",
    source_case_keys: ["CASE-ENG-MGR-001", "CASE-ENG-FE-001", "CASE-ENG-BE-001", "CASE-ENG-CUR-001"],
  },
  "customer-service": {
    pattern_key: "PAT-CS-001",
    title: "Grounded Frontline Quotations, Exact Lead Times & Instant Human Handover",
    standard_playbook: "Answer frontline product, dimension quote, and active order status inquiries strictly from tenant-approved knowledge entries and live DB rows, switching immediately to human_active whenever a customer requests human assistance.",
    guardrail_rule: "Never invent unlisted prices, stock, or order numbers; always honor active conversation takeover state before sending any AI reply.",
    source_case_keys: ["CASE-CS-MGR-001", "CASE-CS-ARIA-001", "CASE-CS-ORD-001"],
  },
  "after-service": {
    pattern_key: "PAT-AFTER-001",
    title: "Dedicated Post-Delivery Warranty, Defect Resolution & Satisfaction Care",
    standard_playbook: "Handle cracked/damaged delivery claims, warranty verification, replacement staging, and post-installation check-ins inside the isolated After-Service team separate from frontline sales and pre-order inquiries.",
    guardrail_rule: "Require order evidence before staging replacement or credit proposals, escalate every financial credit or remake to human approval, and keep post-delivery learning separate from frontline CS.",
    source_case_keys: ["CASE-AFT-MGR-001", "CASE-AFT-WRN-001", "CASE-AFT-RET-001"],
  },
  "sales-marketing": {
    pattern_key: "PAT-GROWTH-001",
    title: "Evidence-Grounded B2B Qualification, Brand-Aligned Proposals & Discount Gating",
    standard_playbook: "Qualify B2B project dimensions, timelines, and specs (Suri), draft brand-synchronized proposals and bilingual campaigns (Mira), and keep every commercial figure traceable to approved price tables.",
    guardrail_rule: "Never promise custom discounts, contractual terms, or delivery guarantees without explicit human operator approval.",
    source_case_keys: ["CASE-GRW-MGR-001", "CASE-SLS-SUR-001", "CASE-MKT-MIR-001"],
  },
  "health-monitor": {
    pattern_key: "PAT-HEALTH-001",
    title: "Continuous Live Readiness, <2.5s Race SLA & 6-Platform Connector Verification",
    standard_playbook: "Verify /ready, /version, provider circuit breakers, Railway deployment status, Supabase connectivity, LINE webhook health, GitHub main parity, LangSmith tracing, and Notion hub availability before declaring any release healthy.",
    guardrail_rule: "Treat silent 404 model failures, unhandled provider timeouts, or unverified Railway deployments as blocking release failures.",
    source_case_keys: ["CASE-HLT-MGR-001", "CASE-HLT-SNT-001"],
  },
  "security-guard": {
    pattern_key: "PAT-SEC-001",
    title: "Zero-Trust app_metadata RLS, Customer-vs-Operator Isolation & Zero Secret Leaks",
    standard_playbook: "Audit every migration for app_metadata-only RLS with regex-guarded bigint casts, verify x-api-key/JWT gates on operational endpoints, enforce customer-vs-operator Flex Card separation, and scan all source/learning files for credentials.",
    guardrail_rule: "Never trust user_metadata in RLS, never expose operator Approve/Reject postbacks in customer groups, and block any payload containing tokens, keys, or raw private keys.",
    source_case_keys: ["CASE-SEC-MGR-001", "CASE-SEC-RED-001"],
  },
  "audit-compliance": {
    pattern_key: "PAT-AUDIT-001",
    title: "Strict Append-Only Non-Destructive Learning & Per-Agent/Per-Team Isolation Compliance",
    standard_playbook: "Audit all 11 teams and 32 agents to prove zero duplicated keys, zero erased rows, strict individual case_key isolation per agent_id, manager-curated team patterns, and faithful execution of Founder prompts and rules.",
    guardrail_rule: "Block DELETE/UPDATE on learning tables via PostgreSQL immutability trigger (ERRCODE 42501); evolve lessons strictly by appending new records linked via supersedes_id.",
    source_case_keys: ["CASE-AUD-MGR-001", "CASE-AUD-VER-001"],
  },
};

const AGENT_SEED_CASES = {
  "cmd-director": { case_key: "CASE-CMD-DIR-001", title: "Enforce 3-team governance sign-off before declaring completion", context_summary: "Multi-wave releases touched web UI, LINE Flex cards, and Supabase schema simultaneously.", observation: "Without an explicit final sign-off gate, subtle UX cropping and operator button leakage nearly shipped.", verified_action: "Require Health, Security, and Audit review passes after implementation and re-run full verification before shipping.", evidence_ref: "LES-009 / commit e1bcd91", outcome: "verified", severity: "high" },
  "cmd-planner": { case_key: "CASE-CMD-PLN-001", title: "Split large deliverables into disjoint verifiable units (U1-U6)", context_summary: "Large multi-surface tasks span SQL, backend APIs, LINE adapters, UI, and Notion sync.", observation: "Overlapping edits across files cause merge drift and missed regressions.", verified_action: "Assign disjoint file ownership per team and require a passing test check at the end of every unit.", evidence_ref: "ai_org_learning_hub_plan.md", outcome: "verified", severity: "medium" },
  "cmd-synthesizer": { case_key: "CASE-CMD-SYN-001", title: "Cross-check live parity across GitHub, Supabase, Railway, LangSmith, and Notion", context_summary: "Stakeholders and external LLMs consult different platforms for current Neurohands status.", observation: "Local workspace updates alone leave Notion or GitHub stale unless explicitly reconciled.", verified_action: "Mirror platform code via isolated origin/main worktree, verify live Railway endpoints, and sync Notion with exact commit hashes and test counts.", evidence_ref: "LES-003 / U25-U27", outcome: "verified", severity: "medium" },
  "line-manager": { case_key: "CASE-LINE-MGR-001", title: "Coordinate Rich Menu, Flex Cards, and 1:1/Group activation readiness", context_summary: "Customers needed an effortless path from website signup to testing agents in LINE 1:1 and groups.", observation: "Raw text setup instructions caused confusion around binding codes and group rules.", verified_action: "Pair 2500x1686 Retina Rich Menus with visual guide cards, 1-click Copy commands, and interactive Flex Cards.", evidence_ref: "commit e1bcd91", outcome: "verified", severity: "medium" },
  "line-console-architect": { case_key: "CASE-LINE-ARC-001", title: "Pin Rich Menu URI allowlists and clean up orphan menus on upload errors", context_summary: "LINE Rich Menu provisioning creates menu IDs before uploading PNG content.", observation: "Unpinned LIFF paths risked spoofing and failed PNG uploads could leave orphaned Rich Menus.", verified_action: "Pin allowedLiffId and tenant clientCode subdomains, reject '..' segments, delete orphaned menus on failure, and target 2500x1686 PNG (<250 KB).", evidence_ref: "LES-004 / test/line-console.test.js", outcome: "error_prevented", severity: "high" },
  "line-channel-tester": { case_key: "CASE-LINE-TST-001", title: "Handle LINE group join/leave events and per-group response policies cleanly", context_summary: "Customers invite the LINE Official Account into multi-person work groups to test agents.", observation: "Dropping events without source.userId silently broke group join welcomes and bind flows.", verified_action: "Process join/leave events, bind NH-CODE atomically, enforce off|mention_only|keyword|always modes, and support report read/create/dispatch across channels.", evidence_ref: "LES-005 / test/trial-api-and-line-group.test.js", outcome: "verified", severity: "high" },
  "line-connector-sync": { case_key: "CASE-LINE-CON-001", title: "Keep LangSmith tracing optional, PII-free, and non-blocking on webhooks", context_summary: "LINE webhooks require fast deterministic responses under the 2.5s Race SLA.", observation: "Missing optional telemetry env vars or slow trace POSTs must never block customer replies.", verified_action: "Export only PII-free metadata (tenant/team/agent/latency/outcome) asynchronously with safe catch guards.", evidence_ref: "platform/src/lib/trial-router.js", outcome: "verified", severity: "medium" },
  "web-manager": { case_key: "CASE-WEB-MGR-001", title: "Unify web, LINE Rich Menus, and guide cards under one visual identity", context_summary: "Brand attachments established Midnight Navy (#060D28), Electric Cyan (#0F8CE8/#38BDF8), and Crisp White.", observation: "Inconsistent palette and dark-only vs light-only mismatches fragmented customer trust.", verified_action: "Enforce the Hybrid Executive theme across /neurohands, Rich Menus, and 1200x628 visual guide cards.", evidence_ref: "neurohands_customer_trial_showcase.md", outcome: "verified", severity: "medium" },
  "web-brand-designer": { case_key: "CASE-WEB-DES-001", title: "Match HTML-to-PNG guide aspect ratio (1200x628) to both Web and LINE Flex hero", context_summary: "Visual guides are displayed both inside Step 4 on /neurohands and as LINE Flex Card hero images.", observation: "Using 16:10 with object-fit:cover clipped the left and right edges of 1200x628 visual guide text.", verified_action: "Set web .guide-media to aspect-ratio 1200/628 with object-fit:contain and LINE Flex hero aspectRatio to 191:100.", evidence_ref: "LES-009 / v2_pilot_laptop_step4_guides.png", outcome: "error_prevented", severity: "high" },
  "web-ux-architect": { case_key: "CASE-WEB-UX-001", title: "Prevent mobile sticky header clipping and fixed CTA overlap at 390x844", context_summary: "Customers manage agents across phones (390px), tablets (768px), and laptops (1440px).", observation: "Multi-line sticky headers clipped #trial-workspace anchor jumps and the floating mobile CTA covered Step 2 controls.", verified_action: "Compact mobile sticky nav, set scroll-margin-top:148px, hide .mcta when #trial-workspace is in view, and enforce 18x18 inline checkboxes.", evidence_ref: "LES-009 / verify-trial-pilot.mjs", outcome: "error_prevented", severity: "high" },
  "web-ux-device-tester": { case_key: "CASE-WEB-DEV-001", title: "Verify zero-overflow customer UX and hash-targeted trial workspace across phone, tablet, and laptop", context_summary: "Customers land on /neurohands#trial-workspace from desktop, tablet, and mobile browsers.", observation: "Unchecked first-load modals or viewport mismatches on 390px, 768px, and 1440px can obscure #trial-workspace controls.", verified_action: "Execute automated CDP checks across 390x844, 768x1024, and 1440x900 viewports confirming 0px horizontal overflow and non-blocking #trial-workspace anchor navigation.", evidence_ref: "R3 / scripts/verify-trial-pilot.mjs", outcome: "verified", severity: "medium" },
  "web-color-sync-designer": { case_key: "CASE-WEB-CLR-001", title: "Synchronize Midnight Navy, Electric Cyan, and Crisp White color tokens across web, LINE OA, and visual guides", context_summary: "Customers interact with /neurohands, Studio, LINE OA profile assets, Rich Menus, and Flex Cards.", observation: "Opaque backgrounds or unaligned surface accents break visual continuity under forced mobile dark mode.", verified_action: "Enforce unified Midnight Navy (#060D28), Electric Cyan (#0F8CE8/#38BDF8), and Crisp White (#FFFFFF) tokens with transparent RGBA logos across every surface.", evidence_ref: "R3 / LES-013 & assets/brand", outcome: "verified", severity: "medium" },
  "dx-manager": { case_key: "CASE-DX-MGR-001", title: "Anchor every operational workflow in one non-destructive Notion hub", context_summary: "Multiple teams and external LLMs need one canonical operating picture.", observation: "Scattered notes without owner, expected outcome, and verification evidence cause duplicate work.", verified_action: "Track requirements, org structure, and approved lessons in Notion with append-only updates linked to GitHub commits.", evidence_ref: "Notion 41f1c2ab-14e3-819f-8e2a-fc3e1e3dc07b", outcome: "verified", severity: "medium" },
  "dx-content-polisher": { case_key: "CASE-DX-CPY-001", title: "Replace AI-centric text walls with concise human-friendly bilingual cards", context_summary: "Non-technical business owners found long LINE text replies confusing during onboarding.", observation: "Wall-of-text instructions hid the single action customers needed to tap next.", verified_action: "Structure every LINE reply into clean titled Flex sections with clear English + Thai phrasing and 1-tap Quick Replies.", evidence_ref: "platform/src/lib/line-flex-cards.js", outcome: "verified", severity: "medium" },
  "dx-workflow-optimizer": { case_key: "CASE-DX-OPT-001", title: "Separate frontline CS, After-Service, and Sales handoffs explicitly", context_summary: "Customer journeys span pre-sale quotes, live order tracking, and post-delivery claims.", observation: "Mixing warranty claims into frontline sales queues degrades resolution speed and pollutes training data.", verified_action: "Define clear routing boundaries and isolated team ledgers for Sales, Customer Service, and After-Service.", evidence_ref: "platform/config/org-roster.v1.json", outcome: "verified", severity: "medium" },
  "dx-context-wording-specialist": { case_key: "CASE-DX-WRD-001", title: "Adapt English and Thai wording dynamically to customer context, channel, and buyer stage", context_summary: "First-time web visitors, LINE 1:1 shoppers, and B2B group operators expect different copy density and tone.", observation: "Uniform technical wording reduces comprehension when switching between LINE Flex Cards, /neurohands steps, and Notion docs.", verified_action: "Tailor concise, context-matched bilingual wording per surface while keeping Neurohands hardware and governance terms consistent.", evidence_ref: "R3 / platform/config/org-roster.v1.json", outcome: "verified", severity: "medium" },
  "eng-manager": { case_key: "CASE-ENG-MGR-001", title: "Honor explicit GEMINI_MODELS without silent downgrades", context_summary: "Configured Gemini models returned 404 errors in production agent_runs #74-#78.", observation: "normalizeGeminiModelName rewrote newer configured models to deprecated gemini-2.5-flash.", verified_action: "Strip optional models/ prefix only, deduplicate cleanly, and respect explicit GEMINI_MODELS env configuration.", evidence_ref: "LES-001 / test/llm-recovery.test.js", outcome: "error_prevented", severity: "high" },
  "eng-frontend-specialist": { case_key: "CASE-ENG-FE-001", title: "Match frontend field bindings strictly to canonical API snake_case schemas", context_summary: "The /neurohands lessons panel rendered empty Fix and Check lines during U12 pilot testing.", observation: "Frontend JS read camelCase keys while DEV_LESSONS_LEDGER.json exposed snake_case keys (error_signature, approved_fix, regression_test).", verified_action: "Bind DOM textContent directly to canonical snake_case response fields and assert non-empty rendered cards in headless CDP pilot checks.", evidence_ref: "LES-008 / scripts/verify-trial-pilot.mjs", outcome: "error_prevented", severity: "high" },
  "eng-backend-guardrail": { case_key: "CASE-ENG-BE-001", title: "Fail closed on DB errors and claim LINE activation codes atomically", context_summary: "Adversarial review examined handover state checks, quota enforcement, and group binding.", observation: "Catching non-404 DB errors permissively could bypass human takeover; non-atomic code checks allowed race conditions or cross-tenant hijack.", verified_action: "Return C06_DATABASE_DEGRADED_RESPONSE on non-missing-table DB errors, claim codes via atomic RPC, and guard 0-charge quota resets.", evidence_ref: "LES-007 / test/trial-release-db.test.js", outcome: "error_prevented", severity: "critical" },
  "eng-learning-curator": { case_key: "CASE-ENG-CUR-001", title: "Verify module exports and standalone deploy isolation before committing", context_summary: "Early builds hit a wrong isFreshRecord import and a monorepo-only test ENOENT on Railway.", observation: "Assuming exports or copying monorepo-coupled tests breaks standalone CI.", verified_action: "Read target exports before importing, verify every fix with a regression test, and run full checks in an isolated origin/main worktree.", evidence_ref: "LES-003 & LES-006", outcome: "error_prevented", severity: "high" },
  "cs-manager": { case_key: "CASE-CS-MGR-001", title: "Guarantee seamless pause/takeover/resume across web and LINE chats", context_summary: "Operators need immediate control to step into active customer conversations.", observation: "Delayed takeover state propagation risks AI replying while a human is already typing.", verified_action: "Persist per-thread takeover state server-side and check it before every LINE 1:1 or group AI reply.", evidence_ref: "platform/src/lib/conversation-handover.js", outcome: "verified", severity: "high" },
  "cs-aria-frontline": { case_key: "CASE-CS-ARIA-001", title: "Compute deterministic sqft + edging quotes for custom knowledge entries", context_summary: "New trial tenants enter custom products and prices in their drag-and-drop workflow.", observation: "Pricing math initially fired only for legacy glass_types records instead of tenant custom knowledgeEntries.", verified_action: "Support deterministic width*height pricing over tenant knowledgeEntries and never invent unlisted prices.", evidence_ref: "LES-008 / test/trial-workflow-runtime.test.js", outcome: "verified", severity: "medium" },
  "cs-order-tracker": { case_key: "CASE-CS-ORD-001", title: "Verify tenant-scoped order lookup before quoting delivery ETAs", context_summary: "Customers ask for live order status and delivery timing inside LINE chats.", observation: "Guessing status or reading unscoped tables risks leaking cross-tenant order details.", verified_action: "Query tenant-scoped records only, state clearly when an order reference is missing, and escalate urgent delays to humans.", evidence_ref: "platform/src/lib/catalog-access.js", outcome: "verified", severity: "medium" },
  "after-manager": { case_key: "CASE-AFT-MGR-001", title: "Keep post-delivery care metrics and learning isolated from frontline CS", context_summary: "After-service warranty and damage cases follow different SLAs and evidence steps than pre-sale inquiries.", observation: "Blending post-delivery claims into frontline scripts weakens warranty auditability.", verified_action: "Operate After-Service as a dedicated team with its own manager, specialists, and append-only learning ledgers.", evidence_ref: "platform/config/org-roster.v1.json", outcome: "verified", severity: "medium" },
  "after-warranty-care": { case_key: "CASE-AFT-WRN-001", title: "Capture order reference and photo evidence before staging warranty replacements", context_summary: "Damaged or cracked deliveries require accurate defect verification.", observation: "Auto-promising replacements without human review risks unapproved material loss.", verified_action: "Collect order ID and defect details, log the structured after-service case, and route replacement/credit approval to the operator.", evidence_ref: "platform/src/lib/workflow-runtime.js", outcome: "verified", severity: "medium" },
  "after-retention-followup": { case_key: "CASE-AFT-RET-001", title: "Log post-installation feedback per case without overwriting prior history", context_summary: "Follow-up check-ins uncover packaging, delivery, and care improvements over time.", observation: "Overwriting previous customer care notes erases longitudinal quality signals.", verified_action: "Append each post-delivery check-in under a unique case_key so recurring defects surface cleanly for team curation.", evidence_ref: "platform/src/lib/org-learning-store.js", outcome: "verified", severity: "info" },
  "growth-manager": { case_key: "CASE-GRW-MGR-001", title: "Enforce human approval gate on every commercial discount or custom term", context_summary: "Sales inquiries frequently request bulk discounts or custom payment terms.", observation: "Unbounded LLM replies can hallucinate unauthorized discounts.", verified_action: "Route all discount and custom term requests into human_approval_required with operator-only confirmation cards.", evidence_ref: "LES-009 / test/trial-workflow-runtime.test.js", outcome: "error_prevented", severity: "high" },
  "sales-suri-closer": { case_key: "CASE-SLS-SUR-001", title: "Structure B2B lead intake around dimensions, quantity, and target delivery date", context_summary: "Incomplete B2B inquiries slow down quotation turnaround.", observation: "Asking unstructured follow-ups creates long back-and-forth threads in LINE groups.", verified_action: "Prompt cleanly for dimensions, specs, quantity, and deadline in one concise turn and summarize a grounded quotation brief.", evidence_ref: "platform/src/lib/workflow-runtime.js", outcome: "verified", severity: "info" },
  "mkt-mira-campaigns": { case_key: "CASE-MKT-MIR-001", title: "Ground every proposal and campaign announcement in verified Neurohands identity", context_summary: "Marketing proposals and LINE announcements represent Neurohands globally.", observation: "Generic hype copy conflicts with the calm executive Midnight Navy + Electric Cyan voice.", verified_action: "Anchor copy on 'From Thailand to the World — Helping humans learn and grow.' with factual, verified capabilities only.", evidence_ref: "platform/config/org-roster.v1.json", outcome: "verified", severity: "info" },
  "health-manager": { case_key: "CASE-HLT-MGR-001", title: "Certify live /ready, /version, and Railway deployment SUCCESS after every push", context_summary: "Code committed to GitHub is not live until Railway finishes building and passes readiness checks.", observation: "Declaring completion right after git push misses build or startup failures.", verified_action: "Verify Railway deployment status is SUCCESS and probe live HTTP /version, /ready, /neurohands, and /api/org/roster.", evidence_ref: "Railway 7a41f9eb-e772-4a63-86ba-89cdfd608386", outcome: "verified", severity: "high" },
  "health-sla-sentinel": { case_key: "CASE-HLT-SNT-001", title: "Track live HTTP status and <2.5s Race SLA across all 6 connected platforms", context_summary: "Neurohands spans GitHub, Supabase, Railway, LINE OA, LangSmith, and Notion.", observation: "A degraded database or unreachable guide image breaks customer experience silently if unchecked.", verified_action: "Probe runtime health and static visual assets after deploy and log degraded statuses transparently without faking pass results.", evidence_ref: "platform/src/lib/org-learning-store.js", outcome: "verified", severity: "medium" },
  "sec-manager": { case_key: "CASE-SEC-MGR-001", title: "Enforce app_metadata-only RLS and revoke PUBLIC execute on SECURITY DEFINER", context_summary: "Supabase Security Advisor flagged user_metadata references in RLS and unsafe ::bigint casts.", observation: "End users can mutate user_metadata via Auth APIs, and non-numeric strings throw 22P02.", verified_action: "Read server-signed app_metadata only with regex-guarded bigint casts and revoke EXECUTE on SECURITY DEFINER functions from public/anon/authenticated.", evidence_ref: "LES-002 / test/trial-release-db.test.js", outcome: "error_prevented", severity: "critical" },
  "sec-rls-redteam": { case_key: "CASE-SEC-RED-001", title: "Isolate operator Approve/Reject Flex buttons strictly away from customer LINE groups", context_summary: "Human approval workflows notify both the customer chat and the operator.", observation: "Sending the same approval Flex Card to a customer LINE group exposed operator Approve/Reject actions and internal account IDs.", verified_action: "Enforce audience='customer' vs audience='operator' in buildApprovalFlexCard and block secret patterns from entering any learning or report store.", evidence_ref: "LES-009 / test/line-flex-cards.test.js", outcome: "error_prevented", severity: "critical" },
  "audit-manager": { case_key: "CASE-AUD-MGR-001", title: "Enforce PostgreSQL immutability trigger blocking DELETE and UPDATE on learning tables", context_summary: "Founder mandated zero duplication and zero erasure across all AI learning data.", observation: "Application-layer checks alone can be bypassed by direct SQL or accidental scripts.", verified_action: "Attach BEFORE UPDATE OR DELETE trigger raising ERRCODE 42501 on nh_agent_individual_learning, nh_team_learning, and nh_governance_audits plus UNIQUE constraints.", evidence_ref: "20261122000002_ai_org_learning_and_reports.sql", outcome: "verified", severity: "critical" },
  "audit-rule-verifier": { case_key: "CASE-AUD-VER-001", title: "Verify zero cross-agent mixing and 100% individual + team coverage on every audit", context_summary: "32 agents across 11 teams maintain separate individual JSONL ledgers and curated team JSON files.", observation: "Accidental writes to the wrong agent file or duplicate keys silently corrupt future LLM retrieval.", verified_action: "Audit every individual JSONL and team JSON file for agent_id/team_id purity, zero duplicate keys, zero secrets, and 100% roster coverage.", evidence_ref: "platform/test/org-council-and-learning.test.js", outcome: "verified", severity: "high" },
};

const WAVE2_AGENT_CASES = [
  {
    agent_id: "after-warranty-care",
    case_key: "CASE-AFT-WRN-002",
    supersedes_case_key: "CASE-AFT-WRN-001",
    title: "Enforce deterministic After-Service order evidence check and warranty replacement approval gate",
    context_summary: "Post-delivery warranty claims must stay separated from frontline sales quotes and require order evidence before staging replacements.",
    observation: "Added ROLE_WORKFLOW_PRESETS.after_service and parseAfterServiceClaim in workflow-runtime.js to detect warranty/defect claims, prompt for missing order numbers, and gate replacement/credit remedies.",
    verified_action: "When an after_service claim includes an order number and requests a replacement or credit, stage a domain='after_service' approval proposal and transition the thread to awaiting_approval.",
    evidence_ref: "U29 / platform/src/lib/workflow-runtime.js & test/trial-workflow-runtime.test.js",
    outcome: "improved",
    severity: "high",
  },
  {
    agent_id: "web-ux-architect",
    case_key: "CASE-WEB-UX-002",
    supersedes_case_key: "CASE-WEB-UX-001",
    title: "Hydrate live 11-Team / 32-Agent AI Organization Hub on /neurohands with canonical teamId bindings",
    context_summary: "Customers and operators inspecting /neurohands need clear visibility into the 11 specialized teams, separate After-Service role, and 3 Final Governance teams.",
    observation: "Added #nh-org-hub and 4 role preset options in neurohands-builder.html, binding directly to canonical teamId and managerAgentId fields from GET /api/org/roster.",
    verified_action: "Render all 11 team cards using safe DOM creation (document.createElement + textContent) with 0px horizontal overflow across 390x844, 768x1024, and 1440x900 viewports.",
    evidence_ref: "U29 / platform/assets/neurohands-builder.html & scripts/verify-trial-pilot.mjs",
    outcome: "improved",
    severity: "medium",
  },
  {
    agent_id: "sec-manager",
    case_key: "CASE-SEC-MGR-002",
    supersedes_case_key: "CASE-SEC-MGR-001",
    title: "Achieve 0 ERROR and 0 WARN on live Supabase Security Advisor via non-destructive ALTER POLICY and SECURITY INVOKER",
    context_summary: "Applying migrations on live Supabase darxiaearohhnxiwhcbs required eliminating legacy user_metadata RLS policies without destructive DROP commands.",
    observation: "In-place ALTER POLICY and ALTER FUNCTION ... SECURITY INVOKER updated all live policies and RPCs non-destructively without triggering confirmation cancellations.",
    verified_action: "Use non-destructive ALTER POLICY to enforce app_metadata-only tenant guards and verify 0 ERROR / 0 WARN via Supabase Security Advisor.",
    evidence_ref: "U28-U29 / Supabase darxiaearohhnxiwhcbs (12/12 migrations live)",
    outcome: "improved",
    severity: "critical",
  },
  {
    agent_id: "cmd-director",
    case_key: "CASE-CMD-DIR-002",
    supersedes_case_key: "CASE-CMD-DIR-001",
    title: "Coordinate multi-team delegation wave across operational specialists and 3 Final Governance Auditors",
    context_summary: "Founder requested full multi-agent delegation across all teams to complete Neurohands with synchronized learning across Notion, Supabase, GitHub, Railway, and LangSmith.",
    observation: "Disjoint slices (Slice A workflow-runtime role parity, Slice B /neurohands 11-Team Org Hub, Slice C Wave-2 append-only learning, and 3-Team Governance Audit) prevented file conflicts.",
    verified_action: "Verify each delegated slice with deterministic tests before advancing and record append-only Wave-2 learnings linked via supersedes_id.",
    evidence_ref: "U29 / ai_org_learning_hub_plan.md",
    outcome: "verified",
    severity: "high",
  },
];

const WAVE2_TEAM_PATTERNS = [
  {
    team_id: "after-service",
    pattern_key: "PAT-AFTER-002",
    supersedes_pattern_key: "PAT-AFTER-001",
    title: "Deterministic Order-Evidence Capture & Human-Gated Warranty Remedy Execution",
    standard_playbook: "Provision After-Service workflows with dedicated warranty instructions and keywords, extract order numbers via parseAfterServiceClaim, prompt for order ID + defect photo when missing, and stage domain='after_service' approval proposals whenever replacement or credit is requested.",
    guardrail_rule: "Never auto-approve warranty replacements or credits without an order reference and explicit human operator approval.",
    source_case_keys: ["CASE-AFT-MGR-001", "CASE-AFT-WRN-001", "CASE-AFT-WRN-002", "CASE-AFT-RET-001"],
  },
  {
    team_id: "security-guard",
    pattern_key: "PAT-SEC-002",
    supersedes_pattern_key: "PAT-SEC-001",
    title: "Non-Destructive Live RLS Policy Evolution & Zero-Warning Supabase Security Posture",
    standard_playbook: "Evolve live production RLS policies in-place with ALTER POLICY using server-signed app_metadata and regex-guarded bigint casts, run RPCs as SECURITY INVOKER where service_role/RLS permits, and verify 0 ERROR / 0 WARN on Supabase Security Advisor.",
    guardrail_rule: "Never use destructive DROP/TRUNCATE on live production learning or tenant tables, and never leave any Security Advisor ERROR or WARN unresolved.",
    source_case_keys: ["CASE-SEC-MGR-001", "CASE-SEC-MGR-002", "CASE-SEC-RED-001"],
  },
];

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function deterministicUuid(seed) {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function renderHandbook(roster) {
  const teamRows = roster.teams.map((t) => {
    const members = roster.agents.filter((a) => a.teamId === t.teamId);
    return `| \`${t.teamId}\` | ${t.name} | \`${t.tier}\` | \`${t.managerAgentId}\` | ${members.length} | \`${t.teamLearningFile}\` |`;
  }).join("\n");

  const agentRows = roster.agents.map((a) =>
    `| \`${a.agentId}\` | ${a.displayName} | \`${a.teamId}\` | ${a.isManager ? "Manager" : "Specialist"} | \`${a.channels.join(", ")}\` | \`${a.individualLearningFile}\` |`
  ).join("\n");

  const connectorRows = Object.entries(roster.raw.connectors).map(([k, v]) =>
    `| \`${k}\` | ${v.role} | \`${v.repo || v.project_ref || v.url || v.webhook || v.env_var || v.checklist_page_id}\` |`
  ).join("\n");

  return `# Neurohands AI Agent Organization Handbook (Multi-LLM Canonical Guide)

> **Mission:** ${roster.raw.mission}  
> **Vision:** ${roster.raw.vision}  
> **Schema Version:** \`${roster.raw.schema_version}\` · **Teams:** ${roster.teams.length} · **Agents:** ${roster.agents.length}

## 1. Non-Destructive Governance Principles

${roster.raw.principles.map((p, i) => `${i + 1}. ${p}`).join("\n")}

## 2. Central Command & Multi-Team Execution Protocol

${roster.raw.workflow_protocol.join("\n")}

## 3. Connected Platforms (Single Source of Truth)

| Platform | Role | Identifier |
| --- | --- | --- |
${connectorRows}

## 4. Organization Teams (${roster.teams.length} Teams)

| Team ID | Team Name | Tier | Team Manager | Agents | Major Team Learning File |
| --- | --- | --- | --- | ---: | --- |
${teamRows}

## 5. Complete AI Agent Roster (${roster.agents.length} Agents — Strictly Isolated Individual Learning)

| Agent ID | Display Name | Team ID | Level | Channels | Isolated Individual Learning File |
| --- | --- | --- | --- | --- | --- |
${agentRows}

## 6. How Any LLM or AI Agent Reads & Appends Verified Learning

- **Discover Organization**: \`GET /api/org/roster\` (secret-free universal manifest) or read \`platform/config/org-roster.v1.json\`.
- **Read Individual Case Learning**: \`GET /api/org/learning/individual/:agentId\` or read \`platform/docs/org/learning/individual/<agentId>.jsonl\`.
- **Append Individual Case Learning (No Duplicates, No Overwrites)**: \`POST /api/org/learning/individual/:agentId\` with unique \`caseKey\`; link revisions via \`supersedesId\`.
- **Read / Curate Major Team Learning**: \`GET/POST /api/org/learning/team/:teamId\` (curated only by that team's manager, Central Command, or Audit).
- **Central Council Planning**: \`POST /api/org/council/plan\` (divides Founder command across relevant Team Managers with mandatory Health, Security, and Audit sign-off).
- **Read & Create Channel-Routed Reports**: \`GET/POST /api/org/reports\` (\`line_user\`, \`line_group\`, \`founder\`, \`web\`, \`notion\`) or LINE Jarvis staff commands \`org\`, \`report: read\`, \`report: create <title> | <channel> | <summary>\`, \`audit: org\`.
- **Run 3-Team Governance Audit**: \`GET /api/org/governance/audit\` (Health + Security + Audit scorecard).
`;
}

function renderNativeAgentFile(team, roster) {
  const manager = roster.agentById.get(team.managerAgentId);
  const specialists = roster.agents.filter((a) => a.teamId === team.teamId && !a.isManager);
  const isGovernance = team.tier === "governance";
  const tools = isGovernance
    ? ["read_file", "grep_search", "find_by_name", "list_dir", "view_file"]
    : ["read_file", "edit_file", "write_file", "grep_search", "find_by_name", "list_dir", "run_command", "view_file", "write_to_file", "replace_file_content"];

  const specialistLines = specialists.length
    ? specialists.map((s) => `- \`${s.agentId}\` (${s.displayName} — ${s.role}): ${s.responsibilities.join("; ")}. Individual ledger: \`${s.individualLearningFile}\`.`).join("\n")
    : "- Managed directly by team manager.";

  return `---
name: nh-${team.teamId}
description: "${team.name} — led by ${manager.displayName} (${manager.agentId}). ${isGovernance ? "Report-only governance auditor." : "Bounded Neurohands operational team."}"
mainAgent: false
subagent: true
model: inherit
commandExecutionPolicy: sandbox
inheritCustomizations: false
tools:
${tools.map((t) => `  - ${t}`).join("\n")}
---

# ${team.name} (\`nh-${team.teamId}\`)

- **Team ID:** \`${team.teamId}\`
- **Tier:** \`${team.tier}\`
- **Team Manager:** \`${manager.agentId}\` (${manager.displayName})
- **Major Team Learning Ledger:** \`${team.teamLearningFile}\`
- **Manager Individual Learning Ledger:** \`${manager.individualLearningFile}\`
- **Channels:** ${team.channels.map((c) => `\`${c}\``).join(", ")}

## Team Mission
${team.mission}

## Specialists Under This Manager
${specialistLines}

## Mandatory Non-Destructive Rules
1. Never erase or duplicate any existing record in individual JSONL ledgers, team JSON ledgers, Supabase learning tables, GitHub history, or Notion pages; append new revisions linked via \`supersedes_id\`.
2. Never mix case-by-case individual learnings across different \`agent_id\` files.
3. Curate verified recurring patterns into \`${team.teamLearningFile}\` only through \`${team.managerAgentId}\` (or Central Command / Audit).
4. ${isGovernance ? "Operate strictly report-only: inspect live artifacts, SQL, code, and ledgers and report proven findings with exact file paths and evidence." : "Verify every change with deterministic tests and submit outputs to the 3 Final Governance Teams (Health, Security, Audit) before declaring done."}
`;
}

function main() {
  const roster = loadOrgRoster();
  const indDir = path.join(LEARNING_DIR, "individual");
  const teamDir = path.join(LEARNING_DIR, "teams");
  fs.mkdirSync(indDir, { recursive: true });
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });

  const nowIso = "2026-11-22T10:00:00+07:00";
  let individualAdded = 0;
  let individualSkipped = 0;
  let teamAdded = 0;
  let teamSkipped = 0;

  for (const agent of roster.agents) {
    const seed = AGENT_SEED_CASES[agent.agentId];
    if (!seed) throw new Error(`Missing individual seed for ${agent.agentId}`);
    const filePath = path.join(indDir, `${agent.agentId}.jsonl`);
    const existing = readJsonl(filePath);
    if (existing.some((r) => r.case_key === seed.case_key)) {
      individualSkipped += 1;
      continue;
    }
    const row = {
      id: deterministicUuid(`ind:${agent.agentId}:${seed.case_key}`),
      agent_id: agent.agentId,
      team_id: agent.teamId,
      case_key: seed.case_key,
      title: seed.title,
      context_summary: seed.context_summary,
      observation: seed.observation,
      verified_action: seed.verified_action,
      evidence_ref: seed.evidence_ref,
      outcome: seed.outcome,
      severity: seed.severity,
      supersedes_id: null,
      created_at: nowIso,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    individualAdded += 1;
  }

  const wave2Iso = "2026-11-22T11:18:00+07:00";
  for (const w2 of WAVE2_AGENT_CASES) {
    const agent = roster.agentById.get(w2.agent_id);
    if (!agent) throw new Error(`Unknown wave2 agent ${w2.agent_id}`);
    const filePath = path.join(indDir, `${agent.agentId}.jsonl`);
    const existing = readJsonl(filePath);
    if (existing.some((r) => r.case_key === w2.case_key)) {
      individualSkipped += 1;
      continue;
    }
    const row = {
      id: deterministicUuid(`ind:${agent.agentId}:${w2.case_key}`),
      agent_id: agent.agentId,
      team_id: agent.teamId,
      case_key: w2.case_key,
      title: w2.title,
      context_summary: w2.context_summary,
      observation: w2.observation,
      verified_action: w2.verified_action,
      evidence_ref: w2.evidence_ref,
      outcome: w2.outcome,
      severity: w2.severity,
      supersedes_id: w2.supersedes_case_key
        ? deterministicUuid(`ind:${agent.agentId}:${w2.supersedes_case_key}`)
        : null,
      created_at: wave2Iso,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    individualAdded += 1;
  }

  for (const team of roster.teams) {
    const seed = TEAM_SEED_PATTERNS[team.teamId];
    if (!seed) throw new Error(`Missing team seed for ${team.teamId}`);
    const filePath = path.join(teamDir, `${team.teamId}.json`);
    const doc = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf8"))
      : {
          schema_version: "1.0.0",
          team_id: team.teamId,
          team_name: team.name,
          tier: team.tier,
          manager_agent_id: team.managerAgentId,
          updated_at: nowIso,
          patterns: [],
        };
    if (doc.patterns.some((p) => p.pattern_key === seed.pattern_key)) {
      teamSkipped += 1;
    } else {
      doc.patterns.push({
        id: deterministicUuid(`team:${team.teamId}:${seed.pattern_key}`),
        team_id: team.teamId,
        pattern_key: seed.pattern_key,
        title: seed.title,
        standard_playbook: seed.standard_playbook,
        guardrail_rule: seed.guardrail_rule,
        source_case_keys: seed.source_case_keys,
        curated_by: team.managerAgentId,
        supersedes_id: null,
        created_at: nowIso,
      });
      doc.updated_at = nowIso;
      fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      teamAdded += 1;
    }
  }

  for (const w2 of WAVE2_TEAM_PATTERNS) {
    const team = roster.teamById.get(w2.team_id);
    if (!team) throw new Error(`Unknown wave2 team ${w2.team_id}`);
    const filePath = path.join(teamDir, `${team.teamId}.json`);
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (doc.patterns.some((p) => p.pattern_key === w2.pattern_key)) {
      teamSkipped += 1;
      continue;
    }
    doc.patterns.push({
      id: deterministicUuid(`team:${team.teamId}:${w2.pattern_key}`),
      team_id: team.teamId,
      pattern_key: w2.pattern_key,
      title: w2.title,
      standard_playbook: w2.standard_playbook,
      guardrail_rule: w2.guardrail_rule,
      source_case_keys: w2.source_case_keys,
      curated_by: team.managerAgentId,
      supersedes_id: w2.supersedes_pattern_key
        ? deterministicUuid(`team:${team.teamId}:${w2.supersedes_pattern_key}`)
        : null,
      created_at: wave2Iso,
    });
    doc.updated_at = wave2Iso;
    fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    teamAdded += 1;
  }

  const existingReports = readJsonl(REPORTS_PATH);
  let reportsAdded = 0;
  if (!existingReports.some((r) => r.report_code === "RPT-BASELINE-001")) {
    const baseline = {
      id: deterministicUuid("report:RPT-BASELINE-001"),
      report_code: "RPT-BASELINE-001",
      team_id: "central-command",
      author_agent_id: "cmd-synthesizer",
      channel: "founder",
      title: "Neurohands 11-Team / 32-Agent Organization Baseline",
      summary: "Established 11 specialized teams (32 agents) with strictly isolated per-agent JSONL case ledgers, manager-curated per-team major learning ledgers, Central Command task planning, multi-channel report routing, and 3 Final Governance Teams (Health, Security, Audit).",
      metrics: { teams: roster.teams.length, agents: roster.agents.length, governance_teams: 3, connectors: Object.keys(roster.raw.connectors).length },
      delivery_status: "recorded",
      created_at: nowIso,
    };
    fs.appendFileSync(REPORTS_PATH, `${JSON.stringify(baseline)}\n`, "utf8");
    reportsAdded += 1;
  }
  if (!existingReports.some((r) => r.report_code === "RPT-COMPLETE-002")) {
    const completionReport = {
      id: deterministicUuid("report:RPT-COMPLETE-002"),
      report_code: "RPT-COMPLETE-002",
      team_id: "central-command",
      author_agent_id: "cmd-synthesizer",
      channel: "founder",
      title: "Neurohands Full 11-Team / 32-Agent Project Completion & Multi-Platform Sync",
      summary: "Completed multi-agent delegation across Central Command, 7 Operational Teams (including separate Frontline Customer Service vs After-Service & Sales/Marketing), and 3 Final Governance Teams (Health, Security, Audit) with 12/12 live Supabase migrations (0 ERROR / 0 WARN), live /neurohands 11-Team Hub, and synchronized GitHub, Supabase, Railway, LangSmith, and Notion ledgers.",
      metrics: { teams: roster.teams.length, agents: roster.agents.length, individual_cases: 36, team_patterns: 13, supabase_migrations_live: 12, security_advisor_warnings: 0 },
      delivery_status: "recorded",
      created_at: wave2Iso,
    };
    fs.appendFileSync(REPORTS_PATH, `${JSON.stringify(completionReport)}\n`, "utf8");
    reportsAdded += 1;
  }
  const expansionIso = "2026-11-23T11:15:00+07:00";
  if (!existingReports.some((r) => r.report_code === "RPT-EXPANSION-003")) {
    const expansionReport = {
      id: deterministicUuid("report:RPT-EXPANSION-003"),
      report_code: "RPT-EXPANSION-003",
      team_id: "central-command",
      author_agent_id: "cmd-synthesizer",
      channel: "founder",
      title: "Neurohands 11-Team / 35-Agent Specialist Expansion & Host-Aware Domain Routing",
      summary: "Added 3 role-isolated specialist agents (dx-context-wording-specialist in business-dx; web-ux-device-tester and web-color-sync-designer in website-brand-ux) across canonical roster, learning ledgers, UI hub, additive SQL migration, and host-aware www.neurohands.com -> /neurohands#trial-workspace routing without altering existing 11 teams or 32 baseline agents.",
      metrics: { teams: roster.teams.length, agents: roster.agents.length, new_specialists: 3, governance_teams: 3 },
      delivery_status: "recorded",
      created_at: expansionIso,
    };
    fs.appendFileSync(REPORTS_PATH, `${JSON.stringify(expansionReport)}\n`, "utf8");
    reportsAdded += 1;
  }

  fs.writeFileSync(HANDBOOK_PATH, renderHandbook(roster), "utf8");

  let nativeAgentsWritten = 0;
  for (const team of roster.teams) {
    const targetPath = path.join(AGENTS_DIR, `nh-${team.teamId}.md`);
    fs.writeFileSync(targetPath, renderNativeAgentFile(team, roster), "utf8");
    nativeAgentsWritten += 1;
  }

  console.log(JSON.stringify({
    ok: true,
    teams: roster.teams.length,
    agents: roster.agents.length,
    individualAdded,
    individualSkipped,
    teamAdded,
    teamSkipped,
    reportsAdded,
    nativeAgentsWritten,
    handbook: path.relative(REPO_ROOT, HANDBOOK_PATH),
  }, null, 2));
}

main();
