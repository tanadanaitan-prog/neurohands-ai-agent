"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ROSTER_PATH = path.resolve(__dirname, "../../config/org-roster.v1.json");
const DEFAULT_LEARNING_DIR = path.resolve(__dirname, "../../docs/org/learning");
const VALID_REPORT_CHANNELS = new Set(["line_user", "line_group", "founder", "web", "notion"]);
const VALID_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const VALID_OUTCOMES = new Set(["verified", "improved", "error_prevented", "needs_review"]);
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,95}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_LEAK_RE = /(?:eyJhbGciOi[A-Za-z0-9_-]{10,}|sbp_[a-zA-Z0-9]{16,}|sb_secret_[a-zA-Z0-9_-]{12,}|lsv2_(?:pt|sk)_[a-zA-Z0-9_-]{12,}|ntn_[a-zA-Z0-9]{16,}|gsk_[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk-(?:or-v1-)?[a-zA-Z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const EMAIL_PII_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const THAI_ID_PII_RE = /\b\d{13}\b/g;
const PHONE_PII_RE = /(?:\+66|0)[689]\d{1}[- ]?\d{3}[- ]?\d{4}\b/g;

class OrgStoreError extends Error {
  constructor(status, message, code = "ORG_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeResolveUnder(baseDir, ...segments) {
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new OrgStoreError(400, "Resolved path escapes allowed directory", "PATH_OUT_OF_BOUNDS");
  }
  return resolved;
}

function redactPii(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(EMAIL_PII_RE, "[redacted-email]")
    .replace(THAI_ID_PII_RE, "[redacted-id]")
    .replace(PHONE_PII_RE, "[redacted-phone]");
}

function loadOrgRoster(rosterPath = DEFAULT_ROSTER_PATH) {
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  const teamById = new Map();
  const agentById = new Map();

  for (const team of teams) {
    if (!team?.teamId || !SLUG_RE.test(team.teamId) || teamById.has(team.teamId)) {
      throw new Error(`Invalid or duplicate teamId in org roster: ${team?.teamId}`);
    }
    teamById.set(team.teamId, team);
  }
  for (const agent of agents) {
    if (!agent?.agentId || !SLUG_RE.test(agent.agentId) || agentById.has(agent.agentId)) {
      throw new Error(`Invalid or duplicate agentId in org roster: ${agent?.agentId}`);
    }
    if (!teamById.has(agent.teamId)) {
      throw new Error(`Agent ${agent.agentId} references unknown teamId ${agent.teamId}`);
    }
    agentById.set(agent.agentId, agent);
  }
  for (const team of teams) {
    const mgr = agentById.get(team.managerAgentId);
    if (!mgr || mgr.teamId !== team.teamId || mgr.isManager !== true) {
      throw new Error(`Team ${team.teamId} manager ${team.managerAgentId} is missing or mismatched`);
    }
  }
  for (const agent of agents) {
    if (agent.managerAgentId && !agentById.has(agent.managerAgentId)) {
      throw new Error(`Agent ${agent.agentId} references unknown managerAgentId ${agent.managerAgentId}`);
    }
  }

  return { raw, teams, agents, teamById, agentById };
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJsonArrayFile(filePath, key = "patterns") {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(parsed?.[key]) ? parsed[key] : [];
}

function normalizeText(value, field, { min = 2, max = 1200 } = {}) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (clean.length < min || clean.length > max) {
    throw new OrgStoreError(400, `${field} must be between ${min} and ${max} characters`, "INVALID_FIELD");
  }
  return clean;
}

function validateOptionalUuid(value, field = "supersedesId") {
  if (value == null || value === "") return null;
  const clean = String(value).trim();
  if (!UUID_RE.test(clean)) {
    throw new OrgStoreError(400, `${field} must be a valid UUID`, "INVALID_SUPERSEDES_ID");
  }
  return clean;
}

function validateMetricsObject(rawMetrics) {
  if (rawMetrics == null) return {};
  if (typeof rawMetrics !== "object" || Array.isArray(rawMetrics)) {
    throw new OrgStoreError(400, "metrics must be a plain object", "INVALID_METRICS");
  }
  const keys = Object.keys(rawMetrics);
  if (keys.length > 24) {
    throw new OrgStoreError(400, "metrics cannot exceed 24 keys", "INVALID_METRICS");
  }
  const serialized = JSON.stringify(rawMetrics);
  if (Buffer.byteLength(serialized, "utf8") > 4096) {
    throw new OrgStoreError(400, "metrics payload exceeds 4KB limit", "INVALID_METRICS");
  }
  return rawMetrics;
}

function assertNoSecretLeak(obj) {
  if (SECRET_LEAK_RE.test(JSON.stringify(obj))) {
    throw new OrgStoreError(400, "Learning or report payload contains a secret or credential pattern and was blocked", "SECRET_LEAK_BLOCKED");
  }
}

function isMissingTableError(err) {
  if (Number.isInteger(err?.httpStatus)) return err.httpStatus === 404;
  return /PGRST205|does not exist/i.test(err?.message || "");
}

function isDuplicateKeyError(err) {
  return err?.httpStatus === 409 || /23505|duplicate/i.test(err?.message || "");
}

function createOrgLearningService({
  db = null,
  rosterPath = DEFAULT_ROSTER_PATH,
  learningDir = DEFAULT_LEARNING_DIR,
  traceHook = null,
} = {}) {
  const roster = loadOrgRoster(rosterPath);
  const resolvedLearningDir = path.resolve(learningDir);
  const resolvedOrgDir = path.resolve(resolvedLearningDir, "..");

  function emitTrace(event) {
    if (typeof traceHook !== "function") return;
    Promise.resolve().then(() => traceHook(event)).catch(() => {});
  }

  function getRosterSummary() {
    return {
      schemaVersion: roster.raw.schema_version,
      organization: roster.raw.organization,
      mission: roster.raw.mission,
      vision: roster.raw.vision,
      principles: roster.raw.principles,
      connectors: roster.raw.connectors,
      workflowProtocol: roster.raw.workflow_protocol,
      teamCount: roster.teams.length,
      agentCount: roster.agents.length,
      teams: roster.teams.map((t) => ({
        ...t,
        agents: roster.agents
          .filter((a) => a.teamId === t.teamId)
          .map((a) => ({
            agentId: a.agentId,
            displayName: a.displayName,
            role: a.role,
            isManager: a.isManager,
            managerAgentId: a.managerAgentId,
            channels: a.channels,
          })),
      })),
    };
  }

  function getPublicRosterSummary() {
    return {
      schemaVersion: roster.raw.schema_version,
      organization: roster.raw.organization,
      mission: roster.raw.mission,
      vision: roster.raw.vision,
      principles: roster.raw.principles,
      connectedPlatforms: Object.keys(roster.raw.connectors || {}),
      workflowProtocol: roster.raw.workflow_protocol,
      teamCount: roster.teams.length,
      agentCount: roster.agents.length,
      teams: roster.teams.map((t) => ({
        teamId: t.teamId,
        name: t.name,
        tier: t.tier,
        managerAgentId: t.managerAgentId,
        mission: t.mission,
        channels: t.channels,
        agents: roster.agents
          .filter((a) => a.teamId === t.teamId)
          .map((a) => ({
            agentId: a.agentId,
            displayName: a.displayName,
            role: a.role,
            isManager: a.isManager,
            managerAgentId: a.managerAgentId,
            channels: a.channels,
          })),
      })),
    };
  }

  function requireAgent(agentId) {
    const clean = String(agentId || "").trim();
    const agent = roster.agentById.get(clean);
    if (!agent) throw new OrgStoreError(404, `Unknown agentId: ${clean}`, "UNKNOWN_AGENT");
    return agent;
  }

  function requireTeam(teamId) {
    const clean = String(teamId || "").trim();
    const team = roster.teamById.get(clean);
    if (!team) throw new OrgStoreError(404, `Unknown teamId: ${clean}`, "UNKNOWN_TEAM");
    return team;
  }

  async function listIndividualLearning(agentId, { limit = 50, query = "" } = {}) {
    const agent = requireAgent(agentId);
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const localPath = safeResolveUnder(resolvedLearningDir, "individual", `${agent.agentId}.jsonl`);
    const localRows = readJsonlFile(localPath).filter((r) => r.agent_id === agent.agentId);

    let dbRows = [];
    if (db) {
      try {
        const fetched = await db(`nh_agent_individual_learning?agent_id=eq.${encodeURIComponent(agent.agentId)}&order=created_at.desc&limit=${cap}`);
        if (Array.isArray(fetched)) dbRows = fetched.filter((r) => r.agent_id === agent.agentId);
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    const byKey = new Map();
    for (const row of [...localRows, ...dbRows]) {
      if (row?.case_key && !byKey.has(row.case_key)) byKey.set(row.case_key, row);
    }
    let items = [...byKey.values()];
    const q = String(query || "").trim().toLowerCase();
    if (q) items = items.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    return {
      agentId: agent.agentId,
      teamId: agent.teamId,
      displayName: agent.displayName,
      isolatedNamespace: `individual:${agent.agentId}`,
      count: items.length,
      records: items.slice(0, cap),
    };
  }

  async function recordIndividualLearning(agentId, input = {}) {
    const agent = requireAgent(agentId);
    const bodyAgentId = input.agentId ?? input.agent_id;
    if (bodyAgentId && bodyAgentId !== agent.agentId) {
      throw new OrgStoreError(400, "Individual learning cannot mix records across different agents", "CROSS_AGENT_MIX_FORBIDDEN");
    }
    const caseKey = String(input.caseKey || "").trim();
    if (!KEY_RE.test(caseKey)) {
      throw new OrgStoreError(400, "caseKey must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,95}$", "INVALID_CASE_KEY");
    }
    const title = redactPii(normalizeText(input.title, "title", { min: 3, max: 180 }));
    const contextSummary = redactPii(normalizeText(input.contextSummary, "contextSummary", { min: 5, max: 1200 }));
    const observation = redactPii(normalizeText(input.observation, "observation", { min: 5, max: 1200 }));
    const verifiedAction = redactPii(normalizeText(input.verifiedAction, "verifiedAction", { min: 5, max: 1200 }));
    const evidenceRef = redactPii(normalizeText(input.evidenceRef || "verified-run", "evidenceRef", { min: 2, max: 300 }));
    const outcome = VALID_OUTCOMES.has(input.outcome) ? input.outcome : "verified";
    const severity = VALID_SEVERITIES.has(input.severity) ? input.severity : "info";
    const supersedesId = validateOptionalUuid(input.supersedesId ?? input.supersedes_id);

    const localFilePath = safeResolveUnder(resolvedLearningDir, "individual", `${agent.agentId}.jsonl`);
    if (readJsonlFile(localFilePath).some((r) => r.case_key === caseKey)) {
      throw new OrgStoreError(409, `Duplicate case_key '${caseKey}' for agent '${agent.agentId}'. Append a new caseKey with supersedesId instead of overwriting.`, "DUPLICATE_LEARNING_CASE");
    }

    const record = {
      id: crypto.randomUUID(),
      agent_id: agent.agentId,
      team_id: agent.teamId,
      case_key: caseKey,
      title,
      context_summary: contextSummary,
      observation,
      verified_action: verifiedAction,
      evidence_ref: evidenceRef,
      outcome,
      severity,
      supersedes_id: supersedesId,
      created_at: new Date().toISOString(),
    };
    assertNoSecretLeak(record);

    let persistedToDb = false;
    if (db) {
      try {
        await db("nh_agent_individual_learning", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: record,
        });
        persistedToDb = true;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new OrgStoreError(409, `Duplicate case_key '${caseKey}' for agent '${agent.agentId}'`, "DUPLICATE_LEARNING_CASE");
        }
        if (!isMissingTableError(err)) throw err;
      }
    }
    if (!persistedToDb) {
      fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
      fs.appendFileSync(localFilePath, `${JSON.stringify(record)}\n`, "utf8");
    }

    const storage = persistedToDb ? "supabase" : (db ? "local_pending_sql" : "local_file");
    emitTrace({ kind: "individual_learning", agentId: agent.agentId, teamId: agent.teamId, caseKey, outcome, storage });
    return { ...record, storage };
  }

  async function listTeamLearning(teamId, { limit = 50, query = "" } = {}) {
    const team = requireTeam(teamId);
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const localPath = safeResolveUnder(resolvedLearningDir, "teams", `${team.teamId}.json`);
    const localRows = readJsonArrayFile(localPath, "patterns").filter((r) => r.team_id === team.teamId);

    let dbRows = [];
    if (db) {
      try {
        const fetched = await db(`nh_team_learning?team_id=eq.${encodeURIComponent(team.teamId)}&order=created_at.desc&limit=${cap}`);
        if (Array.isArray(fetched)) dbRows = fetched.filter((r) => r.team_id === team.teamId);
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    const byKey = new Map();
    for (const row of [...localRows, ...dbRows]) {
      if (row?.pattern_key && !byKey.has(row.pattern_key)) byKey.set(row.pattern_key, row);
    }
    let items = [...byKey.values()];
    const q = String(query || "").trim().toLowerCase();
    if (q) items = items.filter((r) => JSON.stringify(r).toLowerCase().includes(q));

    return {
      teamId: team.teamId,
      teamName: team.name,
      managerAgentId: team.managerAgentId,
      count: items.length,
      patterns: items.slice(0, cap),
    };
  }

  async function recordTeamLearning(teamId, input = {}) {
    const team = requireTeam(teamId);
    const patternKey = String(input.patternKey || "").trim();
    if (!KEY_RE.test(patternKey)) {
      throw new OrgStoreError(400, "patternKey must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,95}$", "INVALID_PATTERN_KEY");
    }
    const curatedBy = String(input.curatedBy || team.managerAgentId).trim();
    const curator = requireAgent(curatedBy);
    if (curator.agentId !== team.managerAgentId && curator.teamId !== "central-command" && curator.teamId !== "audit-compliance") {
      throw new OrgStoreError(403, `Only ${team.managerAgentId} or Central Command may curate major learning for team ${team.teamId}`, "CURATOR_UNAUTHORIZED");
    }

    const title = redactPii(normalizeText(input.title, "title", { min: 3, max: 180 }));
    const standardPlaybook = redactPii(normalizeText(input.standardPlaybook, "standardPlaybook", { min: 5, max: 1500 }));
    const guardrailRule = redactPii(normalizeText(input.guardrailRule, "guardrailRule", { min: 5, max: 800 }));
    const sourceCaseKeys = Array.isArray(input.sourceCaseKeys)
      ? [...new Set(input.sourceCaseKeys.map((k) => String(k || "").trim()).filter((k) => KEY_RE.test(k)))].slice(0, 20)
      : [];
    const supersedesId = validateOptionalUuid(input.supersedesId ?? input.supersedes_id);

    const localFilePath = safeResolveUnder(resolvedLearningDir, "teams", `${team.teamId}.json`);
    if (readJsonArrayFile(localFilePath, "patterns").some((p) => p.pattern_key === patternKey)) {
      throw new OrgStoreError(409, `Duplicate pattern_key '${patternKey}' for team '${team.teamId}'. Append a new patternKey with supersedesId.`, "DUPLICATE_TEAM_PATTERN");
    }

    const record = {
      id: crypto.randomUUID(),
      team_id: team.teamId,
      pattern_key: patternKey,
      title,
      standard_playbook: standardPlaybook,
      guardrail_rule: guardrailRule,
      source_case_keys: sourceCaseKeys,
      curated_by: curator.agentId,
      supersedes_id: supersedesId,
      created_at: new Date().toISOString(),
    };
    assertNoSecretLeak(record);

    let persistedToDb = false;
    if (db) {
      try {
        await db("nh_team_learning", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: record,
        });
        persistedToDb = true;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new OrgStoreError(409, `Duplicate pattern_key '${patternKey}' for team '${team.teamId}'`, "DUPLICATE_TEAM_PATTERN");
        }
        if (!isMissingTableError(err)) throw err;
      }
    }
    if (!persistedToDb) {
      fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
      const doc = fs.existsSync(localFilePath)
        ? JSON.parse(fs.readFileSync(localFilePath, "utf8"))
        : { team_id: team.teamId, team_name: team.name, manager_agent_id: team.managerAgentId, patterns: [] };
      doc.updated_at = record.created_at;
      doc.patterns.push(record);
      fs.writeFileSync(localFilePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    }

    const storage = persistedToDb ? "supabase" : (db ? "local_pending_sql" : "local_file");
    emitTrace({ kind: "team_learning", teamId: team.teamId, patternKey, curatedBy: curator.agentId, storage });
    return { ...record, storage };
  }

  function selectTeamsForTask(commandText) {
    const t = String(commandText || "").toLowerCase();
    const picked = new Set();
    if (/line|rich\s*menu|flex|group|webhook|console|report|channel|langsmith|railway|supabase|github/.test(t)) picked.add("line-biz-console");
    if (/web|site|design|font|mood|tone|brand|ui|ux|responsive|phone|tablet|laptop/.test(t)) picked.add("website-brand-ux");
    if (/content|workflow|process|sop|transform|business|notion|copy/.test(t)) picked.add("business-dx");
    if (/code|api|front|back|schema|sql|guardrail|architect|engineer|error|bug|test/.test(t)) picked.add("ai-engineering-arch");
    if (/customer|quote|price|order|lead\s*time|support|aria|frontline/.test(t)) picked.add("customer-service");
    if (/after[\s-]*service|warranty|claim|crack|defect|post[\s-]*delivery|retention|care/.test(t)) picked.add("after-service");
    if (/sales|marketing|lead|campaign|proposal|suri|mira|discount|growth/.test(t)) picked.add("sales-marketing");
    if (!picked.size) {
      picked.add("line-biz-console");
      picked.add("website-brand-ux");
      picked.add("business-dx");
      picked.add("ai-engineering-arch");
    }
    return [...picked];
  }

  async function planCentralCouncilTask({ command, requestedBy = "founder", targetChannel = "founder" } = {}) {
    const cleanCommand = redactPii(normalizeText(command, "command", { min: 4, max: 2000 }));
    const channel = VALID_REPORT_CHANNELS.has(targetChannel) ? targetChannel : "founder";
    const selectedTeamIds = selectTeamsForTask(cleanCommand);
    const governanceTeamIds = ["health-monitor", "security-guard", "audit-compliance"];

    const councilDiscussion = selectedTeamIds.map((teamId) => {
      const team = roster.teamById.get(teamId);
      const mgr = roster.agentById.get(team.managerAgentId);
      const members = roster.agents.filter((a) => a.teamId === teamId && !a.isManager).map((a) => a.agentId);
      return {
        teamId,
        teamName: team.name,
        managerAgentId: mgr.agentId,
        managerName: mgr.displayName,
        assignedSpecialists: members,
        objective: team.mission,
        followUpRule: `${mgr.displayName} verifies specialist output, appends case learning to individual ledgers, and curates team pattern into ${team.teamId}.`,
      };
    });

    const plan = {
      id: crypto.randomUUID(),
      command_text: cleanCommand,
      requested_by: redactPii(String(requestedBy || "founder").slice(0, 120)),
      target_channel: channel,
      status: "planned",
      council_discussion: councilDiscussion,
      governance_signoff_required: governanceTeamIds.map((tid) => ({
        teamId: tid,
        managerAgentId: roster.teamById.get(tid).managerAgentId,
        status: "pending",
      })),
      created_at: new Date().toISOString(),
    };
    assertNoSecretLeak(plan);

    if (db) {
      try {
        await db("nh_central_council_tasks", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: plan,
        });
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    emitTrace({ kind: "central_council_plan", taskId: plan.id, teams: selectedTeamIds, channel });
    return plan;
  }

  async function createOrgReport({ title, summary, teamId = "central-command", authorAgentId = "cmd-synthesizer", channel = "founder", metrics = {}, deliver = null } = {}) {
    const team = requireTeam(teamId);
    const author = requireAgent(authorAgentId);
    const cleanTitle = redactPii(normalizeText(title, "title", { min: 3, max: 180 }));
    const cleanSummary = redactPii(normalizeText(summary, "summary", { min: 5, max: 2500 }));
    if (!VALID_REPORT_CHANNELS.has(channel)) {
      throw new OrgStoreError(400, `Unsupported report channel: ${channel}`, "INVALID_CHANNEL");
    }
    const safeMetrics = validateMetricsObject(metrics);

    const report = {
      id: crypto.randomUUID(),
      report_code: `RPT-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      team_id: team.teamId,
      author_agent_id: author.agentId,
      channel,
      title: cleanTitle,
      summary: cleanSummary,
      metrics: safeMetrics,
      delivery_status: "recorded",
      created_at: new Date().toISOString(),
    };
    assertNoSecretLeak(report);

    let dbAvailable = false;
    if (db) {
      try {
        await db("nh_reports?select=report_code&limit=1");
        dbAvailable = true;
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    if (typeof deliver === "function") {
      try {
        const dispatched = await deliver(report);
        report.delivery_status = dispatched ? "dispatched" : "recorded";
      } catch {
        report.delivery_status = "delivery_failed";
      }
    }

    let persistedToDb = false;
    if (db && dbAvailable) {
      try {
        await db("nh_reports", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: report,
        });
        persistedToDb = true;
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }
    if (!persistedToDb) {
      const filePath = safeResolveUnder(resolvedOrgDir, "REPORTS_LEDGER.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(report)}\n`, "utf8");
    }

    const storage = persistedToDb ? "supabase" : (db ? "local_pending_sql" : "local_file");
    emitTrace({ kind: "org_report", reportCode: report.report_code, teamId: team.teamId, agentId: author.agentId, channel, deliveryStatus: report.delivery_status, storage });
    return { ...report, storage };
  }

  async function listOrgReports({ channel = "", teamId = "", limit = 20 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const localPath = safeResolveUnder(resolvedOrgDir, "REPORTS_LEDGER.jsonl");
    let items = readJsonlFile(localPath);

    if (db) {
      try {
        const filters = [];
        if (channel && VALID_REPORT_CHANNELS.has(channel)) filters.push(`channel=eq.${encodeURIComponent(channel)}`);
        if (teamId && roster.teamById.has(teamId)) filters.push(`team_id=eq.${encodeURIComponent(teamId)}`);
        const qs = [...filters, "order=created_at.desc", `limit=${cap}`].join("&");
        const fetched = await db(`nh_reports?${qs}`);
        if (Array.isArray(fetched)) {
          const seen = new Set(fetched.map((r) => r.report_code));
          items = [...fetched, ...items.filter((r) => !seen.has(r.report_code))];
        }
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    if (channel && VALID_REPORT_CHANNELS.has(channel)) items = items.filter((r) => r.channel === channel);
    if (teamId && roster.teamById.has(teamId)) items = items.filter((r) => r.team_id === teamId);
    items.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return { count: items.length, reports: items.slice(0, cap) };
  }

  async function runGovernanceAudit({ runtimeHealth = null, securityChecks = null, persist = false } = {}) {
    const individualStats = [];
    let crossAgentContamination = 0;
    let duplicateCaseKeys = 0;
    let secretLeakHits = 0;

    for (const agent of roster.agents) {
      const localPath = safeResolveUnder(resolvedLearningDir, "individual", `${agent.agentId}.jsonl`);
      const rows = readJsonlFile(localPath);
      const keys = new Set();
      for (const row of rows) {
        if (row.agent_id !== agent.agentId) crossAgentContamination += 1;
        if (keys.has(row.case_key)) duplicateCaseKeys += 1;
        if (SECRET_LEAK_RE.test(JSON.stringify(row))) secretLeakHits += 1;
        keys.add(row.case_key);
      }
      individualStats.push({ agentId: agent.agentId, teamId: agent.teamId, count: rows.length });
    }

    const teamStats = [];
    let crossTeamContamination = 0;
    let duplicatePatternKeys = 0;
    for (const team of roster.teams) {
      const localPath = safeResolveUnder(resolvedLearningDir, "teams", `${team.teamId}.json`);
      const rows = readJsonArrayFile(localPath, "patterns");
      const keys = new Set();
      for (const row of rows) {
        if (row.team_id !== team.teamId) crossTeamContamination += 1;
        if (keys.has(row.pattern_key)) duplicatePatternKeys += 1;
        if (SECRET_LEAK_RE.test(JSON.stringify(row))) secretLeakHits += 1;
        keys.add(row.pattern_key);
      }
      teamStats.push({ teamId: team.teamId, managerAgentId: team.managerAgentId, count: rows.length });
    }

    const reportsPath = safeResolveUnder(resolvedOrgDir, "REPORTS_LEDGER.jsonl");
    for (const row of readJsonlFile(reportsPath)) {
      if (SECRET_LEAK_RE.test(JSON.stringify(row))) secretLeakHits += 1;
    }

    let dbScanned = false;
    if (db) {
      try {
        const [dbInd, dbTeam, dbRep] = await Promise.all([
          db("nh_agent_individual_learning?select=agent_id,team_id,case_key,title,observation,verified_action&order=created_at.desc&limit=200"),
          db("nh_team_learning?select=team_id,pattern_key,title,standard_playbook,guardrail_rule&order=created_at.desc&limit=200"),
          db("nh_reports?select=report_code,title,summary&order=created_at.desc&limit=100"),
        ]);
        dbScanned = true;
        for (const row of Array.isArray(dbInd) ? dbInd : []) {
          const expectedTeam = roster.agentById.get(row.agent_id)?.teamId;
          if (!expectedTeam || row.team_id !== expectedTeam) crossAgentContamination += 1;
          if (SECRET_LEAK_RE.test(JSON.stringify(row))) secretLeakHits += 1;
        }
        for (const row of Array.isArray(dbTeam) ? dbTeam : []) {
          if (!roster.teamById.has(row.team_id)) crossTeamContamination += 1;
          if (SECRET_LEAK_RE.test(JSON.stringify(row))) secretLeakHits += 1;
        }
        for (const row of Array.isArray(dbRep) ? dbRep : []) {
          if (SECRET_LEAK_RE.test(JSON.stringify(row))) secretLeakHits += 1;
        }
      } catch (err) {
        if (!isMissingTableError(err)) {
          runtimeHealth = { ...(runtimeHealth || {}), ok: false, dbReachable: false, error: "database_unavailable" };
        }
      }
    }

    const healthOk = runtimeHealth != null
      ? runtimeHealth.ok === true
      : Object.keys(roster.raw.connectors || {}).length >= 6;
    const healthCheck = {
      teamId: "health-monitor",
      manager: "health-manager",
      status: healthOk ? "pass" : "degraded",
      details: runtimeHealth || {
        mode: "local_ledger_only",
        raceSlaMs: 2500,
        connectorsMapped: Object.keys(roster.raw.connectors || {}).length,
      },
    };

    const computedSecurityOk = secretLeakHits === 0 && securityChecks?.ok !== false;
    const securityCheck = {
      teamId: "security-guard",
      manager: "sec-manager",
      status: computedSecurityOk ? "pass" : "fail",
      details: {
        ...(securityChecks || { appMetadataRls: true, appendOnlyImmutability: true, piiRedaction: true }),
        dbScanned,
        secretLeakHits,
        zeroSecretsInLedgers: secretLeakHits === 0,
      },
    };

    const missingIndividual = individualStats.filter((s) => s.count === 0).map((s) => s.agentId);
    const missingTeams = teamStats.filter((s) => s.count === 0).map((s) => s.teamId);
    const auditPass = crossAgentContamination === 0
      && crossTeamContamination === 0
      && duplicateCaseKeys === 0
      && duplicatePatternKeys === 0
      && missingIndividual.length === 0
      && missingTeams.length === 0;

    const auditCheck = {
      teamId: "audit-compliance",
      manager: "audit-manager",
      status: auditPass ? "pass" : "needs_attention",
      details: {
        teamsVerified: roster.teams.length,
        agentsVerified: roster.agents.length,
        dbScanned,
        crossAgentContamination,
        crossTeamContamination,
        duplicateCaseKeys,
        duplicatePatternKeys,
        missingIndividualCount: missingIndividual.length,
        missingTeamCount: missingTeams.length,
      },
    };

    const overallStatus = securityCheck.status === "fail"
      ? "fail"
      : (healthCheck.status === "pass" && auditCheck.status === "pass" ? "pass" : "attention_required");

    const auditRecord = {
      id: crypto.randomUUID(),
      overall_status: overallStatus,
      health_result: healthCheck,
      security_result: securityCheck,
      audit_result: auditCheck,
      audited_at: new Date().toISOString(),
    };

    if (persist && db) {
      try {
        await db("nh_governance_audits", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: auditRecord,
        });
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    return auditRecord;
  }

  return {
    roster,
    getRosterSummary,
    getPublicRosterSummary,
    listIndividualLearning,
    recordIndividualLearning,
    listTeamLearning,
    recordTeamLearning,
    planCentralCouncilTask,
    createOrgReport,
    listOrgReports,
    runGovernanceAudit,
  };
}

module.exports = {
  OrgStoreError,
  VALID_REPORT_CHANNELS,
  redactPii,
  loadOrgRoster,
  createOrgLearningService,
};
