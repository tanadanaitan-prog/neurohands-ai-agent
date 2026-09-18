const crypto = require("node:crypto");

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_DECISIONS = new Set(["acquired", "completed", "conflict", "in_progress", "failed", "uncertain"]);
const TERMINAL_STATES = new Set(["completed", "failed", "uncertain"]);

function validIdempotencyKey(value) {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashIdempotencyKey(value) {
  if (!validIdempotencyKey(value)) throw new Error("Invalid Idempotency-Key");
  return sha256(value);
}

function hashLineUser(value) {
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("Invalid API user identity");
  return sha256(value);
}

function requestDigest({ clientAccountId, department, lineUserId, message }) {
  if ((!Number.isSafeInteger(clientAccountId) && typeof clientAccountId !== "string") || !String(clientAccountId).match(/^\d+$/)) {
    throw new Error("Invalid client account identity");
  }
  if (typeof department !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(department)) throw new Error("Invalid department");
  if (typeof message !== "string" || !message.trim() || message.length > 12000) throw new Error("Invalid message");
  return sha256(JSON.stringify({
    version: 1,
    clientAccountId: String(clientAccountId),
    department,
    lineUserId,
    message,
  }));
}

function oneRow(value, operation) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    throw new Error(`${operation} was not confirmed`);
  }
  return value[0];
}

function normalizedResult(row, operation) {
  const decision = row.decision;
  const state = row.state;
  const executionId = row.execution_id;
  const requestedAt = row.requested_at;
  if (!CLAIM_DECISIONS.has(decision) || !["in_progress", ...TERMINAL_STATES].includes(state) ||
      typeof executionId !== "string" || !UUID.test(executionId) ||
      typeof requestedAt !== "string" || !Number.isFinite(Date.parse(requestedAt))) {
    throw new Error(`${operation} returned an invalid lifecycle result`);
  }
  const expectedState = decision === "acquired" ? "in_progress" : decision;
  if (decision !== "conflict" && state !== expectedState) {
    throw new Error(`${operation} returned an inconsistent lifecycle result`);
  }
  if (decision !== "completed" && (row.response_status !== null && row.response_status !== undefined ||
      row.response_body !== null && row.response_body !== undefined)) {
    throw new Error(`${operation} exposed a response outside completed replay`);
  }
  const result = { decision, state, executionId, requestedAt };
  if (Number.isSafeInteger(row.run_id) && row.run_id > 0) result.runId = row.run_id;
  if (decision === "completed") {
    if (!Number.isSafeInteger(row.response_status) || row.response_status < 200 || row.response_status > 599 ||
        !row.response_body || Array.isArray(row.response_body) || typeof row.response_body !== "object") {
      throw new Error(`${operation} returned an invalid completed response`);
    }
    result.responseStatus = row.response_status;
    result.responseBody = row.response_body;
  }
  return Object.freeze(result);
}

function createAgentApiIdempotency({ db }) {
  if (typeof db !== "function") throw new Error("A private database client is required");

  async function claim({ idempotencyKey, clientAccountId, department, lineUserId, message }) {
    const keyHash = hashIdempotencyKey(idempotencyKey);
    const digest = requestDigest({ clientAccountId, department, lineUserId, message });
    const rows = await db("rpc/nh_claim_agent_api_request", {
      method: "POST",
      body: {
        p_idempotency_key_hash: keyHash,
        p_request_digest: digest,
        p_client_account_id: clientAccountId,
        p_department: department,
        p_line_user_id_hash: hashLineUser(lineUserId),
      },
    });
    return Object.freeze({
      ...normalizedResult(oneRow(rows, "API request claim"), "API request claim"),
      keyHash,
      requestDigest: digest,
    });
  }

  async function finish(claimed, { state, responseStatus = null, responseBody = null, runId = null, errorCode = null }) {
    if (!claimed || !SHA256.test(claimed.keyHash || "") || !SHA256.test(claimed.requestDigest || "") ||
        !UUID.test(claimed.executionId || "") || !TERMINAL_STATES.has(state)) {
      throw new Error("Invalid API request completion");
    }
    if (state === "completed" && (!Number.isSafeInteger(responseStatus) || responseStatus < 200 || responseStatus > 599 ||
        !responseBody || Array.isArray(responseBody) || typeof responseBody !== "object")) {
      throw new Error("A completed API request requires its exact response");
    }
    const rows = await db("rpc/nh_finish_agent_api_request", {
      method: "POST",
      body: {
        p_client_account_id: claimed.clientAccountId,
        p_idempotency_key_hash: claimed.keyHash,
        p_request_digest: claimed.requestDigest,
        p_execution_id: claimed.executionId,
        p_state: state,
        p_response_status: responseStatus,
        p_response_body: responseBody,
        p_run_id: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
        p_error_code: typeof errorCode === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : null,
      },
    });
    return normalizedResult(oneRow(rows, "API request completion"), "API request completion");
  }

  return Object.freeze({ claim: async (input) => {
    const result = await claim(input);
    return Object.freeze({ ...result, clientAccountId: input.clientAccountId });
  }, finish });
}

module.exports = {
  createAgentApiIdempotency,
  hashIdempotencyKey,
  requestDigest,
  validIdempotencyKey,
};
