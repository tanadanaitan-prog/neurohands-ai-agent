"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDeploymentApprovalControl,
  createSupabaseDeploymentApprovalStore,
} = require("../src/lib/deployment-approval");

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const request = Object.freeze({
  approvalId: APPROVAL_ID,
  commitSha: COMMIT,
  deploymentKey: "release.neurohands.2026-09-18.0001",
  requesterId: "codex-release-agent",
  action: "railway_deploy",
  target: "railway_production",
});

function durableStore(decision = "claimed") {
  const calls = [];
  return {
    durable: true,
    calls,
    async claimExactCommit(input) {
      calls.push(input);
      return {
        decision,
        claimId: decision === "claimed" || decision === "idempotent_replay" ? CLAIM_ID : null,
        approvedCommitSha: decision === "commit_mismatch" ? OTHER_COMMIT : COMMIT,
        founderApproved: true,
      };
    },
  };
}

function control(store = durableStore(), auditResult = { persisted: true }) {
  const audits = [];
  return {
    store,
    audits,
    gate: createDeploymentApprovalControl({
      store,
      audit: async (entry) => { audits.push(entry); return auditResult; },
    }),
  };
}

test("an exact durable founder claim is audited before one exact commit is deployed", async () => {
  const state = control();
  const deployCalls = [];
  const result = await state.gate.execute(request, async (input) => {
    deployCalls.push(input);
    return { status: "completed", commitSha: input.commitSha, private: "must-not-leak" };
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "DEPLOYMENT_COMPLETED");
  assert.equal(result.approval.code, "DEPLOYMENT_APPROVED");
  assert.deepEqual(deployCalls, [{
    action: "railway_deploy", target: "railway_production", commitSha: COMMIT, claimId: CLAIM_ID,
  }]);
  assert.equal(Object.isFrozen(deployCalls[0]), true);
  assert.deepEqual(state.audits.map((entry) => entry.event), [
    "deployment_approval_claimed", "deployment_attempt_finished",
  ]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.match(state.store.calls[0].requestDigest, /^[0-9a-f]{64}$/);
});

test("missing, wrong, expired, used, conflicting and uncertain approvals make zero deployment calls", async (t) => {
  const cases = [
    ["not_found", "DEPLOYMENT_APPROVAL_MISSING"],
    ["commit_mismatch", "DEPLOYMENT_COMMIT_NOT_APPROVED"],
    ["expired", "DEPLOYMENT_APPROVAL_EXPIRED"],
    ["already_used", "DEPLOYMENT_APPROVAL_USED"],
    ["conflict", "DEPLOYMENT_APPROVAL_CONFLICT"],
    ["uncertain", "DEPLOYMENT_APPROVAL_UNCERTAIN"],
  ];
  for (const [decision, code] of cases) await t.test(decision, async () => {
    const state = control(durableStore(decision));
    let deployCalls = 0;
    const result = await state.gate.execute(request, async () => { deployCalls += 1; });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(deployCalls, 0);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].outcome, code);
  });
});

test("a replayed durable claim cannot execute deployment a second time", async () => {
  let claimed = false;
  const store = {
    durable: true,
    async claimExactCommit() {
      if (claimed) return {
        decision: "idempotent_replay", claimId: CLAIM_ID, approvedCommitSha: COMMIT, founderApproved: true,
      };
      claimed = true;
      return { decision: "claimed", claimId: CLAIM_ID, approvedCommitSha: COMMIT, founderApproved: true };
    },
  };
  const state = control(store);
  let deployCalls = 0;
  const deploy = async ({ commitSha }) => {
    deployCalls += 1;
    return { status: "completed", commitSha };
  };
  assert.equal((await state.gate.execute(request, deploy)).ok, true);
  const replay = await state.gate.execute(request, deploy);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "DEPLOYMENT_APPROVAL_REPLAY");
  assert.equal(replay.approval.replay, true);
  assert.equal(deployCalls, 1);
});

test("concurrent requests sharing one approval can call the deployment adapter at most once", async () => {
  let claimed = false;
  const store = {
    durable: true,
    async claimExactCommit() {
      if (claimed) return { decision: "already_used", approvedCommitSha: COMMIT, founderApproved: true };
      claimed = true;
      await Promise.resolve();
      return { decision: "claimed", claimId: CLAIM_ID, approvedCommitSha: COMMIT, founderApproved: true };
    },
  };
  const state = control(store);
  let deployCalls = 0;
  const results = await Promise.all([1, 2].map(() => state.gate.execute(request, async ({ commitSha }) => {
    deployCalls += 1;
    return { status: "completed", commitSha };
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(deployCalls, 1);
});

test("invalid requests and failed approval audit are denied before deployment", async () => {
  for (const bad of [
    { commitSha: "main" },
    { commitSha: OTHER_COMMIT.toUpperCase() },
    { approvalId: "not-an-approval" },
    { deploymentKey: "short" },
    { requesterId: "raw id with spaces" },
    { target: "railway_preview" },
    { action: "arbitrary_shell" },
  ]) {
    const state = control();
    let deployCalls = 0;
    const result = await state.gate.execute({ ...request, ...bad }, async () => { deployCalls += 1; });
    assert.equal(result.ok, false);
    assert.equal(deployCalls, 0);
    assert.equal(state.store.calls.length, 0);
  }

  const failedAudit = control(durableStore(), { persisted: false });
  let deployCalls = 0;
  const result = await failedAudit.gate.execute(request, async () => { deployCalls += 1; });
  assert.equal(result.code, "DEPLOYMENT_APPROVAL_AUDIT_FAILED");
  assert.equal(deployCalls, 0);
});

test("a claim without explicit founder approval is uncertain and cannot deploy", async () => {
  for (const founderApproved of [false, undefined]) {
    const store = {
      durable: true,
      async claimExactCommit() {
        return { decision: "claimed", claimId: CLAIM_ID, approvedCommitSha: COMMIT, founderApproved };
      },
    };
    const state = control(store);
    let deployCalls = 0;
    const result = await state.gate.execute(request, async () => { deployCalls += 1; });
    assert.equal(result.code, "DEPLOYMENT_APPROVAL_UNCERTAIN");
    assert.equal(deployCalls, 0);
  }
});

test("one immutable request snapshot is used from claim through deployment", async () => {
  const mutable = { ...request };
  const store = {
    durable: true,
    async claimExactCommit(input) {
      assert.equal(Object.isFrozen(input), true);
      mutable.action = "github_merge";
      mutable.target = "github_main";
      mutable.commitSha = OTHER_COMMIT;
      return { decision: "claimed", claimId: CLAIM_ID, approvedCommitSha: COMMIT, founderApproved: true };
    },
  };
  const state = control(store);
  let received;
  const result = await state.gate.execute(mutable, async (input) => {
    received = input;
    return { status: "completed", commitSha: input.commitSha };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(received, {
    action: "railway_deploy", target: "railway_production", commitSha: COMMIT, claimId: CLAIM_ID,
  });
});

test("wrong or uncertain deployment receipts never claim completion and consume the approval", async () => {
  for (const deploy of [
    async () => ({ status: "completed", commitSha: OTHER_COMMIT }),
    async () => ({ status: "unknown" }),
    async () => { throw new Error("private provider failure"); },
    async () => new Proxy({}, { get() { throw new Error("private receipt getter"); } }),
  ]) {
    const state = control();
    const result = await state.gate.execute(request, deploy);
    assert.equal(result.ok, false);
    assert.equal(result.code, "DEPLOYMENT_OUTCOME_UNCERTAIN");
    assert.equal(result.uncertain, true);
    assert.equal(JSON.stringify(result).includes("private provider failure"), false);
  }
  const rejected = await control().gate.execute(request, async () => ({ status: "rejected", detail: "private" }));
  assert.equal(rejected.code, "DEPLOYMENT_REJECTED");
  assert.equal(rejected.uncertain, false);
});

test("missing durable dependencies and deployment adapters stay closed", async () => {
  for (const gate of [
    createDeploymentApprovalControl(),
    createDeploymentApprovalControl({ store: { durable: false, claimExactCommit() {} }, audit: async () => ({ persisted: true }) }),
    createDeploymentApprovalControl({ store: durableStore(), audit: null }),
  ]) {
    assert.equal(gate.ready, false);
    assert.equal((await gate.authorize(request)).code, "DEPLOYMENT_APPROVAL_DEPENDENCIES_REQUIRED");
  }
  const state = control();
  const result = await state.gate.execute(request);
  assert.equal(result.code, "DEPLOYMENT_ADAPTER_REQUIRED");
  assert.equal(state.store.calls.length, 0);
});

test("the Supabase adapter uses one atomic RPC and sanitizes provider failures", async () => {
  const calls = [];
  const store = createSupabaseDeploymentApprovalStore({ rpc: async (name, parameters) => {
    calls.push([name, parameters]);
    return {
      data: [{
        decision: "claimed", claim_id: CLAIM_ID, approved_commit_sha: COMMIT, founder_approved: true,
      }],
      error: null,
    };
  } });
  const claimed = await store.claimExactCommit({ ...request, requestDigest: "c".repeat(64) });
  assert.equal(store.durable, true);
  assert.deepEqual(claimed, {
    decision: "claimed", claimId: CLAIM_ID, approvedCommitSha: COMMIT, founderApproved: true,
  });
  assert.deepEqual(calls, [["nh_claim_deployment_approval", {
    p_approval_id: APPROVAL_ID,
    p_commit_sha: COMMIT,
    p_deployment_key: request.deploymentKey,
    p_requester_id: request.requesterId,
    p_action: request.action,
    p_target: request.target,
    p_request_digest: "c".repeat(64),
  }]]);

  for (const rpc of [
    async () => { throw new Error("private RPC failure"); },
    async () => ({ data: null, error: { message: "private database detail" } }),
    async () => ({ data: [{ decision: "invented", secret: "private" }], error: null }),
    async () => new Proxy({}, { get() { throw new Error("private RPC getter"); } }),
  ]) {
    const uncertain = await createSupabaseDeploymentApprovalStore({ rpc }).claimExactCommit({
      ...request, requestDigest: "d".repeat(64),
    });
    assert.deepEqual(uncertain, {
      decision: "uncertain", claimId: null, approvedCommitSha: null, founderApproved: false,
    });
    assert.equal(JSON.stringify(uncertain).includes("private"), false);
  }
  assert.throws(() => createSupabaseDeploymentApprovalStore(), /server-only Supabase RPC/);
});

test("denials expose only fixed outcomes, not the approved commit or claim identifier", async () => {
  const store = {
    durable: true,
    async claimExactCommit() {
      return {
        decision: "commit_mismatch", claimId: CLAIM_ID, approvedCommitSha: OTHER_COMMIT, founderApproved: true,
      };
    },
  };
  const result = await control(store).gate.authorize(request);
  assert.deepEqual(result, {
    allowed: false,
    code: "DEPLOYMENT_COMMIT_NOT_APPROVED",
    replay: false,
    claimId: null,
    commitSha: null,
  });
  assert.equal(JSON.stringify(result).includes(OTHER_COMMIT), false);
  assert.equal(JSON.stringify(result).includes(CLAIM_ID), false);
});

test("approval and result objects cannot be mutated into authorization", async () => {
  const state = control(durableStore("expired"));
  const denied = await state.gate.authorize(request);
  assert.equal(Object.isFrozen(denied), true);
  assert.throws(() => { denied.allowed = true; }, TypeError);
  const result = await state.gate.execute(request, async () => ({ status: "completed", commitSha: COMMIT }));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.approval), true);
  assert.throws(() => { result.ok = true; }, TypeError);
});
