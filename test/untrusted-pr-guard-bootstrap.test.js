"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  PINNED_CHECKOUT,
  PINNED_NODE_IMAGE,
  REVIEWED_WORKFLOW_SHA256,
  checkUntrustedPrWorkflow,
  extractRunBlocks,
  validateUntrustedPrWorkflowSource,
  workflowHash,
} = require("../scripts/check-untrusted-pr-workflow");

const REVIEWED_FIXTURE_PATH = path.join(__dirname, "fixtures", "untrusted-pr-reviewed.yml");
const WORKFLOW = readFileSync(REVIEWED_FIXTURE_PATH, "utf8").replace(/\r\n?/g, "\n");

function mutate(from, to) {
  assert.equal(WORKFLOW.includes(from), true, `fixture is missing: ${from}`);
  return WORKFLOW.replace(from, to);
}

function errorsFor(source) {
  return validateUntrustedPrWorkflowSource(source).errors.join("\n");
}

test("C10 workflow is the exact reviewed read-only pull-request policy", () => {
  const result = checkUntrustedPrWorkflow(REVIEWED_FIXTURE_PATH);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.sha256, REVIEWED_WORKFLOW_SHA256);
  assert.equal(workflowHash(WORKFLOW), REVIEWED_WORKFLOW_SHA256);
  assert.equal(result.actionCount, 2);
  assert.equal(result.runBlockCount, 2);
  assert.equal(result.networkDeniedProbeCount, 2);
  assert.match(WORKFLOW, new RegExp(PINNED_CHECKOUT.replace("/", "\\/"), "g"));
  assert.equal(WORKFLOW.includes(PINNED_NODE_IMAGE), true);
});

test("C10 checker rejects secret injection before untrusted code runs", () => {
  const source = mutate(
    "permissions:\n  contents: read\n",
    "permissions:\n  contents: read\n\nenv:\n  PROD: ${{ secrets.PRODUCTION_API_KEY }}\n",
  );
  assert.match(errorsFor(source), /secret references and production credential names are prohibited/);
});

test("C10 checker rejects every write permission", () => {
  assert.match(errorsFor(mutate("contents: read", "contents: write")), /write permissions are prohibited/);
});

test("C10 checker rejects unpinned and unreviewed Actions", () => {
  const tagged = WORKFLOW.replaceAll(PINNED_CHECKOUT, "actions/checkout@v4");
  const errors = errorsFor(tagged);
  assert.match(errors, /only the reviewed actions\/checkout commit may be used/);
  assert.match(errors, /full 40-character commit SHA/);

  const other = WORKFLOW.replace(PINNED_CHECKOUT, `owner/invented@${"a".repeat(40)}`);
  assert.match(errorsFor(other), /only the reviewed actions\/checkout commit may be used/);
});

test("C10 checker rejects caller-controlled shell commands and additional command steps", () => {
  const expression = mutate(
    "node scripts/check-untrusted-pr-workflow.js ../candidate/.github/workflows/untrusted-pr.yml",
    "node scripts/check-untrusted-pr-workflow.js '${{ github.event.pull_request.title }}'",
  );
  assert.match(errorsFor(expression), /caller-controlled expressions/);

  const added = mutate(
    "      - name: Install without scripts, then run the fixed probe without a network",
    "      - name: Arbitrary command\n        run: whoami\n\n      - name: Install without scripts, then run the fixed probe without a network",
  );
  assert.match(errorsFor(added), /exactly the two reviewed fixed command blocks/);
});

test("C10 checker rejects removal of the network-denied adversarial probe", () => {
  const source = WORKFLOW.replaceAll("--network none", "--network bridge");
  assert.match(errorsFor(source), /actual adversarial probe and network preflight must run with Docker outbound networking denied/);
});

test("C10 checker rejects privileged triggers, missing timeout, and credential persistence", () => {
  assert.match(errorsFor(mutate("pull_request:", "pull_request_target:")), /privileged or caller-controlled workflow triggers/);
  assert.match(errorsFor(mutate("timeout-minutes: 10", "timeout-minutes: 0")), /ten-minute hard timeout/);
  assert.match(errorsFor(mutate("persist-credentials: false", "persist-credentials: true")), /credential persistence/);
});

test("C10 checker rejects mutable container tags and lifecycle scripts", () => {
  assert.match(errorsFor(mutate(PINNED_NODE_IMAGE, "node:24-bookworm-slim")), /container image must be pinned/);
  assert.match(errorsFor(mutate("npm ci --ignore-scripts --no-audit --no-fund", "npm ci")), /installed without lifecycle scripts/);
});

test("C10 reviewed fixture creates the dependency mountpoint after the trap and before Docker starts", () => {
  const commands = extractRunBlocks(WORKFLOW)[1].split("\n").map((line) => line.trim());
  const trapIndex = commands.indexOf("trap cleanup_c10_volume EXIT");
  assert.notEqual(trapIndex, -1);
  assert.deepEqual(commands.slice(trapIndex, trapIndex + 3), [
    "trap cleanup_c10_volume EXIT",
    "mkdir -- node_modules",
    'docker pull "$c10_image"',
  ]);
});

test("C10 mountpoint rule rejects missing or permissive setup without relying on the fingerprint", () => {
  for (const replacement of ["", "          mkdir -p -- node_modules\n"]) {
    const source = mutate("          mkdir -- node_modules\n", replacement);
    const result = validateUntrustedPrWorkflowSource(source, { enforceFingerprint: false });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /mountpoint must be created with fail-closed mkdir/);
  }
});

test("C10 mountpoint rule rejects reordered setup without relying on the fingerprint", () => {
  const beforeTrap = mutate(
    "          trap cleanup_c10_volume EXIT\n          mkdir -- node_modules\n",
    "          mkdir -- node_modules\n          trap cleanup_c10_volume EXIT\n",
  );
  const afterDocker = mutate(
    '          mkdir -- node_modules\n          docker pull "$c10_image"\n',
    '          docker pull "$c10_image"\n          mkdir -- node_modules\n',
  );
  for (const source of [beforeTrap, afterDocker]) {
    const result = validateUntrustedPrWorkflowSource(source, { enforceFingerprint: false });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /mountpoint must be created with fail-closed mkdir/);
  }
});

test("C10 fingerprint rejects any unreviewed drift even when an individual rule still looks safe", () => {
  const source = `# apparently harmless drift\n${WORKFLOW}`;
  const result = validateUntrustedPrWorkflowSource(source);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /exact reviewed fixed-command policy/);
});

test("C10 checker CLI passes the reviewed file and fails a tampered file", () => {
  const script = require.resolve("../scripts/check-untrusted-pr-workflow");
  const valid = spawnSync(process.execPath, [script, REVIEWED_FIXTURE_PATH], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stdout);
  assert.equal(JSON.parse(valid.stdout).ok, true);

  const directory = mkdtempSync(path.join(tmpdir(), "neurohands-untrusted-workflow-"));
  try {
    const filePath = path.join(directory, "untrusted-pr.yml");
    writeFileSync(filePath, mutate("contents: read", "contents: write"), "utf8");
    const invalid = spawnSync(process.execPath, [script, filePath], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    const result = JSON.parse(invalid.stdout);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /write permissions are prohibited/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
