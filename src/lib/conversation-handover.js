"use strict";

const HANDOVER_STATES = Object.freeze({
  AI_ACTIVE: "ai_active",
  AWAITING_APPROVAL: "awaiting_approval",
  HUMAN_TAKEOVER: "human_takeover",
  PAUSED: "paused",
});

const CHANNEL_TYPES = Object.freeze(["web", "line_user", "line_group"]);

const ACTION_TARGET_STATE = Object.freeze({
  request_human: HANDOVER_STATES.HUMAN_TAKEOVER,
  takeover: HANDOVER_STATES.HUMAN_TAKEOVER,
  pause: HANDOVER_STATES.PAUSED,
  stage_approval: HANDOVER_STATES.AWAITING_APPROVAL,
  approve: HANDOVER_STATES.AI_ACTIVE,
  reject: HANDOVER_STATES.AI_ACTIVE,
  resume: HANDOVER_STATES.AI_ACTIVE,
});

function shouldAiReply(state) {
  return !state || state === HANDOVER_STATES.AI_ACTIVE;
}

function nextHandoverState(currentState, action) {
  const target = ACTION_TARGET_STATE[action];
  if (!target) throw new RangeError(`Unsupported handover action: ${action}`);
  const from = currentState || HANDOVER_STATES.AI_ACTIVE;
  if (!Object.values(HANDOVER_STATES).includes(from)) {
    throw new RangeError(`Invalid handover state: ${from}`);
  }
  if ((action === "approve" || action === "reject") && from !== HANDOVER_STATES.AWAITING_APPROVAL) {
    throw new RangeError(`Action '${action}' is only valid from awaiting_approval state`);
  }
  return target;
}

function createHandoverStore({ db }) {
  async function getState(clientAccountId, channelType, threadId) {
    if (!clientAccountId || !CHANNEL_TYPES.includes(channelType) || !threadId) {
      return { state: HANDOVER_STATES.AI_ACTIVE, assigned_human: null, reason: null };
    }
    const rows = await db(
      `nh_conversation_states?client_account_id=eq.${encodeURIComponent(clientAccountId)}&channel_type=eq.${encodeURIComponent(channelType)}&thread_id=eq.${encodeURIComponent(threadId)}&select=*&limit=1`
    );
    return rows?.[0] || {
      client_account_id: clientAccountId,
      channel_type: channelType,
      thread_id: threadId,
      state: HANDOVER_STATES.AI_ACTIVE,
      assigned_human: null,
      reason: null,
    };
  }

  async function transition(clientAccountId, channelType, threadId, action, { actor = null, reason = null, assignedHuman = null } = {}) {
    if (!clientAccountId) throw new RangeError("clientAccountId is required");
    if (!CHANNEL_TYPES.includes(channelType)) throw new RangeError(`Invalid channelType: ${channelType}`);
    if (!threadId || typeof threadId !== "string") throw new RangeError("threadId is required");

    const current = await getState(clientAccountId, channelType, threadId);
    const next = nextHandoverState(current.state, action);
    const body = {
      client_account_id: clientAccountId,
      channel_type: channelType,
      thread_id: threadId,
      state: next,
      assigned_human: next === HANDOVER_STATES.AI_ACTIVE ? null : (assignedHuman ?? current.assigned_human ?? actor),
      reason: next === HANDOVER_STATES.AI_ACTIVE ? null : (reason ?? current.reason ?? action),
      updated_by: actor,
      updated_at: new Date().toISOString(),
    };
    const saved = await db("nh_conversation_states?on_conflict=client_account_id,channel_type,thread_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body,
    });
    return saved?.[0] || body;
  }

  async function listThreads(clientAccountId, limit = 25) {
    if (!clientAccountId) return [];
    const rows = await db(
      `nh_conversation_states?client_account_id=eq.${encodeURIComponent(clientAccountId)}&select=*&order=updated_at.desc&limit=${Math.min(Math.max(Number(limit) || 25, 1), 100)}`
    );
    return rows || [];
  }

  return { getState, transition, listThreads };
}

module.exports = {
  HANDOVER_STATES,
  CHANNEL_TYPES,
  ACTION_TARGET_STATE,
  shouldAiReply,
  nextHandoverState,
  createHandoverStore,
};
