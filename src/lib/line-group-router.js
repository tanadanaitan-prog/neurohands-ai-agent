"use strict";

const GROUP_MODES = Object.freeze(["off", "mention_only", "keyword", "always"]);
const DEFAULT_BOT_NAMES = Object.freeze(["neurohands", "aria", "jarvis"]);

function normalizeGroupPolicy(raw) {
  const mode = GROUP_MODES.includes(raw?.mode) ? raw.mode : "mention_only";
  const keywords = Array.isArray(raw?.keywords)
    ? [...new Set(raw.keywords.map((k) => String(k || "").trim().toLowerCase()).filter((k) => k.length >= 2 && k.length <= 40))].slice(0, 15)
    : [];
  return { mode, keywords };
}

function isBotMentioned({ text = "", mention = null, botNames = DEFAULT_BOT_NAMES }) {
  const mentinees = Array.isArray(mention?.mentionees) ? mention.mentionees : [];
  if (mentinees.length > 0) {
    return mentinees.some((entry) => entry && entry.isSelf === true);
  }
  const raw = String(text || "");
  return botNames.some((name) => {
    const clean = String(name || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return clean && new RegExp(`(?:^|\\s)@${clean}(?:$|[\\s:,.!?])`, "i").test(raw);
  });
}

function shouldRespondInGroup({ mode = "mention_only", keywords = [], text = "", mention = null, botNames = DEFAULT_BOT_NAMES } = {}) {
  if (!GROUP_MODES.includes(mode) || mode === "off") {
    return { respond: false, reason: "group_mode_off" };
  }
  if (mode === "always") {
    return { respond: true, reason: "group_mode_always" };
  }
  if (isBotMentioned({ text, mention, botNames })) {
    return { respond: true, reason: "mentioned" };
  }
  if (mode === "keyword") {
    const lower = String(text || "").toLowerCase();
    const matched = (keywords || []).find((kw) => kw && lower.includes(String(kw).toLowerCase()));
    if (matched) return { respond: true, reason: "keyword_matched", keyword: matched };
    return { respond: false, reason: "no_keyword_match" };
  }
  return { respond: false, reason: "not_mentioned" };
}

function stripBotMention(text = "", botNames = DEFAULT_BOT_NAMES) {
  let cleaned = String(text || "").trim();
  for (const name of botNames) {
    const escaped = String(name || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) continue;
    cleaned = cleaned.replace(new RegExp(`^@${escaped}\\b[:\\s,-]*`, "i"), "").trim();
  }
  return cleaned;
}

function parseGroupBindCommand(text = "") {
  const m = String(text || "").trim().match(/^bind\s+(NH-[A-Z0-9-]+)$/i);
  return m ? m[1].toUpperCase() : null;
}

module.exports = {
  GROUP_MODES,
  DEFAULT_BOT_NAMES,
  normalizeGroupPolicy,
  isBotMentioned,
  shouldRespondInGroup,
  stripBotMention,
  parseGroupBindCommand,
};
