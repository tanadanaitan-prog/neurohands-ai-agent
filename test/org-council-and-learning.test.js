"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { createOrgLearningService, redactPii } = require("../src/lib/org-learning-store");
const { createOrgCouncilRouter } = require("../src/lib/org-council-router");
const { createLangSmithTraceHook } = require("../src/lib/trial-router");
const {
  validateFlexMessage,
  buildOrgRosterFlexCard,
  buildReportFlexCard,
  buildGovernanceAuditFlexCard,
} = require("../src/lib/line-flex-cards");

async function startOrgServer(t, opts = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/org", createOrgCouncilRouter(opts));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test("Production seeded org learning ledgers pass 3-team Health, Security, and Audit governance check and Flex builders tolerate null/partial inputs", async () => {
  const svc = createOrgLearningService();
  const roster = svc.getRosterSummary();
  assert.equal(roster.teamCount, 11);
  assert.equal(roster.agentCount, 35);
  assert.ok(roster.teams.some((t) => t.teamId === "customer-service"));
  assert.ok(roster.teams.some((t) => t.teamId === "after-service"));
  assert.equal(roster.teams.filter((t) => t.tier === "governance").length, 3);
  const webTeam = roster.teams.find((t) => t.teamId === "website-brand-ux");
  const dxTeam = roster.teams.find((t) => t.teamId === "business-dx");
  assert.ok(webTeam.agents.some((a) => a.agentId === "web-ux-device-tester"));
  assert.ok(webTeam.agents.some((a) => a.agentId === "web-color-sync-designer"));
  assert.ok(dxTeam.agents.some((a) => a.agentId === "dx-context-wording-specialist"));

  const audit = await svc.runGovernanceAudit();
  assert.equal(audit.overall_status, "pass");
  assert.equal(audit.health_result.status, "pass");
  assert.equal(audit.security_result.status, "pass");
  assert.equal(audit.audit_result.status, "pass");
  assert.equal(audit.audit_result.details.teamsVerified, 11);
  assert.equal(audit.audit_result.details.agentsVerified, 35);
  assert.equal(audit.audit_result.details.crossAgentContamination, 0);
  assert.equal(audit.audit_result.details.crossTeamContamination, 0);
  assert.equal(audit.audit_result.details.duplicateCaseKeys, 0);
  assert.equal(audit.audit_result.details.duplicatePatternKeys, 0);
  assert.equal(audit.security_result.details.secretLeakHits, 0);

  const externalCard = buildReportFlexCard(
    { report_code: "RPT-101", title: "Group Update", team_id: "line-biz-console", author_agent_id: "line-channel-tester", channel: "line_group", delivery_status: "dispatched", summary: "All LINE channels green." },
    { audience: "external" }
  );
  const externalJson = JSON.stringify(externalCard);
  assert.equal(externalJson.includes("audit: org"), false);
  assert.equal(externalJson.includes("report: read"), false);

  for (const card of [
    buildOrgRosterFlexCard(roster),
    buildOrgRosterFlexCard(null),
    buildOrgRosterFlexCard({ teams: [null, { tier: "governance" }] }),
    externalCard,
    buildReportFlexCard([null, { report_code: "RPT-101", title: "Daily Sync", channel: "founder", delivery_status: "dispatched", summary: "All green." }]),
    buildGovernanceAuditFlexCard(audit),
    buildGovernanceAuditFlexCard(null),
  ]) {
    const check = validateFlexMessage(card);
    assert.equal(check.valid, true, check.errors.join("; "));
  }
});

test("/api/org enforces operator auth, sanitized public roster, isolated learning, PII redaction, channel pinning, allowlist, and non-blocking traces", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nh-org-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const pushed = [];
  const traced = [];
  const apiKey = ["nh", "org", "test", "12345678"].join("-");
  const founderId = "U11111111111111111111111111111111";
  const groupId = "C22222222222222222222222222222222";
  const unregGroupId = "C33333333333333333333333333333333";

  const svc = createOrgLearningService({
    learningDir: path.join(tmpDir, "learning"),
    traceHook: async (ev) => {
      traced.push(ev);
      await new Promise((r) => setTimeout(r, 300));
    },
  });
  const base = await startOrgServer(t, {
    service: svc,
    apiKey,
    founderLineId: founderId,
    isAllowedLineTarget: async (ch, target) => ch === "line_group" && target === groupId,
    pushToLine: async (to, msg) => pushed.push({ to, msg }),
    getRuntimeHealth: async () => ({ ok: true, readiness: "live", dbReachable: true }),
    reportRateLimitMax: 5,
  });

  const pubRosterRes = await fetch(`${base}/api/org/roster`);
  assert.equal(pubRosterRes.status, 200);
  const pubRoster = await pubRosterRes.json();
  assert.equal(pubRoster.teamCount, 11);
  assert.equal(pubRoster.agentCount, 35);
  assert.equal(pubRoster.connectors, undefined);
  assert.equal(pubRoster.teams[0].teamLearningFile, undefined);
  assert.equal(JSON.stringify(pubRoster).includes("darxiaearohhnxiwhcbs"), false);

  const unauth = await fetch(`${base}/api/org/governance/audit`);
  assert.equal(unauth.status, 401);

  const headers = { "content-type": "application/json", "x-api-key": apiKey };
  const fullRoster = await (await fetch(`${base}/api/org/roster/full`, { headers })).json();
  assert.ok(fullRoster.connectors?.supabase?.project_ref);

  const crossMixCamel = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentId: "after-warranty-care",
      caseKey: "CASE-MIX-1",
      title: "Bad cross mix",
      contextSummary: "Attempt to mix agents",
      observation: "Should reject",
      verifiedAction: "Block cross-agent mixing",
    }),
  });
  assert.equal(crossMixCamel.status, 400);

  const crossMixSnake = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent_id: "after-warranty-care",
      caseKey: "CASE-MIX-2",
      title: "Bad snake mix",
      contextSummary: "Attempt to mix agents",
      observation: "Should reject",
      verifiedAction: "Block cross-agent mixing",
    }),
  });
  assert.equal(crossMixSnake.status, 400);

  const badSupersede = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      caseKey: "CASE-UUID-1",
      title: "Invalid supersedesId",
      contextSummary: "Must be UUID",
      observation: "Should return 400",
      verifiedAction: "Reject non-UUID",
      supersedesId: "not-a-uuid",
    }),
  });
  assert.equal(badSupersede.status, 400);

  const syntheticSkToken = ["sk", "a".repeat(24)].join("-");
  const secretLeak = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      caseKey: "CASE-SEC-1",
      title: "Secret leak test",
      contextSummary: `Contains synthetic token ${syntheticSkToken}`,
      observation: "Should block secret",
      verifiedAction: "Reject payload",
    }),
  });
  assert.equal(secretLeak.status, 400);

  const secretCouncil = await fetch(`${base}/api/org/council/plan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command: `Deploy with ${["sb", "secret", "x".repeat(16)].join("_")}` }),
  });
  assert.equal(secretCouncil.status, 400);

  const firstInd = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      caseKey: "CASE-LINE-TEST-001",
      title: "Verify LINE group report delivery",
      contextSummary: "Contact ops@example.com or 081-234-5678 ID 1234567890123",
      observation: "Flex card rendered cleanly without clipping",
      verifiedAction: "Use buildReportFlexCard for LINE channels",
      evidenceRef: "unit-test",
    }),
  });
  assert.equal(firstInd.status, 201);
  const firstIndJson = await firstInd.json();
  assert.equal(firstIndJson.record.context_summary.includes("ops@example.com"), false);
  assert.equal(firstIndJson.record.context_summary.includes("[redacted-email]"), true);
  assert.equal(firstIndJson.record.context_summary.includes("[redacted-phone]"), true);
  assert.equal(firstIndJson.record.context_summary.includes("[redacted-id]"), true);

  const dupInd = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      caseKey: "CASE-LINE-TEST-001",
      title: "Duplicate attempt",
      contextSummary: "Must reject duplicate",
      observation: "Append-only enforced",
      verifiedAction: "Reject 409",
    }),
  });
  assert.equal(dupInd.status, 409);

  const revInd = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      caseKey: "CASE-LINE-TEST-002",
      title: "Verify LINE group report delivery v2",
      contextSummary: "Added channel validation",
      observation: "Malformed target IDs now rejected cleanly",
      verifiedAction: "Validate targetLineId before pushToLine",
      supersedesId: firstIndJson.record.id,
    }),
  });
  assert.equal(revInd.status, 201);

  const otherAgent = await (await fetch(`${base}/api/org/learning/individual/after-warranty-care`, { headers })).json();
  assert.equal(otherAgent.count, 0);
  const sameAgent = await (await fetch(`${base}/api/org/learning/individual/line-channel-tester`, { headers })).json();
  assert.equal(sameAgent.count, 2);

  const unauthCurator = await fetch(`${base}/api/org/learning/team/line-biz-console`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      patternKey: "PAT-TEST-1",
      curatedBy: "after-warranty-care",
      title: "Unauthorized cross-team curation",
      standardPlaybook: "Should not be allowed",
      guardrailRule: "Only team manager or Central Command curates",
    }),
  });
  assert.equal(unauthCurator.status, 403);

  const teamOk = await fetch(`${base}/api/org/learning/team/line-biz-console`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      patternKey: "PAT-TEST-1",
      curatedBy: "line-manager",
      title: "Verified LINE channel report dispatch",
      standardPlaybook: "Validate LINE target IDs and deliver executive Flex cards.",
      guardrailRule: "Never dispatch to unvalidated target strings.",
      sourceCaseKeys: ["CASE-LINE-TEST-001", "CASE-LINE-TEST-002"],
    }),
  });
  assert.equal(teamOk.status, 201);

  const founderHijack = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Hijack attempt",
      summary: "Trying to redirect founder report",
      channel: "founder",
      targetLineId: "U99999999999999999999999999999999",
    }),
  });
  assert.equal(founderHijack.status, 400);

  const wrongPrefix = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Wrong prefix",
      summary: "Passing U ID to line_group",
      channel: "line_group",
      targetLineId: founderId,
    }),
  });
  assert.equal(wrongPrefix.status, 400);

  const unregTarget = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Unregistered group",
      summary: "Not in nh_line_group_bindings",
      channel: "line_group",
      targetLineId: unregGroupId,
    }),
  });
  assert.equal(unregTarget.status, 403);

  const t0 = Date.now();
  const reportRes = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "LINE Group Readiness Report",
      summary: "1:1 and group chats passed all mention and Flex checks.",
      teamId: "line-biz-console",
      authorAgentId: "line-channel-tester",
      channel: "line_group",
      targetLineId: groupId,
    }),
  });
  const elapsedMs = Date.now() - t0;
  assert.equal(reportRes.status, 201);
  assert.ok(elapsedMs < 250, `Expected non-blocking traceHook, took ${elapsedMs}ms`);
  const reportJson = await reportRes.json();
  assert.equal(reportJson.report.delivery_status, "dispatched");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, groupId);
  assert.equal(validateFlexMessage(pushed[0].msg).valid, true);
  assert.equal(JSON.stringify(pushed[0].msg).includes("audit: org"), false);

  const bigMetrics = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Oversized metrics",
      summary: "Should fail validation",
      channel: "web",
      metrics: { huge: "x".repeat(5000) },
    }),
  });
  assert.equal(bigMetrics.status, 400);

  const rateLimited = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Extra", summary: "Exceeds limit", channel: "web" }),
  });
  assert.equal(rateLimited.status, 429);

  assert.ok(traced.length >= 3);
  assert.equal(redactPii("a@b.com"), "[redacted-email]");
});

test("Scrubbed Supabase 409 maps to 409, 503 outage fails closed with 503 before LINE push, and GET vs POST audit persistence behaves cleanly", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nh-org-dbstub-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const auditInserts = [];
  const pushed = [];
  let mode = "conflict";
  const dbStub = async (endpoint, opts = {}) => {
    if (endpoint.startsWith("nh_governance_audits") && opts.method === "POST") {
      auditInserts.push(opts.body);
      return [opts.body];
    }
    if (mode === "conflict" && opts.method === "POST") {
      const err = new Error("Database operation failed");
      err.httpStatus = 409;
      throw err;
    }
    if (mode === "outage") {
      const err = new Error("Database operation failed");
      err.httpStatus = 503;
      err.code = "database_request_failed";
      throw err;
    }
    return [];
  };

  const apiKey = ["nh", "org", "dbstub", "123456"].join("-");
  const svc = createOrgLearningService({ db: dbStub, learningDir: path.join(tmpDir, "learning") });
  const base = await startOrgServer(t, {
    service: svc,
    apiKey,
    founderLineId: "U11111111111111111111111111111111",
    pushToLine: async (to, msg) => pushed.push({ to, msg }),
    getRuntimeHealth: async () => ({ ok: false, readiness: "degraded", dbReachable: false }),
  });
  const headers = { "content-type": "application/json", "x-api-key": apiKey };

  const dup409 = await fetch(`${base}/api/org/learning/individual/line-channel-tester`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      caseKey: "CASE-SCRUB-409",
      title: "Conflict test",
      contextSummary: "Server scrubbed 23505 message",
      observation: "httpStatus=409 should map to 409",
      verifiedAction: "Return 409 instead of 500",
    }),
  });
  assert.equal(dup409.status, 409);

  mode = "outage";
  const outageReport = await fetch(`${base}/api/org/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Outage report",
      summary: "Must not push phantom LINE card during DB 503",
      channel: "founder",
    }),
  });
  assert.equal(outageReport.status, 503);
  assert.equal(pushed.length, 0);

  mode = "ok";
  const getAudit = await (await fetch(`${base}/api/org/governance/audit`, { headers })).json();
  assert.equal(getAudit.audit.health_result.status, "degraded");
  assert.equal(auditInserts.length, 0);

  const postAudit = await fetch(`${base}/api/org/governance/audit`, { method: "POST", headers });
  assert.equal(postAudit.status, 201);
  assert.equal(auditInserts.length, 1);
});

test("LangSmith hook exports real org metadata and governance audit reports overall_status='fail' on secret leak", async (t) => {
  const captured = [];
  const hook = createLangSmithTraceHook({
    apiKey: ["ls", "test", "key"].join("-"),
    project: "neurohands-org",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return { ok: true };
    },
  });
  await hook({ kind: "individual_learning", teamId: "line-biz-console", agentId: "line-channel-tester", caseKey: "CASE-1", outcome: "verified", storage: "supabase" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].name, "neurohands.org_individual_learning");
  assert.equal(captured[0].inputs.team_id, "line-biz-console");
  assert.equal(captured[0].inputs.agent_id, "line-channel-tester");
  assert.equal(captured[0].outputs.ref, "CASE-1");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nh-org-tamper-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const indDir = path.join(tmpDir, "individual");
  fs.mkdirSync(indDir, { recursive: true });
  const syntheticPat = ["ghp", "1".repeat(26)].join("_");
  fs.writeFileSync(
    path.join(indDir, "line-channel-tester.jsonl"),
    `${JSON.stringify({ agent_id: "after-warranty-care", case_key: "BAD-1", title: "Cross mix", observation: syntheticPat })}\n`,
    "utf8"
  );
  const svc = createOrgLearningService({ learningDir: tmpDir });
  const audit = await svc.runGovernanceAudit();
  assert.equal(audit.overall_status, "fail");
  assert.equal(audit.security_result.status, "fail");
  assert.equal(audit.security_result.details.secretLeakHits, 1);
  assert.equal(audit.audit_result.status, "needs_attention");
  assert.equal(audit.audit_result.details.crossAgentContamination, 1);
});

test("/api/org fails closed with 503 when operator API key is not configured", async (t) => {
  const base = await startOrgServer(t, { apiKey: "" });
  const res = await fetch(`${base}/api/org/reports`, { headers: { "x-api-key": "anything" } });
  assert.equal(res.status, 503);
});
