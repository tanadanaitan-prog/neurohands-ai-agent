"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { HANDOVER_STATES, shouldAiReply, createHandoverStore } = require("../src/lib/conversation-handover");
const { createTrialQuotaService } = require("../src/lib/trial-quota");
const { shouldRespondInGroup, stripBotMention, parseGroupBindCommand } = require("../src/lib/line-group-router");
const { DEFAULT_ARIA_WORKFLOW, validateWorkflowSpec, executeWorkflowTurn } = require("../src/lib/workflow-runtime");

function createMemoryDb({ maxMessages = 3, maxActions = 1, spendingCapUsd = 0, expired = false } = {}) {
  const trials = new Map([
    [1, {
      client_account_id: 1,
      plan_code: "trial_free",
      status: "active",
      trial_starts_at: new Date(Date.now() - 86400000).toISOString(),
      trial_expires_at: new Date(Date.now() + (expired ? -3600000 : 14 * 86400000)).toISOString(),
      max_messages: maxMessages,
      used_messages: 0,
      max_actions: maxActions,
      used_actions: 0,
      spending_cap_usd: spendingCapUsd,
      spent_usd: 0,
    }],
  ]);
  const states = new Map();

  async function db(pathStr, options = {}) {
    if (pathStr === "rpc/nh_consume_trial_allowance") {
      const { p_client_account_id, p_messages = 0, p_actions = 0, p_cost_usd = 0, p_now } = options.body;
      const row = trials.get(Number(p_client_account_id));
      if (!row) return [{ allowed: false, reason: "trial_not_found", status: "paused", remaining_messages: 0, remaining_actions: 0, remaining_budget_usd: 0 }];
      if (Date.parse(p_now) >= Date.parse(row.trial_expires_at)) {
        row.status = "expired";
        return [{ allowed: false, reason: "trial_expired", status: "expired", remaining_messages: row.max_messages - row.used_messages, remaining_actions: row.max_actions - row.used_actions, remaining_budget_usd: row.spending_cap_usd - row.spent_usd }];
      }
      if (row.used_messages + p_messages > row.max_messages) {
        row.status = "quota_exceeded";
        return [{ allowed: false, reason: "message_limit_reached", status: "quota_exceeded", remaining_messages: row.max_messages - row.used_messages, remaining_actions: row.max_actions - row.used_actions, remaining_budget_usd: row.spending_cap_usd - row.spent_usd }];
      }
      if (row.used_actions + p_actions > row.max_actions) {
        row.status = "quota_exceeded";
        return [{ allowed: false, reason: "action_limit_reached", status: "quota_exceeded", remaining_messages: row.max_messages - row.used_messages, remaining_actions: row.max_actions - row.used_actions, remaining_budget_usd: row.spending_cap_usd - row.spent_usd }];
      }
      row.used_messages += p_messages;
      row.used_actions += p_actions;
      row.spent_usd += p_cost_usd;
      return [{
        allowed: true,
        reason: "ok",
        status: "active",
        remaining_messages: row.max_messages - row.used_messages,
        remaining_actions: row.max_actions - row.used_actions,
        remaining_budget_usd: row.spending_cap_usd - row.spent_usd,
        trial_expires_at: row.trial_expires_at,
      }];
    }
    if (pathStr.startsWith("nh_conversation_states")) {
      if ((options.method || "GET") === "POST") {
        const b = options.body;
        states.set(`${b.client_account_id}:${b.channel_type}:${b.thread_id}`, { ...b });
        return [{ ...b }];
      }
      const m = pathStr.match(/client_account_id=eq\.(\d+)&channel_type=eq\.([^&]+)&thread_id=eq\.([^&]+)/);
      if (m) {
        const found = states.get(`${m[1]}:${decodeURIComponent(m[2])}:${decodeURIComponent(m[3])}`);
        return found ? [found] : [];
      }
      return [...states.values()];
    }
    return [];
  }
  return { db, trials, states };
}

test("Scenario 1 & 2: website workflow builds quote from scoped catalog and gates discounts/tasks via approval", async () => {
  const { db } = createMemoryDb({ maxMessages: 5, maxActions: 2 });
  const handoverStore = createHandoverStore({ db });
  const trialService = createTrialQuotaService({ db });
  const proposals = [];
  const alerts = [];
  const traces = [];

  const spec = validateWorkflowSpec(DEFAULT_ARIA_WORKFLOW);
  const catalogRows = [
    { product_code: "TMP-CLR-10", glass_name: "Tempered Clear Glass", thickness_mm: 10, price_per_sqft: 120, active: true },
  ];

  const quoteOut = await executeWorkflowTurn({
    spec,
    tenant: { clientAccountId: 1, clientCode: "KNC", operatorLineUserId: "Ufounder1" },
    channelType: "web",
    threadId: "web-session-1",
    message: "Quote 10mm tempered glass 2x3m",
    catalogRows,
    handoverStore,
    trialService,
    traceHook: async (r) => traces.push(r),
  });
  assert.equal(quoteOut.replied, true);
  assert.match(quoteOut.text, /Tempered Clear Glass/);
  assert.match(quoteOut.text, /per current price list/);
  assert.equal(quoteOut.remaining.remainingMessages, 4);
  assert.equal(traces.length, 1);

  const approvalOut = await executeWorkflowTurn({
    spec,
    tenant: { clientAccountId: 1, clientCode: "KNC", operatorLineUserId: "Ufounder1" },
    channelType: "web",
    threadId: "web-session-1",
    message: "Give 15% discount and create order task",
    catalogRows,
    handoverStore,
    trialService,
    proposeNote: async (content, cat, proposer, toolName, toolArgs, accountId) => {
      proposals.push({ content, toolName, toolArgs, accountId });
      return 42;
    },
    notifyHuman: async (a) => alerts.push(a),
  });
  assert.equal(approvalOut.requiresApproval, true);
  assert.equal(approvalOut.proposalId, 42);
  assert.equal(approvalOut.handoverState, HANDOVER_STATES.AWAITING_APPROVAL);
  assert.equal(proposals.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(approvalOut.remaining.remainingActions, 1);
});

test("Scenario 3: LINE group policy silences non-mentioned chatter and responds to @mention or keywords", () => {
  const { nextHandoverState } = require("../src/lib/conversation-handover");
  assert.deepEqual(
    shouldRespondInGroup({ mode: "mention_only", text: "Lunch at 12?", mention: null }),
    { respond: false, reason: "not_mentioned" }
  );
  assert.deepEqual(
    shouldRespondInGroup({ mode: "mention_only", text: "@Neurohands check lead time", mention: { mentionees: [{ isSelf: true }] } }),
    { respond: true, reason: "mentioned" }
  );
  assert.equal(
    shouldRespondInGroup({ mode: "mention_only", text: "@NeurohandsAdmin hello", mention: null }).respond,
    false
  );
  assert.equal(
    shouldRespondInGroup({ mode: "mention_only", text: "@Neurohands hi", mention: { mentionees: [{ isSelf: false }] } }).respond,
    false
  );
  assert.throws(() => nextHandoverState(HANDOVER_STATES.PAUSED, "approve"), /awaiting_approval/);
  assert.equal(stripBotMention("@Neurohands: check lead time"), "check lead time");
  assert.deepEqual(
    shouldRespondInGroup({ mode: "keyword", keywords: ["quote", "ราคา"], text: "ขอราคา tempered 10mm" }),
    { respond: true, reason: "keyword_matched", keyword: "ราคา" }
  );
  assert.equal(shouldRespondInGroup({ mode: "off", text: "@Neurohands hi" }).respond, false);
  assert.equal(parseGroupBindCommand("bind NH-ABCD1234"), "NH-ABCD1234");
  assert.equal(parseGroupBindCommand("hello world"), null);
});

test("Scenario 4 & 5: human pause/takeover silences AI, resume restores AI, trial expiry/quota blocks LLM, and failure pauses safely", async () => {
  const { db } = createMemoryDb({ maxMessages: 2, maxActions: 1 });
  const handoverStore = createHandoverStore({ db });
  const trialService = createTrialQuotaService({ db });
  const alerts = [];

  const handoff = await executeWorkflowTurn({
    spec: DEFAULT_ARIA_WORKFLOW,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    channelType: "line_user",
    threadId: "Ucust1",
    message: "Need human help right now",
    handoverStore,
    trialService,
    notifyHuman: async (a) => alerts.push(a),
  });
  assert.equal(handoff.handedOff, true);
  assert.equal(handoff.handoverState, HANDOVER_STATES.HUMAN_TAKEOVER);
  assert.equal(shouldAiReply(handoff.handoverState), false);

  const suppressed = await executeWorkflowTurn({
    spec: DEFAULT_ARIA_WORKFLOW,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    channelType: "line_user",
    threadId: "Ucust1",
    message: "Are you still there?",
    handoverStore,
    trialService,
    notifyHuman: async (a) => alerts.push(a),
  });
  assert.equal(suppressed.replied, false);
  assert.equal(suppressed.suppressed, true);
  assert.equal(alerts.length, 2);

  await handoverStore.transition(1, "line_user", "Ucust1", "resume", { actor: "Uoperator" });
  const afterResume = await executeWorkflowTurn({
    spec: DEFAULT_ARIA_WORKFLOW,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    channelType: "line_user",
    threadId: "Ucust1",
    message: "What is the lead time?",
    handoverStore,
    trialService,
  });
  assert.equal(afterResume.replied, true);
  assert.match(afterResume.text, /7 days/);

  const second = await executeWorkflowTurn({
    spec: DEFAULT_ARIA_WORKFLOW,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    channelType: "web",
    threadId: "web-2",
    message: "What is the lead time?",
    handoverStore,
    trialService,
  });
  assert.equal(second.remaining.remainingMessages, 0);

  let llmCalls = 0;
  const blocked = await executeWorkflowTurn({
    spec: DEFAULT_ARIA_WORKFLOW,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    channelType: "line_user",
    threadId: "Ucust1",
    message: "One more question",
    handoverStore,
    trialService,
    askModel: async () => { llmCalls += 1; return "should not run"; },
  });
  assert.equal(blocked.blockedByTrial, true);
  assert.equal(blocked.reason, "message_limit_reached");
  assert.equal(llmCalls, 0);

  const failMem = createMemoryDb({ maxMessages: 5 });
  const failHandover = createHandoverStore({ db: failMem.db });
  const failTrial = createTrialQuotaService({ db: failMem.db });
  const failAlerts = [];
  const failed = await executeWorkflowTurn({
    spec: DEFAULT_ARIA_WORKFLOW,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    channelType: "web",
    threadId: "web-err",
    message: "Tell me something custom",
    handoverStore: failHandover,
    trialService: failTrial,
    askModel: async () => { throw new Error("Simulated provider outage"); },
    notifyHuman: async (a) => failAlerts.push(a),
  });
  assert.equal(failed.serviceFailed, true);
  assert.equal(failed.handoverState, HANDOVER_STATES.PAUSED);
  assert.equal(failAlerts.length, 1);
});

test("Custom knowledgeEntries calculate deterministic quotes, disabled tool permissions block execution, and approve/reject resolve awaiting_approval", async () => {
  const { db } = createMemoryDb({ maxMessages: 10, maxActions: 5 });
  const handoverStore = createHandoverStore({ db });
  const trialService = createTrialQuotaService({ db });

  const customSpec = validateWorkflowSpec({
    ...DEFAULT_ARIA_WORKFLOW,
    blocks: ["instructions", "knowledge", "decisions", "quote", "approval_gate", "human_handoff", "reply"],
    allowedTools: ["get_product_info", "create_task", "request_human"],
    knowledgeEntries: [
      { title: "Tempered Clear 10mm", pricePerSqft: 120, content: "Standard architectural tempered glass" },
    ],
  });

  const kbQuote = await executeWorkflowTurn({
    spec: customSpec,
    tenant: { clientAccountId: 1, clientCode: "TRIAL1" },
    channelType: "web",
    threadId: "web-kb-1",
    message: "Quote 10mm tempered glass 2x3m",
    catalogRows: [],
    handoverStore,
    trialService,
  });
  assert.equal(kbQuote.replied, true);
  assert.match(kbQuote.text, /Tempered Clear 10mm/);
  assert.match(kbQuote.text, /7,750 THB/);
  assert.match(kbQuote.text, /per approved knowledge base/);

  const deniedLeadTime = await executeWorkflowTurn({
    spec: customSpec,
    tenant: { clientAccountId: 1, clientCode: "TRIAL1" },
    channelType: "web",
    threadId: "web-kb-1",
    message: "What is the lead time?",
    catalogRows: [],
    handoverStore,
    trialService,
  });
  assert.equal(deniedLeadTime.replied, true);
  assert.doesNotMatch(deniedLeadTime.text, /7 days/);

  const staged = await executeWorkflowTurn({
    spec: customSpec,
    tenant: { clientAccountId: 1, clientCode: "TRIAL1" },
    channelType: "web",
    threadId: "web-kb-1",
    message: "Give 15% discount and create order task",
    handoverStore,
    trialService,
  });
  assert.equal(staged.handoverState, HANDOVER_STATES.AWAITING_APPROVAL);

  const approved = await handoverStore.transition(1, "web", "web-kb-1", "approve", { actor: "owner@trial.example" });
  assert.equal(approved.state, HANDOVER_STATES.AI_ACTIVE);

  await handoverStore.transition(1, "web", "web-kb-1", "stage_approval", { actor: "ARIA" });
  const rejected = await handoverStore.transition(1, "web", "web-kb-1", "reject", { actor: "owner@trial.example" });
  assert.equal(rejected.state, HANDOVER_STATES.AI_ACTIVE);
});
