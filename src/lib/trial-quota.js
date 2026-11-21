"use strict";

const DEFAULT_TRIAL_LIMITS = Object.freeze({
  planCode: "trial_free",
  durationDays: 14,
  maxMessages: 200,
  maxActions: 50,
  spendingCapUsd: 0,
});

function formatTrialRejection(reason) {
  switch (reason) {
    case "trial_expired":
      return "Your Neurohands trial period has ended. Please contact your Neurohands representative to activate a production plan.";
    case "message_limit_reached":
      return "Your trial message allowance has been reached. A human operator can still assist you or upgrade your plan.";
    case "action_limit_reached":
      return "Your trial automated action limit has been reached. Please contact support to expand your allowance.";
    case "spending_cap_reached":
      return "Your trial spending cap has been reached. Automated replies are paused until limits are updated.";
    case "trial_paused":
      return "This trial workspace is currently paused. Please contact an administrator to resume.";
    default:
      return "Trial allowance is unavailable for this account. Please contact Neurohands support.";
  }
}

function summarizeTrialRow(row, nowMs = Date.now()) {
  if (!row) {
    return {
      provisioned: false,
      status: "paused",
      planCode: DEFAULT_TRIAL_LIMITS.planCode,
      maxMessages: 0,
      usedMessages: 0,
      remainingMessages: 0,
      maxActions: 0,
      usedActions: 0,
      remainingActions: 0,
      spendingCapUsd: 0,
      spentUsd: 0,
      remainingBudgetUsd: 0,
      daysLeft: 0,
      trialExpiresAt: null,
    };
  }
  const expiresMs = row.trial_expires_at ? Date.parse(row.trial_expires_at) : 0;
  const daysLeft = expiresMs > nowMs ? Math.ceil((expiresMs - nowMs) / 86400000) : 0;
  const maxMessages = Number(row.max_messages ?? 0);
  const usedMessages = Number(row.used_messages ?? 0);
  const maxActions = Number(row.max_actions ?? 0);
  const usedActions = Number(row.used_actions ?? 0);
  const spendingCapUsd = Number(row.spending_cap_usd ?? 0);
  const spentUsd = Number(row.spent_usd ?? 0);
  const computedStatus = row.status === "paused"
    ? "paused"
    : (expiresMs && nowMs >= expiresMs)
      ? "expired"
      : (usedMessages >= maxMessages || usedActions >= maxActions)
        ? "quota_exceeded"
        : row.status || "active";

  return {
    provisioned: true,
    status: computedStatus,
    planCode: row.plan_code || DEFAULT_TRIAL_LIMITS.planCode,
    trialStartsAt: row.trial_starts_at || null,
    trialExpiresAt: row.trial_expires_at || null,
    daysLeft,
    maxMessages,
    usedMessages,
    remainingMessages: Math.max(maxMessages - usedMessages, 0),
    maxActions,
    usedActions,
    remainingActions: Math.max(maxActions - usedActions, 0),
    spendingCapUsd,
    spentUsd,
    remainingBudgetUsd: Math.max(Number((spendingCapUsd - spentUsd).toFixed(4)), 0),
  };
}

function createTrialQuotaService({ db, now = () => Date.now() }) {
  async function getAllowance(clientAccountId) {
    if (!clientAccountId) return summarizeTrialRow(null, now());
    const rows = await db(
      `nh_tenant_trials?client_account_id=eq.${encodeURIComponent(clientAccountId)}&select=*&limit=1`
    );
    return summarizeTrialRow(rows?.[0] || null, now());
  }

  async function provisionTrial(clientAccountId, overrides = {}) {
    if (!clientAccountId) throw new RangeError("clientAccountId is required");
    const durationDays = Math.min(Math.max(Number(overrides.durationDays ?? DEFAULT_TRIAL_LIMITS.durationDays), 1), 90);
    const maxMessages = Math.min(Math.max(Number(overrides.maxMessages ?? DEFAULT_TRIAL_LIMITS.maxMessages), 1), 100000);
    const maxActions = Math.min(Math.max(Number(overrides.maxActions ?? DEFAULT_TRIAL_LIMITS.maxActions), 0), 50000);
    const spendingCapUsd = Math.min(Math.max(Number(overrides.spendingCapUsd ?? DEFAULT_TRIAL_LIMITS.spendingCapUsd), 0), 1000);
    const startsAt = new Date(now());
    const expiresAt = new Date(startsAt.getTime() + durationDays * 86400000);

    const saved = await db("nh_tenant_trials?on_conflict=client_account_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: {
        client_account_id: clientAccountId,
        ...(overrides.ownerEmail ? { owner_email: String(overrides.ownerEmail).trim().toLowerCase() } : {}),
        plan_code: overrides.planCode || DEFAULT_TRIAL_LIMITS.planCode,
        status: "active",
        trial_starts_at: startsAt.toISOString(),
        trial_expires_at: expiresAt.toISOString(),
        max_messages: maxMessages,
        used_messages: 0,
        max_actions: maxActions,
        used_actions: 0,
        spending_cap_usd: spendingCapUsd,
        spent_usd: 0,
      },
    });
    if (saved?.[0]) return summarizeTrialRow(saved[0], now());
    return getAllowance(clientAccountId);
  }

  async function consumeAllowance(clientAccountId, { messages = 1, actions = 0, costUsd = 0 } = {}) {
    if (!clientAccountId) {
      return { allowed: false, reason: "trial_not_found", status: "paused", remaining: summarizeTrialRow(null, now()) };
    }
    const rows = await db("rpc/nh_consume_trial_allowance", {
      method: "POST",
      body: {
        p_client_account_id: Number(clientAccountId),
        p_messages: Math.max(0, Math.trunc(Number(messages) || 0)),
        p_actions: Math.max(0, Math.trunc(Number(actions) || 0)),
        p_cost_usd: Math.max(0, Number(costUsd) || 0),
        p_now: new Date(now()).toISOString(),
      },
    });
    const r = rows?.[0];
    if (!r) {
      return { allowed: false, reason: "trial_not_found", status: "paused", remaining: summarizeTrialRow(null, now()) };
    }
    return {
      allowed: r.allowed === true,
      reason: r.reason || "trial_not_found",
      status: r.status || "paused",
      remaining: {
        remainingMessages: Number(r.remaining_messages ?? 0),
        remainingActions: Number(r.remaining_actions ?? 0),
        remainingBudgetUsd: Number(r.remaining_budget_usd ?? 0),
        trialExpiresAt: r.trial_expires_at || null,
      },
    };
  }

  return { getAllowance, provisionTrial, consumeAllowance };
}

module.exports = {
  DEFAULT_TRIAL_LIMITS,
  formatTrialRejection,
  summarizeTrialRow,
  createTrialQuotaService,
};
