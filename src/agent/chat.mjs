// Local conversation lab. This graph has no business tools or production imports.
import { ChatOllama } from "@langchain/ollama";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateSchema, MessagesValue, StateGraph, START, END } from "@langchain/langgraph";

export const CHAT_LIMITS = Object.freeze({
  inputCharacters: 2000,
  historyCharacters: 6000,
  historyMessages: 12,
  threadMessages: 100,
  outputTokens: 256,
  contextTokens: 4096,
  timeoutMs: 90000,
});

const SYSTEM_PROMPT = `You are the Neurohands local test assistant. Answer clearly and briefly.
You can converse and reason using this conversation, but you have no internet, tools, company database, LINE access, or ability to perform actions.
Never claim to have researched, sent, changed, saved, or verified something outside this chat. Say when you do not know. Use synthetic test examples, not confidential business data.
Recent messages are your only memory. You are a small test model, not a deployed business agent.`;

export function getLocalChatConfig(env = process.env) {
  let base;
  try {
    base = new URL(env.LAB_OLLAMA_BASE_URL || "http://127.0.0.1:11434");
  } catch {
    throw new Error("LAB_OLLAMA_BASE_URL must be a local Ollama URL, such as http://127.0.0.1:11434.");
  }
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("This lab only accepts a loopback Ollama URL without credentials, a path, or query parameters.");
  }
  const model = env.LAB_OLLAMA_MODEL || "qwen3:1.7b";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/.test(model) || /cloud/i.test(model)) {
    throw new Error("LAB_OLLAMA_MODEL must name an installed local model; cloud models are disabled in this lab.");
  }
  return { baseUrl: base.origin, model };
}

export const readChatConfig = getLocalChatConfig;

export function buildChatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Add a Human message in Studio before submitting.");
  }
  if (messages.length > CHAT_LIMITS.threadMessages) {
    throw new Error("This test conversation reached its limit. Start a new Studio thread to continue.");
  }
  const normalized = messages.map((message) => {
    const type = message.getType?.();
    const textBlocks = Array.isArray(message.content) && message.content.every((block) =>
      block !== null && typeof block === "object" && !Array.isArray(block)
      && block.type === "text" && typeof block.text === "string");
    if (!["human", "ai"].includes(type) || (typeof message.content !== "string" && !textBlocks)
        || (message.tool_calls?.length ?? 0) > 0 || (message.invalid_tool_calls?.length ?? 0) > 0) {
      throw new Error("This conversation lab accepts plain-text Human and AI messages only; tools and system overrides are unavailable.");
    }
    if (typeof message.content === "string") return message;
    // Studio represents typed chat input as text blocks. Flatten only that
    // representation; image/audio/tool blocks must never reach this text lab.
    const fields = {
      content: message.content.map((block) => block.text).join("\n"),
      id: message.id,
      name: message.name,
      response_metadata: message.response_metadata,
    };
    return type === "human" ? new HumanMessage(fields)
      : new AIMessage({ ...fields, usage_metadata: message.usage_metadata });
  });
  const latest = normalized.at(-1);
  if (latest.getType() !== "human" || !latest.content.trim()) {
    throw new Error("Add a nonempty Human message in Studio before submitting.");
  }
  if (latest.content.length > CHAT_LIMITS.inputCharacters) {
    throw new Error(`Keep each new message within ${CHAT_LIMITS.inputCharacters} characters for this small local model.`);
  }

  const selected = [];
  let characters = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (selected.length >= CHAT_LIMITS.historyMessages
        || characters + message.content.length > CHAT_LIMITS.historyCharacters) break;
    selected.unshift(message);
    characters += message.content.length;
  }
  // Do not start a shortened conversation with an orphaned assistant reply.
  while (selected[0]?.getType() === "ai") selected.shift();
  return [new SystemMessage(SYSTEM_PROMPT), ...selected];
}

function modelFailure(error, signal, model) {
  if (signal.aborted) {
    return new Error(signal.reason?.name === "TimeoutError"
      ? "The local model took too long. Keep Ollama running, close other heavy apps, and retry with a shorter message."
      : "The local model request was cancelled. Submit again when ready.");
  }
  if (error?.status_code === 404 || error?.status === 404) {
    return new Error(`The local model ${model} is missing. Download that model in Ollama, then submit again.`);
  }
  if (error?.name === "TypeError" || ["ECONNREFUSED", "ENOTFOUND"].includes(error?.cause?.code)) {
    return new Error("Cannot reach Ollama on this laptop. Start Ollama, keep it running, then submit again.");
  }
  // Do not forward raw provider errors, request bodies, headers, or credentials.
  return new Error("The local model could not complete this request. Check that the configured model runs in Ollama, then retry.");
}

export function createChatGraph({
  env = process.env,
  modelFactory = (options) => new ChatOllama(options),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = CHAT_LIMITS.timeoutMs,
} = {}) {
  const settings = getLocalChatConfig(env);
  const State = new StateSchema({ messages: MessagesValue });

  async function localChat(state, config) {
    const messages = buildChatMessages(state.messages);
    const deadline = new AbortController();
    const signal = config?.signal
      ? AbortSignal.any([deadline.signal, config.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    let onAbort;
    try {
      signal.throwIfAborted();
      const model = modelFactory({
        ...settings,
        temperature: 0.2,
        numCtx: CHAT_LIMITS.contextTokens,
        numPredict: CHAT_LIMITS.outputTokens,
        think: false,
        maxRetries: 0,
        checkOrPullModel: false,
        keepAlive: "5m",
        fetch: (url, options = {}) => fetchImpl(url, {
          ...options,
          redirect: "error",
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        }),
      });
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const reply = await Promise.race([model.invoke(messages, { ...config, signal }), aborted]);
      if (typeof reply?.content !== "string" || !reply.content.trim()) {
        throw new Error("Empty model response");
      }
      // Preserve AIMessage token counts and response metadata in Studio / explicit traces.
      return { messages: [reply] };
    } catch (error) {
      throw modelFailure(error, signal, settings.model);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  return new StateGraph(State)
    .addNode("local_chat", localChat)
    .addEdge(START, "local_chat")
    .addEdge("local_chat", END)
    .compile();
}

export const graph = createChatGraph();
