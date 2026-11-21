"use strict";

const { isFreshRecord } = require("./document-parser");
const { calculateEdgingCost } = require("./liff-builder");
const { HANDOVER_STATES, shouldAiReply } = require("./conversation-handover");
const { formatTrialRejection } = require("./trial-quota");
const { normalizeGroupPolicy } = require("./line-group-router");

const BLOCK_CATALOG = Object.freeze([
  { id: "instructions", stage: "instructions", label: "Role & Instructions" },
  { id: "knowledge", stage: "knowledge", label: "Price List & Knowledge Base" },
  { id: "decisions", stage: "decisions", label: "Intent & Guardrail Decisions" },
  { id: "quote", stage: "actions", label: "Deterministic Price Quote" },
  { id: "lead_time", stage: "actions", label: "Lead Time & Order Check" },
  { id: "create_task", stage: "actions", label: "Create Follow-Up Task" },
  { id: "approval_gate", stage: "decisions", label: "Human Approval Gate" },
  { id: "human_handoff", stage: "actions", label: "Human Takeover Handoff" },
  { id: "reply", stage: "replies", label: "Customer Reply Formatter" },
]);

const VALID_BLOCK_IDS = new Set(BLOCK_CATALOG.map((b) => b.id));
const VALID_TOOLS = new Set(["get_product_info", "get_edging_info", "get_lead_time", "get_order_status", "create_task", "request_human"]);
const VALID_STYLES = new Set(["concise", "warm", "formal"]);

const DEFAULT_ARIA_WORKFLOW = Object.freeze({
  agentCode: "ARIA",
  name: "Aria",
  role: "Aria — Customer Service & Quotes",
  instructions: "Answer product, price, and lead-time questions strictly from approved company knowledge. Never invent discounts or alter orders without human approval.",
  blocks: ["instructions", "knowledge", "decisions", "quote", "lead_time", "approval_gate", "human_handoff", "reply"],
  allowedTools: ["get_product_info", "get_edging_info", "get_lead_time", "get_order_status", "create_task", "request_human"],
  approvalRequiredTools: ["create_task"],
  replyStyle: "warm",
  knowledgeEntries: [],
  groupPolicy: { mode: "mention_only", keywords: ["quote", "price", "ราคา", "lead time"] },
});

function validateWorkflowSpec(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RangeError("Workflow specification must be an object");
  }
  const agentCode = String(raw.agentCode || DEFAULT_ARIA_WORKFLOW.agentCode).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40);
  const name = String(raw.name || DEFAULT_ARIA_WORKFLOW.name).trim().slice(0, 100);
  const role = String(raw.role || DEFAULT_ARIA_WORKFLOW.role).trim().slice(0, 80);
  const instructions = String(raw.instructions ?? DEFAULT_ARIA_WORKFLOW.instructions).trim().slice(0, 2000);
  if (!agentCode || !name || !role || !instructions) {
    throw new RangeError("agentCode, name, role, and instructions are required");
  }

  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : DEFAULT_ARIA_WORKFLOW.blocks;
  const blocks = [...new Set(rawBlocks.map((b) => String(b || "").trim()).filter((b) => VALID_BLOCK_IDS.has(b)))];
  if (!blocks.includes("instructions") || !blocks.includes("reply")) {
    throw new RangeError("Workflow must include at least 'instructions' and 'reply' blocks");
  }

  const rawAllowed = Array.isArray(raw.allowedTools) ? raw.allowedTools : DEFAULT_ARIA_WORKFLOW.allowedTools;
  const allowedTools = [...new Set(rawAllowed.map((t) => String(t || "").trim()).filter((t) => VALID_TOOLS.has(t)))];

  const rawApproval = Array.isArray(raw.approvalRequiredTools) ? raw.approvalRequiredTools : DEFAULT_ARIA_WORKFLOW.approvalRequiredTools;
  const approvalRequiredTools = [...new Set(rawApproval.map((t) => String(t || "").trim()).filter((t) => VALID_TOOLS.has(t)))];

  const replyStyle = VALID_STYLES.has(raw.replyStyle) ? raw.replyStyle : "warm";
  const knowledgeEntries = Array.isArray(raw.knowledgeEntries)
    ? raw.knowledgeEntries
      .filter((entry) => entry && typeof entry === "object" && typeof entry.title === "string" && typeof entry.content === "string")
      .slice(0, 50)
      .map((entry) => ({
        title: entry.title.trim().slice(0, 120),
        content: entry.content.trim().slice(0, 600),
        pricePerSqft: Number.isFinite(Number(entry.pricePerSqft)) && Number(entry.pricePerSqft) > 0 ? Number(entry.pricePerSqft) : null,
      }))
      .filter((entry) => entry.title && entry.content)
    : [];

  return {
    agentCode,
    name,
    role,
    instructions,
    blocks,
    allowedTools,
    approvalRequiredTools,
    replyStyle,
    knowledgeEntries,
    groupPolicy: normalizeGroupPolicy(raw.groupPolicy || DEFAULT_ARIA_WORKFLOW.groupPolicy),
  };
}

function parseQuoteDimensions(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)\s*(m|meter|meters|ft|sqft|cm)?/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a > 1000 || b > 1000) return null;
  const unit = (m[3] || "m").toLowerCase();
  if (unit === "cm") {
    const wMm = a * 10;
    const hMm = b * 10;
    return { areaSqft: Number((((a / 100) * (b / 100)) * 10.7639).toFixed(2)), widthMm: wMm, heightMm: hMm };
  }
  if (unit === "ft" || unit === "sqft") {
    return { areaSqft: Number((a * b).toFixed(2)), widthMm: Math.round(a * 304.8), heightMm: Math.round(b * 304.8) };
  }
  return { areaSqft: Number((a * b * 10.7639).toFixed(2)), widthMm: Math.round(a * 1000), heightMm: Math.round(b * 1000) };
}

function matchCatalogItem(text, catalogRows = [], knowledgeEntries = []) {
  const lower = String(text || "").toLowerCase();
  const thicknessMatch = lower.match(/(\d{1,2})\s*mm/);
  const wantedMm = thicknessMatch ? Number(thicknessMatch[1]) : null;

  const freshCatalog = (catalogRows || []).filter((row) => row && isFreshRecord(row));
  if (freshCatalog.length) {
    const scored = freshCatalog.map((row) => {
      const hay = `${row.product_code || ""} ${row.glass_name || ""} ${row.thickness_mm || ""}mm`.toLowerCase();
      let score = 0;
      if (wantedMm && Number(row.thickness_mm) === wantedMm) score += 3;
      if (lower.includes("temper") && hay.includes("temper")) score += 3;
      if (lower.includes("laminat") && hay.includes("laminat")) score += 3;
      if (lower.includes("clear") && hay.includes("clear")) score += 2;
      if (row.product_code && lower.includes(String(row.product_code).toLowerCase())) score += 5;
      return { row, score };
    }).sort((a, b) => b.score - a.score);
    if (scored[0]?.score > 0) return { source: "catalog", item: scored[0].row };
  }

  const scoredKb = (knowledgeEntries || []).map((entry) => {
    const words = `${entry.title} ${entry.content}`.toLowerCase().split(/[^a-z0-9\u0E00-\u0E7F]+/).filter((w) => w.length >= 2);
    let score = 0;
    for (const w of new Set(words)) {
      if (lower.includes(w)) score += w.endsWith("mm") ? 3 : 2;
    }
    return { entry, score };
  }).sort((a, b) => b.score - a.score);
  if (scoredKb[0]?.score > 0) return { source: "knowledge", item: scoredKb[0].entry };
  if (freshCatalog.length === 1) return { source: "catalog", item: freshCatalog[0] };
  return null;
}

function detectIntent(text) {
  const t = String(text || "").trim();
  if (/(?:human|staff|operator|agent\s*help|talk to (?:a )?person|คนจริง|พนักงาน|ติดต่อเจ้าหน้าที่|ขอคุยกับคน)/i.test(t)) return "human_help";
  if (/(?:discount|ส่วนลด|cancel\s*order|ยกเลิกออเดอร์|create\s*(?:a\s*)?(?:order\s*)?task|follow[\s-]*up\s*task|สั่งสร้างงาน)/i.test(t)) return "approval_action";
  if (/(?:lead\s*time|delivery\s*time|how\s*long|กี่วัน|ระยะเวลาผลิต)/i.test(t)) return "lead_time";
  if (/(?:quote|price|cost|estimate|ราคา|ใบเสนอราคา|เท่าไหร่)/i.test(t) || parseQuoteDimensions(t)) return "quote";
  return "general";
}

function formatStyledReply(spec, body) {
  const prefix = spec.replyStyle === "formal"
    ? `[${spec.name}] `
    : spec.replyStyle === "warm"
      ? `${spec.name}: `
      : "";
  return `${prefix}${body}`.trim();
}

async function emitOptionalTrace(traceHook, receipt) {
  if (typeof traceHook !== "function") return;
  try {
    await traceHook(receipt);
  } catch {}
}

async function executeWorkflowTurn({
  spec: rawSpec,
  tenant,
  channelType = "web",
  threadId = "default",
  message = "",
  catalogRows = [],
  defaultLeadTimeDays = 7,
  estimatedModelCostUsd = 0,
  handoverStore = null,
  trialService = null,
  proposeNote = null,
  askModel = null,
  notifyHuman = null,
  traceHook = null,
} = {}) {
  const startedAt = Date.now();
  const spec = validateWorkflowSpec(rawSpec);
  const text = String(message || "").trim();
  if (!text) throw new RangeError("message is required");

  if (handoverStore) {
    const current = await handoverStore.getState(tenant.clientAccountId, channelType, threadId);
    if (!shouldAiReply(current.state)) {
      if (typeof notifyHuman === "function") {
        await notifyHuman({
          clientAccountId: tenant.clientAccountId,
          channelType,
          threadId,
          reason: `Customer message while thread is ${current.state}`,
          preview: text.slice(0, 140),
        });
      }
      return {
        replied: false,
        suppressed: true,
        handoverState: current.state,
        reason: "human_takeover_active",
        blocksExecuted: ["decisions"],
      };
    }
  }

  const intent = detectIntent(text);
  const hasBlock = (id) => spec.blocks.includes(id);

  if (intent === "human_help" && hasBlock("human_handoff") && spec.allowedTools.includes("request_human")) {
    if (trialService && typeof trialService.getAllowance === "function") {
      const allowance = await trialService.getAllowance(tenant.clientAccountId);
      if (allowance.provisioned && (allowance.status === "expired" || allowance.status === "paused")) {
        return {
          replied: true,
          blockedByTrial: true,
          reason: allowance.status === "expired" ? "trial_expired" : "trial_paused",
          text: formatTrialRejection(allowance.status === "expired" ? "trial_expired" : "trial_paused"),
          remaining: allowance,
          blocksExecuted: ["decisions"],
        };
      }
    }
    let handoverState = HANDOVER_STATES.HUMAN_TAKEOVER;
    if (handoverStore) {
      const updated = await handoverStore.transition(tenant.clientAccountId, channelType, threadId, "request_human", {
        actor: threadId,
        reason: "Customer requested human assistance",
      });
      handoverState = updated.state;
    }
    if (typeof notifyHuman === "function") {
      await notifyHuman({
        clientAccountId: tenant.clientAccountId,
        channelType,
        threadId,
        reason: "Customer requested human assistance",
        preview: text.slice(0, 140),
      });
    }
    const replyText = formatStyledReply(spec, "I have paused automated replies and notified a human team member to take over this conversation.");
    await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "handed_off", elapsedMs: Date.now() - startedAt });
    return { replied: true, handedOff: true, handoverState, text: replyText, blocksExecuted: ["instructions", "decisions", "human_handoff", "reply"] };
  }

  const needsApproval = intent === "approval_action" && (hasBlock("approval_gate") || spec.approvalRequiredTools.includes("create_task"));
  if (needsApproval) {
    let remaining = null;
    if (trialService) {
      const charge = await trialService.consumeAllowance(tenant.clientAccountId, { messages: 1, actions: 1, costUsd: 0 });
      remaining = charge.remaining;
      if (!charge.allowed) {
        return {
          replied: true,
          blockedByTrial: true,
          reason: charge.reason,
          text: formatTrialRejection(charge.reason),
          remaining,
          blocksExecuted: ["decisions"],
        };
      }
    }
    let proposalId = null;
    if (typeof proposeNote === "function") {
      proposalId = await proposeNote(
        `Approval requested (${tenant.clientCode || tenant.clientAccountId}/${spec.agentCode}): ${text.slice(0, 300)}`,
        "general",
        tenant.operatorLineUserId || threadId,
        "create_task",
        { title: text.slice(0, 200), domain: "sales" },
        tenant.clientAccountId,
        "sales",
      );
    }
    let handoverState = HANDOVER_STATES.AWAITING_APPROVAL;
    if (handoverStore) {
      const updated = await handoverStore.transition(tenant.clientAccountId, channelType, threadId, "stage_approval", {
        actor: spec.agentCode,
        reason: "Approval required before executing action or discount",
      });
      handoverState = updated.state;
    }
    if (typeof notifyHuman === "function") {
      await notifyHuman({
        clientAccountId: tenant.clientAccountId,
        channelType,
        threadId,
        reason: `Approval proposal #${proposalId ?? "staged"}`,
        preview: text.slice(0, 140),
      });
    }
    const replyText = formatStyledReply(
      spec,
      `This request requires human approval before execution${proposalId ? ` (Proposal #${proposalId})` : ""}. A human operator has been notified and will confirm shortly.`
    );
    await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "awaiting_approval", elapsedMs: Date.now() - startedAt });
    return {
      replied: true,
      requiresApproval: true,
      proposalId,
      handoverState,
      remaining,
      text: replyText,
      blocksExecuted: ["instructions", "decisions", "approval_gate", "reply"],
    };
  }

  let remaining = null;
  if (trialService) {
    const charge = await trialService.consumeAllowance(tenant.clientAccountId, {
      messages: 1,
      actions: 0,
      costUsd: Math.max(0, Number(estimatedModelCostUsd) || 0),
    });
    remaining = charge.remaining;
    if (!charge.allowed) {
      return {
        replied: true,
        blockedByTrial: true,
        reason: charge.reason,
        text: formatTrialRejection(charge.reason),
        remaining,
        blocksExecuted: ["decisions"],
      };
    }
  }

  try {
    if (intent === "lead_time" && hasBlock("lead_time") && spec.allowedTools.includes("get_lead_time")) {
      const replyText = formatStyledReply(spec, `Standard production lead time is ${defaultLeadTimeDays} days. Share your order number for an order-specific date.`);
      await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
      return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: replyText, blocksExecuted: ["instructions", "decisions", "lead_time", "reply"] };
    }

    if (intent === "quote" && hasBlock("quote") && hasBlock("knowledge") && spec.allowedTools.includes("get_product_info")) {
      const match = matchCatalogItem(text, catalogRows, spec.knowledgeEntries);
      const dims = parseQuoteDimensions(text);
      if (match?.source === "catalog") {
        const rate = Number(match.item.price_per_sqft);
        if (dims && Number.isFinite(rate) && rate > 0) {
          const glassTotal = Math.round(dims.areaSqft * rate);
          const edging = spec.allowedTools.includes("get_edging_info") && /bevel|polish|edge|เจียร/i.test(text)
            ? calculateEdgingCost({ widthMm: dims.widthMm, heightMm: dims.heightMm, edgeType: /bevel/i.test(text) ? "bevel" : "flat_polish" })
            : null;
          const grandTotal = glassTotal + (edging?.costThb || 0);
          const detail = `${match.item.glass_name || match.item.product_code} (${dims.areaSqft} sqft @ ${rate} THB/sqft = ${glassTotal.toLocaleString("en-US")} THB${edging ? ` + edging ${edging.costThb.toLocaleString("en-US")} THB = ${grandTotal.toLocaleString("en-US")} THB` : ""}) per current price list.`;
          const replyText = formatStyledReply(spec, detail);
          await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
          return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: replyText, blocksExecuted: ["instructions", "knowledge", "decisions", "quote", "reply"] };
        }
        const replyText = formatStyledReply(spec, `${match.item.glass_name || match.item.product_code}: ${match.item.price_per_sqft} THB/sqft per current price list. Share width × height for an instant total.`);
        await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
        return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: replyText, blocksExecuted: ["instructions", "knowledge", "decisions", "quote", "reply"] };
      }
      if (match?.source === "knowledge") {
        const rate = Number(match.item.pricePerSqft);
        if (dims && Number.isFinite(rate) && rate > 0) {
          const glassTotal = Math.round(dims.areaSqft * rate);
          const edging = spec.allowedTools.includes("get_edging_info") && /bevel|polish|edge|เจียร/i.test(text)
            ? calculateEdgingCost({ widthMm: dims.widthMm, heightMm: dims.heightMm, edgeType: /bevel/i.test(text) ? "bevel" : "flat_polish" })
            : null;
          const grandTotal = glassTotal + (edging?.costThb || 0);
          const detail = `${match.item.title} (${dims.areaSqft} sqft @ ${rate} THB/sqft = ${glassTotal.toLocaleString("en-US")} THB${edging ? ` + edging ${edging.costThb.toLocaleString("en-US")} THB = ${grandTotal.toLocaleString("en-US")} THB` : ""}) per approved knowledge base.`;
          const replyText = formatStyledReply(spec, detail);
          await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
          return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: replyText, blocksExecuted: ["instructions", "knowledge", "decisions", "quote", "reply"] };
        }
        const rateText = Number.isFinite(rate) && rate > 0 ? `${rate} THB/sqft — ` : "";
        const replyText = formatStyledReply(spec, `${match.item.title}: ${rateText}${match.item.content} (per approved knowledge base).`);
        await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
        return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: replyText, blocksExecuted: ["instructions", "knowledge", "decisions", "reply"] };
      }
    }

    if (typeof askModel === "function") {
      const kbSummary = [
        ...(catalogRows || []).filter(isFreshRecord).slice(0, 10).map((r) => `${r.product_code}: ${r.glass_name} ${r.thickness_mm || ""}mm @ ${r.price_per_sqft} THB/sqft`),
        ...spec.knowledgeEntries.slice(0, 10).map((e) => `${e.title}: ${e.content}`),
      ].join("\n");
      const systemPrompt = `You are ${spec.name} (${spec.role}).\nInstructions: ${spec.instructions}\nReply style: ${spec.replyStyle}.\nApproved Knowledge:\n${kbSummary || "(none loaded)"}\nNever invent prices or discounts; if information is missing, offer human assistance.`;
      const aiText = await askModel(systemPrompt, text);
      if (aiText && String(aiText).trim()) {
        const replyText = formatStyledReply(spec, String(aiText).trim());
        await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
        return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: replyText, blocksExecuted: ["instructions", "knowledge", "decisions", "reply"] };
      }
    }

    const fallbackText = formatStyledReply(spec, "I don't have verified data for that request yet. Type 'human' anytime to connect directly with our team.");
    await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "completed", elapsedMs: Date.now() - startedAt });
    return { replied: true, handoverState: HANDOVER_STATES.AI_ACTIVE, remaining, text: fallbackText, blocksExecuted: ["instructions", "decisions", "reply"] };
  } catch (err) {
    if (handoverStore) {
      try {
        await handoverStore.transition(tenant.clientAccountId, channelType, threadId, "pause", {
          actor: "system",
          reason: "Service failure — automated replies paused for human review",
        });
      } catch {}
    }
    if (typeof notifyHuman === "function") {
      try {
        await notifyHuman({
          clientAccountId: tenant.clientAccountId,
          channelType,
          threadId,
          reason: `Service failure paused agent: ${err?.name || "Error"}`,
          preview: text.slice(0, 120),
        });
      } catch {}
    }
    await emitOptionalTrace(traceHook, { clientAccountId: tenant.clientAccountId, agentCode: spec.agentCode, channelType, intent, status: "error", elapsedMs: Date.now() - startedAt });
    return {
      replied: true,
      serviceFailed: true,
      handoverState: HANDOVER_STATES.PAUSED,
      remaining,
      text: formatStyledReply(spec, "Automated actions are temporarily paused due to a service error. A human team member has been alerted."),
      blocksExecuted: ["decisions"],
    };
  }
}

module.exports = {
  BLOCK_CATALOG,
  DEFAULT_ARIA_WORKFLOW,
  validateWorkflowSpec,
  parseQuoteDimensions,
  detectIntent,
  executeWorkflowTurn,
};
