"use strict";

const { createHash } = require("node:crypto");

const LANES = Object.freeze({
  frontline: Object.freeze({ role: "runtime", suffix: "frontline", scope: Object.freeze(["principalId", "clientAccountId", "department", "resource"]) }),
  operator: Object.freeze({ role: "founder", suffix: "operator", scope: Object.freeze(["principalId", "resource"]) }),
  public: Object.freeze({ role: "runtime", suffix: "concierge", scope: Object.freeze(["principalId", "resource"]) }),
});
const PHASES = new Set(["plain", "tool"]);
const PROVIDERS = Object.freeze({
  gemini: Object.freeze({ origin: "https://generativelanguage.googleapis.com", path: /^\/v1(?:beta)?\// }),
  openai: Object.freeze({ origin: "https://api.openai.com", path: /^\/v1(?:\/|$)/ }),
});
const SCOPE_FIELDS = new Set(["principalId", "clientAccountId", "department", "resource"]);
const OPAQUE_PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("The request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("The request contains an unsupported value");
  if (seen.has(value)) throw new TypeError("The request contains a cycle");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("The request must contain plain data");
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new TypeError("The request cannot contain symbol fields");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) throw new TypeError("The request cannot contain accessors");
      fields.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`);
    }
    result = `{${fields.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function cleanScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(scope)) ||
      Object.getOwnPropertySymbols(scope).length) {
    throw new TypeError("Authority scope must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(scope);
  const copy = {};
  for (const key of Object.keys(descriptors)) {
    if (!SCOPE_FIELDS.has(key) || !("value" in descriptors[key])) {
      throw new TypeError("Authority scope contains an unsupported field");
    }
    const value = descriptors[key].value;
    if (!["string", "number"].includes(typeof value) || !String(value).trim() || String(value).length > 192) {
      throw new TypeError("Authority scope contains an invalid value");
    }
    copy[key] = String(value);
  }
  if (!OPAQUE_PRINCIPAL.test(copy.principalId || "")) {
    throw new TypeError("Authority requires a stable opaque principal");
  }
  return Object.freeze(copy);
}

function scopeSupportsLane(scope, lane) {
  if (!LANES[lane].scope.every((field) => Object.hasOwn(scope, field))) return false;
  if (lane !== "frontline" && (Object.hasOwn(scope, "clientAccountId") || Object.hasOwn(scope, "department"))) {
    return false;
  }
  return true;
}

function endpointIsOfficial(provider, endpoint) {
  const policy = PROVIDERS[provider];
  if (!policy || typeof endpoint !== "string") return false;
  try {
    const url = new URL(endpoint);
    return url.origin === policy.origin && policy.path.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function executionToken(executionId) {
  if (Number.isSafeInteger(executionId) && executionId >= 0) return String(executionId);
  if (typeof executionId === "string" && executionId.trim() && executionId.length <= 512) {
    return `h${sha256(executionId)}`;
  }
  return null;
}

function blockedContext(code, { lane = null, phase = null, step = null } = {}) {
  return Object.freeze({
    allowed: false,
    code,
    lane,
    phase,
    step,
    provider: null,
    actionId: null,
    actionKey: null,
    runId: null,
    modelHash: null,
    requestFingerprint: null,
    authority: null,
  });
}

function actionIdFor(provider, lane) {
  return `model.${provider}.${LANES[lane].suffix}`;
}

function createModelAdmissionContextIssuer() {
  const claims = new WeakMap();

  function issueAuthority({ lane, role, scope } = {}) {
    if (!Object.hasOwn(LANES, lane)) throw new TypeError("Authority lane is invalid");
    if (role !== LANES[lane].role) throw new TypeError("Authority role does not match its lane");
    const safeScope = cleanScope(scope);
    if (!scopeSupportsLane(safeScope, lane)) throw new TypeError("Authority scope does not match its lane");
    const token = Object.freeze(Object.create(null));
    claims.set(token, Object.freeze({ lane, role, scope: safeScope }));
    return token;
  }

  async function resolvePrincipal({ actionId, authority, expectedRole } = {}) {
    if (!authority || typeof authority !== "object") return null;
    const claim = claims.get(authority);
    if (!claim || expectedRole !== claim.role || actionId !== actionIdForProviderLane(actionId, claim.lane)) return null;
    return Object.freeze({ role: claim.role, scope: claim.scope });
  }

  function actionIdForProviderLane(actionId, lane) {
    for (const provider of Object.keys(PROVIDERS)) {
      const candidate = actionIdFor(provider, lane);
      if (candidate === actionId) return candidate;
    }
    return null;
  }

  function createContext({
    lane,
    phase,
    step,
    executionId,
    provider,
    endpoint,
    model,
    request,
    authority,
  } = {}) {
    if (!Object.hasOwn(LANES, lane)) return blockedContext("MODEL_LANE_INVALID");
    if (!PHASES.has(phase)) return blockedContext("MODEL_PHASE_INVALID", { lane });
    if (!Number.isSafeInteger(step) || step < 0) return blockedContext("MODEL_STEP_INVALID", { lane, phase });

    if (!Object.hasOwn(PROVIDERS, provider)) {
      return blockedContext("PROVIDER_NOT_ALLOWED", { lane, phase, step });
    }
    if (!endpointIsOfficial(provider, endpoint)) {
      return blockedContext(
        lane === "public" ? "PROVIDER_NOT_ALLOWED" : "PROVIDER_PRIVATE_INELIGIBLE",
        { lane, phase, step }
      );
    }
    const runId = executionToken(executionId);
    if (!runId) return blockedContext("MODEL_EXECUTION_ID_INVALID", { lane, phase, step });
    if (typeof model !== "string" || !model.trim() || model.length > 512) {
      return blockedContext("MODEL_NAME_INVALID", { lane, phase, step });
    }
    const claim = authority && typeof authority === "object" ? claims.get(authority) : null;
    if (!claim || claim.lane !== lane || claim.role !== LANES[lane].role || !scopeSupportsLane(claim.scope, lane)) {
      return blockedContext("TRUSTED_AUTHORITY_REQUIRED", { lane, phase, step });
    }

    const modelHash = sha256(model);
    let requestFingerprint;
    try {
      requestFingerprint = sha256(canonicalJson({ provider, model, request }));
    } catch {
      return blockedContext("MODEL_REQUEST_INVALID", { lane, phase, step });
    }
    const actionId = actionIdFor(provider, lane);
    const actionKey = `llm.${runId}.${lane}.${phase}.${step}.${provider}.${modelHash}`;
    return Object.freeze({
      allowed: true,
      code: "MODEL_ADMISSION_CONTEXT_READY",
      lane,
      phase,
      step,
      provider,
      actionId,
      actionKey,
      runId,
      modelHash,
      requestFingerprint,
      authority,
    });
  }

  return Object.freeze({ issueAuthority, resolvePrincipal, createContext });
}

module.exports = { createModelAdmissionContextIssuer };
