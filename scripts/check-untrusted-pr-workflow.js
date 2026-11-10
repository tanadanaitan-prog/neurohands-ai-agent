"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WORKFLOW_PATH = path.join(REPOSITORY_ROOT, ".github", "workflows", "untrusted-pr.yml");
const REVIEWED_WORKFLOW_SHA256 = "8d633db00bf4c29127ded17c103383ebba279d303856dee49229592381997c89";
const PINNED_CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const PINNED_NODE_IMAGE = "node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553";
const MAX_WORKFLOW_BYTES = 32 * 1024;

function normalizeSource(source) {
  return String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function workflowHash(source) {
  return crypto.createHash("sha256").update(normalizeSource(source), "utf8").digest("hex");
}

function extractRunBlocks(source) {
  const lines = normalizeSource(source).split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const value = match[2].trim();
    if (value && value !== "|") {
      blocks.push(value);
      continue;
    }
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.match(/^\s*/)[0].length <= indent) {
        index -= 1;
        break;
      }
      block.push(line);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function validateUntrustedPrWorkflowSource(source, { enforceFingerprint = true } = {}) {
  const normalized = normalizeSource(source);
  const errors = [];
  const byteLength = Buffer.byteLength(normalized, "utf8");
  const sha256 = workflowHash(normalized);

  if (!normalized.endsWith("\n")) errors.push("workflow must end with one reviewed newline");
  if (byteLength > MAX_WORKFLOW_BYTES) errors.push("workflow exceeds the bounded size limit");

  if (!/^on:\n  pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]$/m.test(normalized)) {
    errors.push("workflow trigger must be the reviewed pull_request event only");
  }
  if (/pull_request_target|workflow_dispatch|repository_dispatch|issue_comment|schedule:/i.test(normalized)) {
    errors.push("privileged or caller-controlled workflow triggers are prohibited");
  }

  if (countMatches(normalized, /^permissions:\s*$/gm) !== 1 ||
      !/^permissions:\n  contents: read\n$/m.test(normalized)) {
    errors.push("workflow permissions must be exactly contents: read");
  }
  if (/^\s*[a-z-]+:\s*(?:write|write-all)\s*$/gim.test(normalized) || /^permissions:\s*write-all\s*$/gim.test(normalized)) {
    errors.push("write permissions are prohibited");
  }

  if (/\$\{\{\s*secrets\./i.test(normalized) ||
      /(?:GITHUB_TOKEN|LINE_CHANNEL_|SUPABASE_|GEMINI_|OPENAI_|LANGSMITH_|RAILWAY_|NEUROHANDS_API_KEY)/i.test(normalized)) {
    errors.push("secret references and production credential names are prohibited");
  }
  if (/--env-file|persist-credentials:\s*true/i.test(normalized)) {
    errors.push("credential persistence or environment-file injection is prohibited");
  }

  const actions = [...normalized.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  if (actions.length !== 2 || actions.some((action) => action !== PINNED_CHECKOUT)) {
    errors.push("only the reviewed actions/checkout commit may be used, exactly twice");
  }
  if (actions.some((action) => !/@[0-9a-f]{40}$/.test(action))) {
    errors.push("every action must be pinned to a full 40-character commit SHA");
  }
  if (countMatches(normalized, /^\s+persist-credentials:\s*false\s*$/gm) !== 2) {
    errors.push("both checkouts must disable credential persistence");
  }
  if (!normalized.includes("ref: ${{ github.event.pull_request.base.sha }}") ||
      !normalized.includes("path: trusted-guard") || !normalized.includes("path: candidate")) {
    errors.push("the policy checker must come from the trusted base commit and inspect a separate candidate checkout");
  }

  if (countMatches(normalized, /^\s+timeout-minutes:\s*10\s*$/gm) !== 1 || /continue-on-error:\s*true/i.test(normalized)) {
    errors.push("the job needs the reviewed ten-minute hard timeout and fail-closed steps");
  }

  const runBlocks = extractRunBlocks(normalized);
  if (runBlocks.length !== 2) errors.push("workflow must contain exactly the two reviewed fixed command blocks");
  if (runBlocks.some((block) => /\$\{\{|github\.event|\bINPUT_[A-Z0-9_]*\b|\beval\s+|`/.test(block))) {
    errors.push("shell commands must not contain caller-controlled expressions or dynamic evaluation");
  }
  if (!runBlocks.some((block) => block.trim() ===
      "node scripts/check-untrusted-pr-workflow.js ../candidate/.github/workflows/untrusted-pr.yml")) {
    errors.push("candidate policy must be checked by the fixed trusted-base command");
  }

  if (!normalized.includes(`readonly c10_image='${PINNED_NODE_IMAGE}'`)) {
    errors.push("the probe container image must be pinned to the reviewed digest");
  }
  if (!normalized.includes("npm ci --ignore-scripts --no-audit --no-fund")) {
    errors.push("dependencies must be installed without lifecycle scripts, audit calls, or funding calls");
  }
  if (countMatches(normalized, /^\s+--network none \\$/gm) !== 2 ||
      !normalized.includes("node --test test/untrusted-execution-boundary.test.js")) {
    errors.push("the actual adversarial probe and network preflight must run with Docker outbound networking denied");
  }
  for (const required of [
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--user 65532:65532",
    "target=/workspace,readonly",
    "target=/workspace/node_modules,readonly",
  ]) {
    if (!normalized.includes(required)) errors.push(`isolated probe is missing required boundary: ${required}`);
  }

  if (enforceFingerprint && sha256 !== REVIEWED_WORKFLOW_SHA256) {
    errors.push("workflow differs from the exact reviewed fixed-command policy");
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    sha256,
    reviewedSha256: REVIEWED_WORKFLOW_SHA256,
    actionCount: actions.length,
    runBlockCount: runBlocks.length,
    networkDeniedProbeCount: countMatches(normalized, /^\s+--network none \\$/gm),
  });
}

function checkUntrustedPrWorkflow(filePath = DEFAULT_WORKFLOW_PATH) {
  const resolved = path.resolve(filePath);
  let source;
  try {
    source = fs.readFileSync(resolved, "utf8");
  } catch {
    return Object.freeze({
      ok: false,
      file: resolved,
      errors: Object.freeze(["untrusted pull-request workflow could not be read"]),
    });
  }
  const validation = validateUntrustedPrWorkflowSource(source);
  return Object.freeze({ ok: validation.valid, file: resolved, ...validation });
}

if (require.main === module) {
  const unknown = process.argv.slice(3);
  const result = unknown.length > 0
    ? { ok: false, errors: [`Unexpected arguments: ${unknown.join(" ")}`] }
    : checkUntrustedPrWorkflow(process.argv[2] || DEFAULT_WORKFLOW_PATH);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = {
  DEFAULT_WORKFLOW_PATH,
  PINNED_CHECKOUT,
  PINNED_NODE_IMAGE,
  REVIEWED_WORKFLOW_SHA256,
  checkUntrustedPrWorkflow,
  extractRunBlocks,
  validateUntrustedPrWorkflowSource,
  workflowHash,
};
