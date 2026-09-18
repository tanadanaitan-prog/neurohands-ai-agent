const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createAgentApiIdempotency,
  hashIdempotencyKey,
  requestDigest,
  validIdempotencyKey,
} = require("../src/lib/api-agent-idempotency");

const executionId = "84b1045d-5988-4b16-97da-070eedb7a12c";
const requestedAt = "2026-09-18T02:30:00.000Z";

test("agent API idempotency validates opaque request IDs and binds the complete request scope", () => {
  assert.equal(validIdempotencyKey("request-12345678"), true);
  for (const value of [undefined, "short", " space-bad", "bad/slash-value", "x".repeat(129)]) {
    assert.equal(validIdempotencyKey(value), false);
  }
  const base = { clientAccountId: 1, department: "sales", lineUserId: "line-one", message: "same message" };
  const first = requestDigest(base);
  assert.match(first, /^[0-9a-f]{64}$/);
  for (const changed of [
    { ...base, clientAccountId: 2 },
    { ...base, department: "support" },
    { ...base, lineUserId: "line-two" },
    { ...base, message: "changed message" },
  ]) assert.notEqual(requestDigest(changed), first);
});

test("claim sends only hashes and scope metadata to the atomic RPC", async () => {
  const calls = [];
  const store = createAgentApiIdempotency({ db: async (path, options) => {
    calls.push({ path, options });
    return [{ decision: "acquired", execution_id: executionId, requested_at: requestedAt,
      state: "in_progress", response_status: null, response_body: null, run_id: null }];
  } });
  const result = await store.claim({
    idempotencyKey: "request-private-123",
    clientAccountId: 41,
    department: "sales",
    lineUserId: "private-line-user",
    message: "private customer message",
  });
  assert.equal(result.decision, "acquired");
  assert.equal(result.clientAccountId, 41);
  assert.equal(calls[0].path, "rpc/nh_claim_agent_api_request");
  assert.equal(calls[0].options.body.p_idempotency_key_hash, hashIdempotencyKey("request-private-123"));
  const serialized = JSON.stringify(calls[0]);
  assert.doesNotMatch(serialized, /request-private-123|private-line-user|private customer message/);
});

test("completed replay is accepted only with an exact stored response", async () => {
  const body = { department: "sales", reply: "stored", run_id: 19, status: "completed" };
  const store = createAgentApiIdempotency({ db: async () => [{
    decision: "completed", execution_id: executionId, requested_at: requestedAt,
    state: "completed", response_status: 200, response_body: body, run_id: 19,
  }] });
  const result = await store.claim({ idempotencyKey: "request-replay-123", clientAccountId: 1,
    department: "sales", lineUserId: "line", message: "message" });
  assert.deepEqual(result.responseBody, body);
  assert.equal(result.responseStatus, 200);
});

test("completion is bound to the acquired tenant, digest and execution identity", async () => {
  const calls = [];
  const store = createAgentApiIdempotency({ db: async (path, options) => {
    calls.push({ path, options });
    if (path.includes("claim")) return [{ decision: "acquired", execution_id: executionId,
      requested_at: requestedAt, state: "in_progress", response_status: null, response_body: null, run_id: null }];
    return [{ decision: "completed", execution_id: executionId, requested_at: requestedAt,
      state: "completed", response_status: 200, response_body: { ok: true }, run_id: 7 }];
  } });
  const claim = await store.claim({ idempotencyKey: "request-finish-123", clientAccountId: 9,
    department: "finance", lineUserId: "line", message: "message" });
  const finished = await store.finish(claim, { state: "completed", responseStatus: 200,
    responseBody: { ok: true }, runId: 7 });
  assert.equal(finished.state, "completed");
  const parameters = calls[1].options.body;
  assert.equal(parameters.p_client_account_id, 9);
  assert.equal(parameters.p_request_digest, claim.requestDigest);
  assert.equal(parameters.p_execution_id, executionId);
  assert.equal(parameters.p_run_id, 7);
});

test("malformed database lifecycle replies fail closed", async () => {
  const input = { idempotencyKey: "request-invalid-123", clientAccountId: 1,
    department: "sales", lineUserId: "line", message: "message" };
  for (const response of [[], [{ decision: "acquired" }], [{
    decision: "completed", execution_id: crypto.randomUUID(), requested_at: requestedAt,
    state: "completed", response_status: null, response_body: null,
  }], [{
    decision: "acquired", execution_id: crypto.randomUUID(), requested_at: requestedAt,
    state: "completed", response_status: 200, response_body: { reply: "must-not-replay" },
  }], [{
    decision: "conflict", execution_id: crypto.randomUUID(), requested_at: requestedAt,
    state: "completed", response_status: 200, response_body: { reply: "must-not-leak" },
  }]]) {
    const store = createAgentApiIdempotency({ db: async () => response });
    await assert.rejects(store.claim(input), /not confirmed|invalid|inconsistent|exposed/i);
  }
});
