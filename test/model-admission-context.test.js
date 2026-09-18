"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelAdmissionContextIssuer } = require("../src/lib/model-admission-context");

const ENDPOINTS = Object.freeze({
  gemini: "https://generativelanguage.googleapis.com/v1beta/models/example:generateContent",
  openai: "https://api.openai.com/v1/chat/completions",
});

function authority(issuer, lane = "frontline") {
  if (lane === "frontline") {
    return issuer.issueAuthority({
      lane, role: "runtime",
      scope: { principalId: "runtime-opaque", clientAccountId: "client-private", department: "sales", resource: "agent-response" },
    });
  }
  return issuer.issueAuthority({
    lane, role: lane === "operator" ? "founder" : "runtime",
    scope: { principalId: `${lane}-opaque`, resource: `${lane}-response` },
  });
}

function context(issuer, overrides = {}) {
  const lane = overrides.lane || "frontline";
  return issuer.createContext({
    lane,
    phase: "plain",
    step: 0,
    executionId: "run-private-001",
    provider: "gemini",
    endpoint: ENDPOINTS.gemini,
    model: "gemini-private-model",
    request: { contents: [{ text: "private prompt sentinel" }], temperature: 0.2 },
    authority: authority(issuer, lane),
    ...overrides,
  });
}

test("fixed lanes map only to their closed production and planned concierge actions", () => {
  const issuer = createModelAdmissionContextIssuer();
  const cases = [
    ["frontline", "gemini", "model.gemini.frontline"],
    ["operator", "openai", "model.openai.operator"],
    ["public", "gemini", "model.gemini.concierge"],
    ["public", "openai", "model.openai.concierge"],
  ];
  for (const [lane, provider, actionId] of cases) {
    const result = context(issuer, {
      lane,
      provider,
      endpoint: ENDPOINTS[provider],
      authority: authority(issuer, lane),
    });
    assert.equal(result.allowed, true);
    assert.equal(result.actionId, actionId);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("replay keys and fingerprints are stable across equivalent request key ordering", () => {
  const issuer = createModelAdmissionContextIssuer();
  const token = authority(issuer);
  const first = context(issuer, {
    authority: token,
    request: { temperature: 0.2, contents: [{ role: "user", text: "same" }] },
  });
  const replay = context(issuer, {
    authority: token,
    request: { contents: [{ text: "same", role: "user" }], temperature: 0.2 },
  });
  assert.equal(first.actionKey, replay.actionKey);
  assert.equal(first.requestFingerprint, replay.requestFingerprint);
  assert.match(first.requestFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.actionKey, /^llm\.h[0-9a-f]{64}\.frontline\.plain\.0\.gemini\.[0-9a-f]{64}$/);
});

test("iteration, provider and model each produce a distinct action key", () => {
  const issuer = createModelAdmissionContextIssuer();
  const token = authority(issuer);
  const base = context(issuer, { authority: token });
  const nextStep = context(issuer, { authority: token, step: 1 });
  const nextProvider = context(issuer, {
    authority: token, provider: "openai", endpoint: ENDPOINTS.openai,
  });
  const nextModel = context(issuer, { authority: token, model: "different-model" });
  assert.equal(new Set([base.actionKey, nextStep.actionKey, nextProvider.actionKey, nextModel.actionKey]).size, 4);
  assert.equal(context(issuer, { authority: token, executionId: 42 }).runId, "42");
});

test("keys expose no prompt, identity, credential, execution ID or raw model sentinels", () => {
  const issuer = createModelAdmissionContextIssuer();
  const scope = {
    principalId: "LINE-USER-SENTINEL",
    clientAccountId: "CLIENT-ID-SENTINEL",
    department: "sales",
    resource: "response",
  };
  const token = issuer.issueAuthority({ lane: "frontline", role: "runtime", scope });
  const result = issuer.createContext({
    lane: "frontline", phase: "tool", step: 3, executionId: "EXECUTION-ID-SENTINEL",
    provider: "openai", endpoint: ENDPOINTS.openai, model: "RAW-MODEL-SENTINEL",
    request: { prompt: "PROMPT-SENTINEL", authorization: "TOKEN-SENTINEL" }, authority: token,
  });
  for (const sentinel of [
    "LINE-USER-SENTINEL", "CLIENT-ID-SENTINEL", "EXECUTION-ID-SENTINEL",
    "RAW-MODEL-SENTINEL", "PROMPT-SENTINEL", "TOKEN-SENTINEL",
  ]) assert.equal(result.actionKey.includes(sentinel), false);
  assert.equal(JSON.stringify(result).includes("CLIENT-ID-SENTINEL"), false);
  assert.equal(result.actionKey, `llm.h${require("node:crypto").createHash("sha256").update("EXECUTION-ID-SENTINEL").digest("hex")}.frontline.tool.3.openai.${result.modelHash}`);
});

test("unknown and OpenAI-compatible private providers block without dynamic action IDs", () => {
  const issuer = createModelAdmissionContextIssuer();
  const token = authority(issuer);
  const unknown = context(issuer, { authority: token, provider: "openrouter", endpoint: "https://openrouter.ai/api/v1" });
  const compatible = context(issuer, { authority: token, provider: "openai", endpoint: "https://example.invalid/v1/chat/completions" });
  for (const result of [unknown, compatible]) {
    assert.equal(result.allowed, false);
    assert.equal(result.actionId, null);
    assert.equal(result.actionKey, null);
    assert.equal(result.authority, null);
    assert.equal(Object.isFrozen(result), true);
  }
  assert.equal(unknown.code, "PROVIDER_NOT_ALLOWED");
  assert.equal(compatible.code, "PROVIDER_PRIVATE_INELIGIBLE");
});

test("authority tokens are issuer-private, lane-bound and expected-role-bound", async () => {
  const first = createModelAdmissionContextIssuer();
  const second = createModelAdmissionContextIssuer();
  const token = authority(first, "frontline");
  const resolved = await first.resolvePrincipal({
    actionId: "model.gemini.frontline", authority: token, expectedRole: "runtime",
  });
  assert.equal(resolved.role, "runtime");
  assert.equal(resolved.scope.clientAccountId, "client-private");
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.scope), true);
  assert.equal(await first.resolvePrincipal({ actionId: "model.gemini.frontline", authority: token, expectedRole: "founder" }), null);
  assert.equal(await first.resolvePrincipal({ actionId: "model.gemini.concierge", authority: token, expectedRole: "runtime" }), null);
  assert.equal(await second.resolvePrincipal({ actionId: "model.gemini.frontline", authority: token, expectedRole: "runtime" }), null);
  assert.equal(await first.resolvePrincipal({ actionId: "model.gemini.frontline", authority: {}, expectedRole: "runtime" }), null);
});

test("scope is copied before storage and token, context and resolution resist mutation", async () => {
  const issuer = createModelAdmissionContextIssuer();
  const original = {
    principalId: "runtime-original", clientAccountId: "client-original",
    department: "sales", resource: "response",
  };
  const token = issuer.issueAuthority({ lane: "frontline", role: "runtime", scope: original });
  original.clientAccountId = "forged-client";
  const result = context(issuer, { authority: token });
  assert.throws(() => { token.forged = true; }, TypeError);
  assert.throws(() => { result.actionId = "model.openai.operator"; }, TypeError);
  const resolved = await issuer.resolvePrincipal({
    actionId: result.actionId, authority: token, expectedRole: "runtime",
  });
  assert.equal(resolved.scope.clientAccountId, "client-original");
  assert.throws(() => { resolved.scope.clientAccountId = "forged-client"; }, TypeError);
});

test("issuer rejects mismatched roles, incomplete private scope and accessor scope", () => {
  const issuer = createModelAdmissionContextIssuer();
  assert.throws(() => issuer.issueAuthority({
    lane: "operator", role: "runtime", scope: { principalId: "operator", resource: "response" },
  }), /role/);
  assert.throws(() => issuer.issueAuthority({
    lane: "frontline", role: "runtime", scope: { principalId: "runtime", resource: "response" },
  }), /scope/);
  const scope = { principalId: "runtime", clientAccountId: "client", department: "sales" };
  Object.defineProperty(scope, "resource", { get() { return "response"; }, enumerable: true });
  assert.throws(() => issuer.issueAuthority({ lane: "frontline", role: "runtime", scope }), /scope/);
});

test("unsupported request values block safely instead of producing a weak fingerprint", () => {
  const issuer = createModelAdmissionContextIssuer();
  const token = authority(issuer);
  const cyclic = {};
  cyclic.self = cyclic;
  const result = context(issuer, { authority: token, request: cyclic });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "MODEL_REQUEST_INVALID");
  assert.equal(result.actionId, null);
  assert.equal(result.actionKey, null);
});
