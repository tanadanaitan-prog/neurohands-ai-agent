"use strict";

const { createHash } = require("node:crypto");
const { redactTracePayload } = require("./admission-control");

const PRIVATE_DOCUMENT_KEY = /(?:^|[_-])document[_-](?:body|content|text)(?:$|[_-])|^(?:raw[_-]document|file[_-]content|ocr[_-]text|extracted[_-]text|source[_-]document)$/i;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 32;
const MAX_PAYLOAD_NODES = 4096;
const RECEIPT_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYNTHETIC_TRACE_SCHEMA = "neurohands-fixed-synthetic-trace-v1";
const SYNTHETIC_PROJECT_NAME = "neurohands-local-test";
const SYNTHETIC_OPTION_KEYS = new Set([
  "scenario", "runId", "startedAt", "endedAt", "durationMs", "modelCalls",
  "inputTokens", "outputTokens", "totalTokens", "toolVerified",
]);
const SYNTHETIC_SCENARIOS = Object.freeze({
  "connection-check": Object.freeze({
    name: "neurohands-synthetic-connection-check",
    fixtureId: "fixed-echo-v1",
    tags: Object.freeze(["synthetic", "no-llm", "local-lab"]),
    toolName: null,
  }),
  "local-model-check": Object.freeze({
    name: "neurohands-local-model-check",
    fixtureId: "fictional-notebook-total-v1",
    tags: Object.freeze(["synthetic", "local-llm", "local-lab"]),
    toolName: null,
  }),
  "aria-tool-check": Object.freeze({
    name: "neurohands-local-aria-tool-check",
    fixtureId: "fictional-order-status-v1",
    tags: Object.freeze(["synthetic", "local-llm", "local-lab"]),
    toolName: "get_order_status",
  }),
});
const authorities = new WeakMap();
const fixedSyntheticTraces = new WeakMap();

function fixedResult(status, code, attempts = 0, settlement = "cancelled_before_dispatch") {
  return Object.freeze({ status, code, attempts, settlement });
}

function clonePlainTraceData(value, state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) throw new TypeError("Trace payload is too complex");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || state.seen.has(value)) throw new TypeError("Trace payload must be acyclic plain data");
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if ((!isArray && prototype !== Object.prototype && prototype !== null) ||
      (isArray && prototype !== Array.prototype)) throw new TypeError("Trace payload must be plain data");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("Trace payload symbols are not allowed");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  state.seen.add(value);
  try {
    if (isArray) {
      const length = value.length;
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== length || keys.some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
        throw new TypeError("Sparse or decorated trace arrays are not allowed");
      }
      const copy = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError("Trace array accessors are not allowed");
        }
        copy.push(clonePlainTraceData(descriptor.value, state, depth + 1));
      }
      return copy;
    }
    const copy = Object.create(null);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || descriptor.enumerable !== true || key === "__proto__") {
        throw new TypeError("Trace object accessors and hidden fields are not allowed");
      }
      copy[key] = clonePlainTraceData(descriptor.value, state, depth + 1);
    }
    return copy;
  } finally {
    state.seen.delete(value);
  }
}

function hasPrivateDocumentContent(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_DOCUMENT_KEY.test(key) && child !== null && child !== undefined && child !== "") return true;
    if (hasPrivateDocumentContent(child, seen)) return true;
  }
  return false;
}

function payloadDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createFixedSyntheticTracePayload(candidate = {}) {
  let options;
  try {
    options = clonePlainTraceData(candidate);
  } catch {
    return null;
  }
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((key) => !SYNTHETIC_OPTION_KEYS.has(key))) return null;
  const {
    scenario,
    runId,
    startedAt,
    endedAt,
    durationMs,
    modelCalls = 0,
    inputTokens = 0,
    outputTokens = 0,
    totalTokens = 0,
    toolVerified = false,
  } = options;
  const spec = typeof scenario === "string" && Object.hasOwn(SYNTHETIC_SCENARIOS, scenario)
    ? SYNTHETIC_SCENARIOS[scenario]
    : null;
  const numericValues = [startedAt, endedAt, durationMs, modelCalls, inputTokens, outputTokens, totalTokens];
  if (!spec || typeof runId !== "string" || !TRACE_ID.test(runId) ||
      !numericValues.every(safeNonnegativeInteger) || endedAt < startedAt ||
      totalTokens !== inputTokens + outputTokens ||
      toolVerified !== (spec.toolName !== null)) return null;

  const output = {
    status: "completed",
    duration_ms: durationMs,
    model_calls: modelCalls,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  };
  if (spec.toolName) output.tool_check = { name: spec.toolName, ok: true };
  const payload = deepFreeze({
    id: runId,
    trace_id: runId,
    name: spec.name,
    run_type: "chain",
    project_name: SYNTHETIC_PROJECT_NAME,
    start_time: startedAt,
    end_time: endedAt,
    inputs: { fixture_id: spec.fixtureId },
    outputs: output,
    tags: [...spec.tags],
    extra: {
      metadata: {
        purpose: "fixed-synthetic-connection-check",
        schema: SYNTHETIC_TRACE_SCHEMA,
        data_class: "synthetic",
        contains_customer_data: false,
        contains_private_document: false,
      },
    },
  });
  fixedSyntheticTraces.set(payload, Object.freeze({ digest: payloadDigest(payload) }));
  return payload;
}

function issueFixedSyntheticTraceAuthority(payload) {
  const provenance = payload && typeof payload === "object" ? fixedSyntheticTraces.get(payload) : null;
  if (!provenance) return null;
  try {
    const plain = clonePlainTraceData(payload);
    if (!plain || typeof plain !== "object" || Array.isArray(plain) || hasPrivateDocumentContent(plain)) return null;
    if (payloadDigest(plain) !== provenance.digest) return null;
  } catch {
    return null;
  }
  const authority = Object.freeze({ source: "fixed_internal_cli", schema: SYNTHETIC_TRACE_SCHEMA });
  authorities.set(authority, Object.freeze({
    dataClass: "synthetic",
    digest: provenance.digest,
    payload,
    schema: SYNTHETIC_TRACE_SCHEMA,
  }));
  return authority;
}

function prepareTraceExport(payload, {
  authority,
  containsPrivateDocument = false,
  maxPayloadBytes = MAX_PAYLOAD_BYTES,
} = {}) {
  let redacted;
  let body;
  let payloadBytes;
  try {
    const plain = clonePlainTraceData(payload);
    if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
      return { ok: false, result: fixedResult("denied", "TRACE_PAYLOAD_INVALID") };
    }
    if (containsPrivateDocument === true || hasPrivateDocumentContent(plain)) {
      return { ok: false, result: fixedResult("denied", "PRIVATE_DOCUMENT_EXPORT_DENIED") };
    }
    const provenance = fixedSyntheticTraces.get(payload);
    if (!provenance) {
      return { ok: false, result: fixedResult("denied", "TRACE_SCHEMA_REQUIRED") };
    }
    const trusted = authority && typeof authority === "object" ? authorities.get(authority) : null;
    if (!trusted || trusted.dataClass !== "synthetic" || trusted.schema !== SYNTHETIC_TRACE_SCHEMA) {
      return { ok: false, result: fixedResult("denied", "TRACE_AUTHORITY_REQUIRED") };
    }
    if (trusted.payload !== payload || provenance.digest !== trusted.digest || payloadDigest(plain) !== trusted.digest) {
      return { ok: false, result: fixedResult("denied", "TRACE_AUTHORITY_MISMATCH") };
    }
    redacted = clonePlainTraceData(redactTracePayload(plain));
    body = JSON.stringify(redacted);
    const roundTrip = JSON.parse(body);
    if (hasPrivateDocumentContent(roundTrip) || JSON.stringify(redactTracePayload(roundTrip)) !== body) {
      return { ok: false, result: fixedResult("denied", "TRACE_REDACTION_UNSTABLE") };
    }
    redacted = roundTrip;
    payloadBytes = Buffer.byteLength(body, "utf8");
  } catch {
    return { ok: false, result: fixedResult("denied", "TRACE_PAYLOAD_INVALID") };
  }
  if (payloadBytes > maxPayloadBytes) {
    return { ok: false, result: fixedResult("denied", "TRACE_PAYLOAD_TOO_LARGE") };
  }
  return {
    ok: true,
    outbound: Object.freeze({
      headers: Object.freeze({ "content-type": "application/json" }),
      body: redacted,
    }),
  };
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS);
}

function safeNotify(notify, event) {
  if (typeof notify !== "function") return;
  try {
    void Promise.resolve(notify(Object.freeze(event))).catch(() => {});
  } catch {
    // Optional telemetry must not become a second failure path.
  }
}

function settleTransportReceipt(receipt) {
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt) &&
      receipt.accepted === true && typeof receipt.receiptId === "string" && RECEIPT_ID.test(receipt.receiptId)) {
    return fixedResult("exported", "TRACE_EXPORTED", 1, "completed");
  }
  const status = Number(receipt?.status);
  if (receipt?.rejected === true || receipt?.ok === false && Number.isInteger(status) && status >= 400 && status < 500) {
    return fixedResult("rejected", "TRACE_EXPORT_REJECTED", 1, "failed_after_dispatch");
  }
  return fixedResult("uncertain", "TRACE_EXPORT_UNCERTAIN", 1, "transport_uncertain");
}

async function exportOptionalTrace({
  enabled = false,
  payload,
  authority,
  containsPrivateDocument = false,
  transport,
  beforeTransport,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  notify,
} = {}) {
  if (enabled !== true) return fixedResult("disabled", "TRACE_EXPORT_DISABLED");
  const prepared = prepareTraceExport(payload, { authority, containsPrivateDocument });
  if (!prepared.ok) {
    safeNotify(notify, { event: "optional_trace_export", outcome: prepared.result.code, attempts: 0 });
    return prepared.result;
  }
  if (typeof transport !== "function") {
    const unavailable = fixedResult("rejected", "TRACE_TRANSPORT_UNAVAILABLE");
    safeNotify(notify, { event: "optional_trace_export", outcome: unavailable.code, attempts: 0 });
    return unavailable;
  }

  const timeout = boundedTimeout(timeoutMs);
  if (typeof beforeTransport === "function") {
    const markController = new AbortController();
    let markTimer;
    const markDeadline = new Promise((resolve) => {
      markTimer = setTimeout(() => {
        markController.abort();
        resolve(fixedResult("timeout", "TRACE_DISPATCH_TIMEOUT", 0, "transport_uncertain"));
      }, timeout);
    });
    const markAttempt = Promise.resolve()
      .then(() => beforeTransport({ signal: markController.signal }))
      .then((dispatch) => dispatch?.ok === true
        ? null
        : fixedResult("rejected", "TRACE_DISPATCH_NOT_MARKED"))
      .catch(() => fixedResult("rejected", "TRACE_DISPATCH_NOT_MARKED"));
    const markResult = await Promise.race([markAttempt, markDeadline]);
    clearTimeout(markTimer);
    if (markResult) {
      markController.abort();
      safeNotify(notify, { event: "optional_trace_export", outcome: markResult.code, attempts: 0 });
      return markResult;
    }
  }

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fixedResult("timeout", "TRACE_EXPORT_TIMEOUT", 1, "transport_uncertain"));
    }, timeout);
  });
  const attempt = Promise.resolve()
    .then(() => transport(prepared.outbound, { signal: controller.signal }))
    .then(settleTransportReceipt)
    .catch((error) => error?.traceOutcome === "failed_after_dispatch"
      ? fixedResult("rejected", "TRACE_EXPORT_REJECTED", 1, "failed_after_dispatch")
      : fixedResult("uncertain", "TRACE_EXPORT_UNCERTAIN", 1, "transport_uncertain"));
  const result = await Promise.race([attempt, deadline]);
  clearTimeout(timer);
  if (result.status !== "exported") controller.abort();
  safeNotify(notify, { event: "optional_trace_export", outcome: result.code, attempts: result.attempts });
  return result;
}

async function finalizeAuditedWorkflow({
  customerResult,
  persistMandatoryAudit,
  dispatchConsequentialAction = null,
  optionalTrace = null,
} = {}) {
  let auditEvidence;
  try {
    if (typeof persistMandatoryAudit !== "function") throw new Error("Mandatory audit writer unavailable");
    auditEvidence = await persistMandatoryAudit();
    if (!auditEvidence || auditEvidence.persisted !== true) throw new Error("Mandatory audit was not confirmed");
  } catch {
    return Object.freeze({
      ok: false,
      code: "MANDATORY_AUDIT_FAILED",
      customerResult: null,
      auditEvidence: null,
      actionResult: null,
      optionalTrace: fixedResult("skipped", "TRACE_SKIPPED_AUDIT_FAILURE"),
    });
  }

  let actionResult = null;
  if (typeof dispatchConsequentialAction === "function") {
    actionResult = await dispatchConsequentialAction();
  }
  const traceResult = optionalTrace && typeof optionalTrace === "object"
    ? await exportOptionalTrace(optionalTrace)
    : fixedResult("disabled", "TRACE_EXPORT_DISABLED");
  return Object.freeze({
    ok: true,
    code: "WORKFLOW_COMPLETED",
    customerResult,
    auditEvidence,
    actionResult,
    optionalTrace: traceResult,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  SYNTHETIC_PROJECT_NAME,
  SYNTHETIC_TRACE_SCHEMA,
  createFixedSyntheticTracePayload,
  exportOptionalTrace,
  finalizeAuditedWorkflow,
  hasPrivateDocumentContent,
  issueFixedSyntheticTraceAuthority,
  prepareTraceExport,
};
