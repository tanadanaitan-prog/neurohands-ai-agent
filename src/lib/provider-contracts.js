"use strict";

const SUPPORTED_PROVIDER_CONTRACTS = Object.freeze({
  gemini: Object.freeze({
    apiVersion: "v1beta",
    operation: "generateContent",
    responsePath: "candidates[0].content.parts",
    toolSchemaField: "parametersJsonSchema",
  }),
  openaiCompatible: Object.freeze({
    path: "chat/completions",
    responsePath: "choices[0].message",
    toolArgumentsEncoding: "json_string",
  }),
});

const SUPPORTED_PACKAGE_VERSIONS = Object.freeze({
  "@langchain/core": "1.2.11",
  "@langchain/langgraph": "1.4.15",
  "@langchain/langgraph-cli": "1.4.6",
  "@langchain/ollama": "1.3.0",
  "@supabase/supabase-js": "2.115.0",
  langsmith: "0.10.4",
});

function validToolArguments(args) {
  return args !== null && typeof args === "object" && !Array.isArray(args);
}

function buildGeminiRequest({ model, systemInstruction, contents, generationConfig, tools = [] } = {}) {
  if (typeof model !== "string" || !model.trim() || typeof systemInstruction !== "string" ||
      !Array.isArray(contents) || !contents.length || !generationConfig || typeof generationConfig !== "object" ||
      !Array.isArray(tools)) throw new TypeError("A complete Gemini request contract is required");
  const contract = SUPPORTED_PROVIDER_CONTRACTS.gemini;
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig,
  };
  if (tools.length) {
    body.tools = [{
      functionDeclarations: tools.map(({ parameters, ...declaration }) => ({
        ...declaration,
        [contract.toolSchemaField]: parameters,
      })),
    }];
  }
  return Object.freeze({
    url: `https://generativelanguage.googleapis.com/${contract.apiVersion}/models/${encodeURIComponent(model.trim())}:${contract.operation}`,
    body,
  });
}

function buildOpenAICompatibleRequest({ baseUrl, model, body = {} } = {}) {
  if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl) || typeof model !== "string" || !model.trim() ||
      !body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("A complete OpenAI-compatible request contract is required");
  }
  const path = SUPPORTED_PROVIDER_CONTRACTS.openaiCompatible.path;
  return Object.freeze({
    url: `${baseUrl.replace(/\/+$/, "")}/${path}`,
    body: { model: model.trim(), ...body },
  });
}

function usableFallbackMessage(data, allowTools) {
  const message = data?.choices?.[0]?.message;
  if (!message || (message.content != null && typeof message.content !== "string")) return false;
  if (message.tool_calls != null && !Array.isArray(message.tool_calls)) return false;
  const calls = message.tool_calls || [];
  if (calls.length) {
    if (!allowTools) return false;
    return calls.every((call) => {
      if (!call || typeof call.id !== "string" || !call.id.trim() ||
          typeof call.function?.name !== "string" || !call.function.name.trim() ||
          typeof call.function.arguments !== "string") return false;
      try { return validToolArguments(JSON.parse(call.function.arguments)); }
      catch { return false; }
    });
  }
  return typeof message.content === "string" && Boolean(message.content.trim());
}

function geminiParts(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || !parts.length) return null;
  if (parts.some((part) => !part || typeof part !== "object" ||
      (part.text !== undefined && typeof part.text !== "string") ||
      (part.functionCall !== undefined && (typeof part.functionCall?.name !== "string" ||
        !part.functionCall.name.trim() ||
        (part.functionCall.args !== undefined && !validToolArguments(part.functionCall.args)))))) return null;
  return parts;
}

function validateContractRegister(register) {
  const errors = [];
  if (!register || typeof register !== "object" || Array.isArray(register)) {
    return [{ service: "registry", interface: "root", code: "INVALID_CONTRACT_REGISTER" }];
  }
  if (register.schemaVersion !== "1.0.0") {
    errors.push({ service: "registry", interface: "schemaVersion", code: "UNSUPPORTED_CONTRACT_SCHEMA" });
  }
  for (const [service, supported] of Object.entries(SUPPORTED_PROVIDER_CONTRACTS)) {
    const configured = register.providers?.[service];
    if (!configured || typeof configured !== "object") {
      errors.push({ service, interface: "provider", code: "PROVIDER_CONTRACT_MISSING" });
      continue;
    }
    for (const [field, value] of Object.entries(supported)) {
      if (configured[field] !== value) {
        errors.push({ service, interface: field, code: "UNSUPPORTED_PROVIDER_CONTRACT" });
      }
    }
  }
  const packageEntries = Object.entries(register.packages || {});
  if (!packageEntries.length || packageEntries.some(([name, version]) =>
    typeof name !== "string" || !name || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))) {
    errors.push({ service: "node", interface: "packages", code: "INVALID_PACKAGE_CONTRACT" });
  }
  for (const [name, version] of Object.entries(SUPPORTED_PACKAGE_VERSIONS)) {
    if (register.packages?.[name] !== version) {
      errors.push({ service: "node", interface: `package:${name}`, code: "UNSUPPORTED_PACKAGE_VERSION" });
    }
  }
  return errors;
}

function validateProviderFixtures() {
  const failures = [];
  const geminiPlain = { candidates: [{ content: { parts: [{ text: "fixture answer" }] } }] };
  const geminiTool = { candidates: [{ content: { parts: [{ functionCall: { name: "fixture_tool", args: { id: "fixture" } } }] } }] };
  const fallbackPlain = { choices: [{ message: { role: "assistant", content: "fixture answer" } }] };
  const fallbackTool = { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
    id: "fixture-call", type: "function", function: { name: "fixture_tool", arguments: "{\"id\":\"fixture\"}" },
  }] } }] };
  if (!geminiParts(geminiPlain)) failures.push({ service: "gemini", interface: "plainResponse", code: "FIXTURE_REJECTED" });
  if (!geminiParts(geminiTool)) failures.push({ service: "gemini", interface: "toolResponse", code: "FIXTURE_REJECTED" });
  if (!usableFallbackMessage(fallbackPlain, false)) failures.push({ service: "openaiCompatible", interface: "plainResponse", code: "FIXTURE_REJECTED" });
  if (!usableFallbackMessage(fallbackTool, true)) failures.push({ service: "openaiCompatible", interface: "toolResponse", code: "FIXTURE_REJECTED" });
  if (geminiParts({ candidates: [{ content: { segments: [{ text: "changed" }] } }] })) {
    failures.push({ service: "gemini", interface: "responsePath", code: "UNSUPPORTED_FIXTURE_ACCEPTED" });
  }
  if (usableFallbackMessage({ choices: [{ message: { content: null, tool_calls: [{
    id: "changed", function: { name: "fixture_tool", arguments: { id: "changed" } },
  }] } }] }, true)) {
    failures.push({ service: "openaiCompatible", interface: "toolArgumentsEncoding", code: "UNSUPPORTED_FIXTURE_ACCEPTED" });
  }
  return failures;
}

function validateProviderRequestFixtures() {
  const failures = [];
  try {
    const request = buildGeminiRequest({
      model: "fixture-model",
      systemInstruction: "fixture policy",
      contents: [{ role: "user", parts: [{ text: "fixture input" }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 16 },
      tools: [{ name: "fixture_tool", description: "fixture", parameters: {
        type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
      } }],
    });
    const declaration = request.body?.tools?.[0]?.functionDeclarations?.[0];
    if (request.url !== "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent") {
      failures.push({ service: "gemini", interface: "requestUrl", code: "REQUEST_FIXTURE_REJECTED" });
    }
    if (!declaration?.parametersJsonSchema || Object.hasOwn(declaration, "parameters")) {
      failures.push({ service: "gemini", interface: "toolSchemaField", code: "REQUEST_FIXTURE_REJECTED" });
    }
    if (request.body?.contents?.[0]?.parts?.[0]?.text !== "fixture input") {
      failures.push({ service: "gemini", interface: "requestBody", code: "REQUEST_FIXTURE_REJECTED" });
    }
  } catch {
    failures.push({ service: "gemini", interface: "requestBuilder", code: "REQUEST_FIXTURE_FAILED" });
  }
  try {
    const request = buildOpenAICompatibleRequest({
      baseUrl: "https://fixture.invalid/v1/",
      model: "fixture-model",
      body: { messages: [{ role: "user", content: "fixture input" }] },
    });
    if (request.url !== "https://fixture.invalid/v1/chat/completions") {
      failures.push({ service: "openaiCompatible", interface: "requestUrl", code: "REQUEST_FIXTURE_REJECTED" });
    }
    if (request.body?.model !== "fixture-model" || request.body?.messages?.[0]?.content !== "fixture input") {
      failures.push({ service: "openaiCompatible", interface: "requestBody", code: "REQUEST_FIXTURE_REJECTED" });
    }
  } catch {
    failures.push({ service: "openaiCompatible", interface: "requestBuilder", code: "REQUEST_FIXTURE_FAILED" });
  }
  return failures;
}

module.exports = {
  SUPPORTED_PROVIDER_CONTRACTS,
  SUPPORTED_PACKAGE_VERSIONS,
  buildGeminiRequest,
  buildOpenAICompatibleRequest,
  geminiParts,
  usableFallbackMessage,
  validToolArguments,
  validateContractRegister,
  validateProviderFixtures,
  validateProviderRequestFixtures,
};
