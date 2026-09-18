"use strict";

const { createHash } = require("node:crypto");

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,199}$/;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const ACTIONS = Object.freeze({
  railway_deploy: "railway_production",
  github_merge: "github_main",
});
const STORE_DECISIONS = new Set([
  "claimed",
  "idempotent_replay",
  "not_found",
  "commit_mismatch",
  "expired",
  "already_used",
  "conflict",
  "uncertain",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixedDecision({ allowed = false, code, replay = false, claimId = null, commitSha = null } = {}) {
  return Object.freeze({ allowed, code, replay, claimId, commitSha });
}

function fixedExecution({ ok = false, code, uncertain = false, approval, deployment = null } = {}) {
  return Object.freeze({
    ok,
    code,
    uncertain,
    approval: fixedDecision(approval || { code: "DEPLOYMENT_APPROVAL_DENIED" }),
    deployment,
  });
}

function snapshotRequest(input) {
  try {
    const value = input && typeof input === "object" ? input : {};
    return Object.freeze({
      approvalId: value.approvalId,
      commitSha: value.commitSha,
      deploymentKey: value.deploymentKey,
      requesterId: value.requesterId,
      action: value.action,
      target: value.target,
    });
  } catch {
    return null;
  }
}

function validateRequest({ approvalId, commitSha, deploymentKey, requesterId, action, target } = {}) {
  if (typeof approvalId !== "string" || !UUID.test(approvalId)) return "DEPLOYMENT_APPROVAL_ID_INVALID";
  if (typeof commitSha !== "string" || !COMMIT_SHA.test(commitSha)) return "DEPLOYMENT_COMMIT_INVALID";
  if (typeof deploymentKey !== "string" || !STABLE_KEY.test(deploymentKey)) return "DEPLOYMENT_KEY_INVALID";
  if (typeof requesterId !== "string" || !PRINCIPAL.test(requesterId)) return "DEPLOYMENT_REQUESTER_INVALID";
  if (!Object.hasOwn(ACTIONS, action) || target !== ACTIONS[action]) return "DEPLOYMENT_TARGET_INVALID";
  return null;
}

function publicClaim(value) {
  let decision;
  let claimId;
  let approvedCommitSha;
  let founderApproved;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid claim");
    decision = value.decision;
    claimId = value.claimId;
    approvedCommitSha = value.approvedCommitSha;
    founderApproved = value.founderApproved;
  } catch {
    return Object.freeze({ decision: "uncertain", claimId: null, approvedCommitSha: null, founderApproved: false });
  }
  if (!STORE_DECISIONS.has(decision)) {
    return Object.freeze({ decision: "uncertain", claimId: null, approvedCommitSha: null, founderApproved: false });
  }
  return Object.freeze({
    decision,
    claimId: typeof claimId === "string" && UUID.test(claimId) ? claimId : null,
    approvedCommitSha: typeof approvedCommitSha === "string" && COMMIT_SHA.test(approvedCommitSha)
      ? approvedCommitSha
      : null,
    founderApproved: founderApproved === true,
  });
}

function createSupabaseDeploymentApprovalStore({ rpc } = {}) {
  if (typeof rpc !== "function") throw new TypeError("A server-only Supabase RPC function is required");
  return Object.freeze({
    durable: true,
    async claimExactCommit({ approvalId, commitSha, deploymentKey, requesterId, action, target, requestDigest }) {
      let response;
      try {
        response = await rpc("nh_claim_deployment_approval", {
          p_approval_id: approvalId,
          p_commit_sha: commitSha,
          p_deployment_key: deploymentKey,
          p_requester_id: requesterId,
          p_action: action,
          p_target: target,
          p_request_digest: requestDigest,
        });
        if (!response || response.error || !("data" in response)) {
          return publicClaim({ decision: "uncertain" });
        }
        const row = Array.isArray(response.data) ? response.data[0] : response.data;
        return publicClaim({
          decision: row?.decision,
          claimId: row?.claim_id,
          approvedCommitSha: row?.approved_commit_sha,
          founderApproved: row?.founder_approved === true,
        });
      } catch {
        return publicClaim({ decision: "uncertain" });
      }
    },
  });
}

async function safeAudit(audit, entry) {
  try {
    const receipt = await audit(Object.freeze(entry));
    return receipt?.persisted === true;
  } catch {
    return false;
  }
}

function createDeploymentApprovalControl({ store, audit } = {}) {
  const ready = store?.durable === true && typeof store?.claimExactCommit === "function" && typeof audit === "function";

  async function authorizeSnapshot(input) {
    if (!ready) return fixedDecision({ code: "DEPLOYMENT_APPROVAL_DEPENDENCIES_REQUIRED" });
    const invalid = input ? validateRequest(input) : "DEPLOYMENT_REQUEST_INVALID";
    if (invalid) {
      const auditPersisted = await safeAudit(audit, { event: "deployment_approval_denied", outcome: invalid });
      return fixedDecision({ code: auditPersisted ? invalid : "DEPLOYMENT_APPROVAL_AUDIT_FAILED" });
    }
    const requestDigest = sha256(JSON.stringify({
      action: input.action,
      approvalId: input.approvalId,
      commitSha: input.commitSha,
      deploymentKey: input.deploymentKey,
      requesterId: input.requesterId,
      target: input.target,
    }));
    let claim;
    try {
      claim = publicClaim(await store.claimExactCommit(Object.freeze({
        approvalId: input.approvalId,
        commitSha: input.commitSha,
        deploymentKey: input.deploymentKey,
        requesterId: input.requesterId,
        action: input.action,
        target: input.target,
        requestDigest,
      })));
    } catch {
      claim = publicClaim({ decision: "uncertain" });
    }

    const codes = {
      idempotent_replay: "DEPLOYMENT_APPROVAL_REPLAY",
      not_found: "DEPLOYMENT_APPROVAL_MISSING",
      commit_mismatch: "DEPLOYMENT_COMMIT_NOT_APPROVED",
      expired: "DEPLOYMENT_APPROVAL_EXPIRED",
      already_used: "DEPLOYMENT_APPROVAL_USED",
      conflict: "DEPLOYMENT_APPROVAL_CONFLICT",
      uncertain: "DEPLOYMENT_APPROVAL_UNCERTAIN",
    };
    const exactClaim = claim.decision === "claimed" && claim.claimId && claim.founderApproved === true &&
      claim.approvedCommitSha === input.commitSha;
    const code = exactClaim ? "DEPLOYMENT_APPROVED" : codes[claim.decision] || "DEPLOYMENT_APPROVAL_UNCERTAIN";
    const auditPersisted = await safeAudit(audit, {
      event: exactClaim ? "deployment_approval_claimed" : "deployment_approval_denied",
      outcome: code,
      action: input.action,
      target: input.target,
      commitSha: input.commitSha,
      requesterId: input.requesterId,
      approvalRef: sha256(input.approvalId),
      deploymentRef: sha256(input.deploymentKey),
      claimId: claim.claimId,
    });
    if (!auditPersisted) return fixedDecision({ code: "DEPLOYMENT_APPROVAL_AUDIT_FAILED" });
    if (!exactClaim) return fixedDecision({
      code,
      replay: claim.decision === "idempotent_replay",
    });
    return fixedDecision({
      allowed: true,
      code,
      claimId: claim.claimId,
      commitSha: input.commitSha,
    });
  }

  async function authorize(input = {}) {
    return authorizeSnapshot(snapshotRequest(input));
  }

  async function execute(input = {}, deploy) {
    if (typeof deploy !== "function") {
      return fixedExecution({ code: "DEPLOYMENT_ADAPTER_REQUIRED", approval: { code: "DEPLOYMENT_NOT_AUTHORIZED" } });
    }
    const request = snapshotRequest(input);
    const approval = await authorizeSnapshot(request);
    if (!approval.allowed) return fixedExecution({ code: approval.code, approval });

    let providerResult;
    try {
      providerResult = await deploy(Object.freeze({
        action: request.action,
        target: request.target,
        commitSha: approval.commitSha,
        claimId: approval.claimId,
      }));
    } catch {
      providerResult = null;
    }
    let completed = false;
    let definitelyRejected = false;
    try {
      completed = providerResult?.status === "completed" && providerResult.commitSha === approval.commitSha;
      definitelyRejected = providerResult?.status === "rejected";
    } catch {
      completed = false;
      definitelyRejected = false;
    }
    const code = completed
      ? "DEPLOYMENT_COMPLETED"
      : definitelyRejected
        ? "DEPLOYMENT_REJECTED"
        : "DEPLOYMENT_OUTCOME_UNCERTAIN";
    const outcomePersisted = await safeAudit(audit, {
      event: "deployment_attempt_finished",
      outcome: code,
      action: request.action,
      target: request.target,
      commitSha: approval.commitSha,
      requesterId: request.requesterId,
      claimId: approval.claimId,
    });
    if (!outcomePersisted) {
      return fixedExecution({
        code: "DEPLOYMENT_OUTCOME_AUDIT_FAILED",
        uncertain: true,
        approval,
      });
    }
    return fixedExecution({
      ok: completed,
      code,
      uncertain: !completed && !definitelyRejected,
      approval,
      deployment: Object.freeze({
        status: completed ? "completed" : definitelyRejected ? "rejected" : "uncertain",
        commitSha: completed ? approval.commitSha : null,
      }),
    });
  }

  return Object.freeze({ ready, authorize, execute });
}

module.exports = {
  createDeploymentApprovalControl,
  createSupabaseDeploymentApprovalStore,
};
