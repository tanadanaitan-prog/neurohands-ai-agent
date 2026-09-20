import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealBenchmarkDryRun,
  evaluateRealBenchmarkStructure,
  parseRealBenchmarkArgs,
  readRealBenchmarkFixture,
  recordOllamaResponseDiagnostics,
  safeDiagnosticToolCalls,
  validateRealBenchmarkFixture,
  withIsolatedWorkflowLifecycle,
} from "../scripts/real-named-workflow-benchmark.mjs";

const LOCAL_ENV = Object.freeze({
  LAB_OLLAMA_BASE_URL: "http://127.0.0.1:11435",
  LAB_OLLAMA_MODEL: "qwen3:1.7b",
});

test("dry-run validates all fixed topologies without inference, network, writes, or semantic grading", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("dry-run must not fetch");
  };
  try {
    const report = await buildRealBenchmarkDryRun({ env: { ...LOCAL_ENV } });
    assert.equal(report.status, "validated");
    assert.equal(report.modelInference, false);
    assert.equal(report.networkRequests, 0);
    assert.equal(report.writesPerformed, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(report.executionOrder, [
      "basic-individual",
      "intermediate-pair",
      "advanced-full-department",
    ]);
    assert.deepEqual(report.topology.map((entry) => [entry.complexity.level, entry.topology.templateId, entry.topology.agentCount]), [
      ["basic", "individual", 1],
      ["intermediate", "pair", 2],
      ["advanced", "full_department", 5],
    ]);
    assert.equal(report.grading.humanReview, null);
    assert.match(report.grading.semanticCorrectness, /not automatically graded/i);
    assert.match(report.comparisonCaution, /not a fair model-quality comparison/i);
    assert.ok(report.limitations.some((item) => /not a process-wide network sandbox/i.test(item)));
    assert.match(report.restrictions.networkEnforcement, /loopback/i);
    assert.match(report.provenance.fixtureSha256, /^[a-f0-9]{64}$/);
    assert.match(report.provenance.provenanceSha256, /^[a-f0-9]{64}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixture validation binds explicit complexity and topology to the fixed runtime order", async () => {
  const { fixture } = await readRealBenchmarkFixture();
  assert.deepEqual(validateRealBenchmarkFixture(fixture), fixture);
  for (const scenario of fixture.scenarios) {
    assert.equal(scenario.topology.agentIds.length, scenario.topology.agentCount);
    assert.equal(scenario.topology.stepIds.length, scenario.topology.agentCount);
    assert.equal(scenario.topology.edges.length, scenario.topology.agentCount - 1);
    assert.ok(scenario.complexity.taskDimensions.length >= scenario.complexity.ordinal + 1);
    assert.ok(scenario.budget.maxDurationMs > 0);
  }

  const reordered = structuredClone(fixture);
  [reordered.scenarios[0], reordered.scenarios[1]] = [reordered.scenarios[1], reordered.scenarios[0]];
  assert.throws(() => validateRealBenchmarkFixture(reordered), /fixed id|order/i);

  const topologyDrift = structuredClone(fixture);
  topologyDrift.scenarios[2].topology.agentIds[1] = "sales-suri";
  assert.throws(() => validateRealBenchmarkFixture(topologyDrift), /topology/i);
});

test("structural checks allow zero tool calls, keep missing tokens unknown, and ignore prose semantics", async () => {
  const { fixture } = await readRealBenchmarkFixture();
  const scenario = fixture.scenarios[0];
  const records = [{
    schemaVersion: 1,
    recordType: "step",
    status: "completed",
    clientId: scenario.clientId,
    workflowId: "basic-individual-workflow",
  }];
  const ledgerBytes = Buffer.byteLength(`${JSON.stringify(records[0])}\n`, "utf8");
  const result = {
    templateId: "individual",
    clientId: scenario.clientId,
    workflowId: "basic-individual-workflow",
    status: "completed",
    metrics: { storedBytes: ledgerBytes },
    handoffs: [],
    steps: [{
      stepId: "requirements_quote",
      agentId: "sales-suri",
      departmentId: "sales",
      status: "completed",
      output: "The total is a purple cloud.",
      evidence: { source: "agent_prose", verified: false },
      toolAudit: [],
      metrics: { durationMs: 5, modelCalls: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }],
  };
  const structure = evaluateRealBenchmarkStructure({
    scenario,
    result,
    records,
    ledgerBytes,
    modelSessions: [{ stepId: "requirements_quote", agentId: "sales-suri", calls: [] }],
  });
  assert.equal(structure.checks.find((item) => item.id === "tool_audit_shape").status, "pass");
  assert.equal(structure.checks.find((item) => item.id === "provider_token_metadata").status, "not_available");
  assert.equal(structure.checks.some((item) => /semantic|answer_correct|business_correct/i.test(item.id)), false);
  assert.equal(structure.checks.some((item) => item.status === "fail"), false);
  assert.match(structure.policy, /no model-prose/i);
});

test("model-call diagnostics preserve bounded tool names and arguments while redacting secrets", () => {
  const circular = { key: "synthetic" };
  circular.self = circular;
  const oversized = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, "x".repeat(512)]));
  const rawToolCalls = [
    { name: "calculate", args: { expression: "24 * 85" } },
    { name: "create_task", args: { title: "Synthetic task", password: "never-store-this", nested: { api_key: "also-secret" } } },
    { name: "read_document", args: oversized },
    { name: "remember", args: circular },
    ...Array.from({ length: 14 }, (_, index) => ({ name: `synthetic_tool_${index}`, args: { index } })),
  ];
  const call = { outputCharacters: null, toolCallCount: null, toolCalls: null, toolCallsTruncated: null };
  recordOllamaResponseDiagnostics(call, {
    content: "Synthetic response",
    tool_calls: rawToolCalls,
    usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  });

  assert.equal(call.toolCallCount, 18);
  assert.equal(call.toolCalls.length, 16);
  assert.equal(call.toolCallsTruncated, true);
  assert.deepEqual(call.toolCalls[0], {
    name: "calculate",
    args: { expression: "24 * 85" },
    argumentsTruncated: false,
  });
  assert.equal(call.toolCalls[1].args.password, "[redacted]");
  assert.equal(call.toolCalls[1].args.nested.api_key, "[redacted]");
  assert.equal(call.toolCalls[2].args.diagnostic, "arguments_truncated");
  assert.equal(call.toolCalls[2].argumentsTruncated, true);
  assert.equal(call.toolCalls[3].args.self, "[circular]");
  assert.equal(call.toolCalls[3].argumentsTruncated, true);
  const serialized = JSON.stringify(call.toolCalls);
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.doesNotMatch(serialized, /never-store-this|also-secret/);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 50_000);
  assert.deepEqual(call.usageMetadata, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });

  assert.deepEqual(safeDiagnosticToolCalls(null), { toolCalls: [], truncated: false });
});

test("isolated lifecycle closes and removes storage while preserving the original run error", async () => {
  const original = Object.assign(new Error("original runner failure"), { code: "ORIGINAL_RUN_FAILURE" });
  let closeCalls = 0;
  let removeCalls = 0;
  await assert.rejects(
    withIsolatedWorkflowLifecycle({
      storageDir: "synthetic-storage",
      createRunner: () => ({ async close() { closeCalls += 1; } }),
      async removeStorage(target) {
        assert.equal(target, "synthetic-storage");
        removeCalls += 1;
      },
    }, async () => { throw original; }),
    (error) => error === original,
  );
  assert.equal(closeCalls, 1);
  assert.equal(removeCalls, 1);
});

test("CLI options select one topology and enforce a bounded suite duration", () => {
  const options = parseRealBenchmarkArgs(["--dry-run", "--topology", "pair", "--suite-timeout-ms", "300000"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.topology, "pair");
  assert.equal(options.suiteTimeoutMs, 300000);
  assert.throws(() => parseRealBenchmarkArgs(["--suite-timeout-ms", "0"]), /must be an integer/i);
  assert.throws(() => parseRealBenchmarkArgs(["--topology", "invented"]), /topology/i);
});
