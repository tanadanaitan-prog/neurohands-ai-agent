"use strict";

// A structured, unblocked empty completion can be summarized once. Transport,
// authentication, filtering and malformed responses never acquire this status.
function emptyGeminiFinal(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;
  return !data?.promptFeedback?.blockReason &&
    (!candidate?.finishReason || ["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) &&
    !candidate?.safetyRatings?.some(item => item.blocked) &&
    Array.isArray(parts) && parts.length > 0 &&
    parts.every(part => typeof part?.text === "string" && !part.text.trim() && !part.functionCall);
}

function emptyOpenAIFinal(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  return (!choice?.finish_reason || ["stop", "length"].includes(choice.finish_reason)) &&
    !message?.refusal && typeof message?.content === "string" && !message.content.trim() &&
    (message.tool_calls == null || (Array.isArray(message.tool_calls) && !message.tool_calls.length));
}

const POST_TOOL_SYNTHESIS_INSTRUCTION = "Return a concise final answer using only the tool results already in this conversation. Do not call any tool or repeat any action. Preserve errors, partial-reading limits and uncertainty; never claim unverified completion.";

function postToolText(provider, data) {
  if (provider === "gemini") {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (data?.promptFeedback?.blockReason || (candidate?.finishReason && candidate.finishReason !== "STOP") ||
        (candidate?.safetyRatings != null && (!Array.isArray(candidate.safetyRatings) || candidate.safetyRatings.some(item => item.blocked))) ||
        !Array.isArray(parts) || parts.some(part => !part || part.functionCall)) return null;
    const text = parts.filter(part => part.thought !== true && typeof part.text === "string")
      .map(part => part.text).join("\n").trim();
    return text || null;
  }
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message || message.refusal || (choice.finish_reason && choice.finish_reason !== "stop") ||
      (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length)) ||
      typeof message.content !== "string") return null;
  return message.content.trim() || null;
}

module.exports = { emptyGeminiFinal, emptyOpenAIFinal, postToolText, POST_TOOL_SYNTHESIS_INSTRUCTION };
