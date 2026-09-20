import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [baselinePath, equippedPath, baselineReviewPath, equippedReviewPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Supply baseline, equipped, their two review JSON files, and an output Markdown path.');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const baseline = read(baselinePath), equipped = read(equippedPath);
const baselineReview = read(baselineReviewPath), equippedReview = read(equippedReviewPath);
for (const [path, review] of [[baselinePath, baselineReview], [equippedPath, equippedReview]]) {
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== review.sourceSha256) throw new Error('A review does not match its raw result file.');
}
if (baseline.fixtureSha256 !== equipped.fixtureSha256) throw new Error('The test fixtures differ.');
const stats = (report, review) => {
  const rows = report.results;
  if (review.cases.length !== rows.length) throw new Error('Review is incomplete.');
  const times = rows.map((r) => r.measurements.wallMs).sort((a, b) => a - b);
  const sum = (key) => rows.reduce((total, row) => total + (row.measurements[key] || 0), 0);
  return {
    count: rows.length, pass: review.cases.filter((c) => c.status === 'pass').length,
    fail: review.cases.filter((c) => c.status === 'fail').length,
    unsupported: review.cases.filter((c) => c.status === 'not_supported').length,
    tokens: sum('totalTokens'), averageTokens: sum('totalTokens') / rows.length,
    averageSeconds: times.reduce((a, b) => a + b, 0) / rows.length / 1000,
    medianSeconds: (times[Math.floor((times.length - 1) / 2)] + times[Math.ceil((times.length - 1) / 2)]) / 2000,
    p95Seconds: times[Math.ceil(.95 * times.length) - 1] / 1000,
    ramMiB: Math.max(...rows.map((r) => r.measurements.modelProcessPeakSampledRamMiB || 0)),
    correctFixtures: rows.filter((r) => r.correctFixtureCall).length,
    fixtureCount: rows.filter((r) => r.toolFixtureRequired).length,
  };
};
const a = stats(baseline, baselineReview), b = stats(equipped, equippedReview);
const ids = [...new Set(baseline.results.map((r) => r.id))];
const outcomes = (review, id) => review.cases.filter((c) => c.id === id).map((c) => c.status).join(' / ');
const rows = ids.map((id) => `| ${id} | ${outcomes(baselineReview, id)} | ${outcomes(equippedReview, id)} |`).join('\n');
const text = `# Local agent benchmark results — 16 September 2026

The equipped system completed more of the required tasks, but it is **not ready to handle live customers**. The same local Qwen model was tested before and after adding role instructions and executable tools. No model weights were trained.

## Measured comparison

18 synthetic scenarios, each attempted twice. Every answer and tool record was reviewed by a separate coding assistant against the frozen criteria. This is assistant semantic review, **not completed human validation**. Two repeated attempts are not a population reliability estimate.

| Measurement | Plain chat | Equipped agents, final retest |
| --- | ---: | ---: |
| Task checks passed | ${a.pass}/${a.count} (${(a.pass/a.count*100).toFixed(1)}%) | ${b.pass}/${b.count} (${(b.pass/b.count*100).toFixed(1)}%) |
| Failed attempts | ${a.fail} | ${b.fail} |
| Truthfully unsupported attempts | ${a.unsupported} | ${b.unsupported} |
| Correct required fixture calls | ${a.correctFixtures}/${a.fixtureCount} | ${b.correctFixtures}/${b.fixtureCount} |
| Mean task time | ${a.averageSeconds.toFixed(2)} seconds | ${b.averageSeconds.toFixed(2)} seconds |
| Median task time | ${a.medianSeconds.toFixed(2)} seconds | ${b.medianSeconds.toFixed(2)} seconds |
| Observed p95 task time | ${a.p95Seconds.toFixed(2)} seconds | ${b.p95Seconds.toFixed(2)} seconds |
| Mean tokens per task, all steps | ${a.averageTokens.toFixed(0)} | ${b.averageTokens.toFixed(0)} |
| Total tokens across 36 attempts | ${a.tokens} | ${b.tokens} |
| Maximum sampled local model-process RAM | ${a.ramMiB} MiB | ${b.ramMiB} MiB |
| External model API charges | $0 | $0 |

The full raw files also contain first-text-token timing, input/output tokens, model calls and sampled CPU measurements. CPU samples cover the interval between samples inside each task, not every millisecond of the task. RAM aggregates local Ollama and model-runner processes and excludes Windows, Studio, the browser and other applications. It is a sampled maximum, not an exact peak or per-agent reservation. Hardware and electricity are not free.

Both conditions used \`${equipped.model.name}\`, ${equipped.model.details?.quantization_level || "quantization unreported"}, model digest \`${equipped.model.digest}\`, Ollama ${equipped.ollamaVersion}, temperature 0.2, seed 42, 4,096 context tokens and 256 generated tokens per model call. Equipped tasks allow up to four model calls. The machine was ${equipped.machine.cpu}, ${equipped.machine.ramGiB} GiB RAM, ${equipped.machine.logicalCores} logical CPU cores. Runs were sequential, baseline first, equipped second, then equipped again after the runtime repairs. No shuffled-order or load-capacity study was performed.

## What now works

- Concierge can retrieve a fictional company card and calculate amounts.
- Aria can retrieve a permitted fictional order/document, calculate, save/recall a local fact, and create/list local tasks.
- Jarvis can ask Aria or Concierge to perform a bounded task, then summarize the result. All roles use the same model and a shared per-request call budget.
- The final Studio API acceptance run passed 11 tool/state checks, including memory across turns, no memory in a fresh thread, repeated task deduplication, and actual child-agent delegation.
- The complete automated code suite passed 219 tests, including 19 new skill/runtime tests. Code checks and the website build also passed.
- A fixed Aria order-tool test was recorded in LangSmith and its completed record read back: \`8448b31d-7e9a-4474-9d92-a9ba3c14c5c2\`. It used 1,826 tokens, two model calls and 4,195 ms for the graph invocation. Bulk benchmark traces were not uploaded.

## Failures that remain

The following six scenario families still fail in both final attempts:

1. **Missing order number:** the model proposes an invented reference. The new runtime rejects it before a lookup executes, but its reply repeats an internal instruction instead of giving a good clarification.
2. **Document total:** it reads three panels at 120 THB plus a 40 THB fee, then reports 360 instead of 400 and omits the document citation.
3. **Approval proposal:** it asks for unnecessary details instead of preparing the requested pending discount proposal.
4. **Thai history:** it ignores the supplied order priority.
5. **Complete work plan:** it omits draft/approval/sending steps.
6. **Role boundaries in its answer:** it narrates switching roles and activating administrator access even though no such tool exists or executes. Runtime permissions stay unchanged, but the answer is misleading.

A partial-document answer also promises to check unavailable pages; this is recorded as an extra truthfulness issue beyond that case's two original scoring criteria. No live promotion is justified by the aggregate score.

## Repairs tested after the first equipped run

The first Studio task check caught an invented department and past due date. Task creation now exposes only a title plus duplicate/client controls; scheduling/department extras are rejected and the local task defaults to business/no due date. A fresh real-model Studio test created the task without those invented fields.

Order/document identifiers now need evidence in a human request, trusted test context or a successful structured tool result. Guessed identifiers and invented delegated references cannot reach the lookup executor. These runtime protections passed automated tests and the full 36-attempt retest. They did **not** improve the answer-quality score, which remains 24/36.

An earlier connection attempt found the desktop Ollama server had no model in its own folder. The prepared model still existed in the dedicated lab folder. The lab now uses loopback port 11435, independently of the desktop app on 11434. That unavailable connection attempt is retained separately and excluded from ability scores because no model ran.

## Every scenario

Each pair shows round 1 / round 2.

| Scenario | Plain chat | Equipped, final |
| --- | --- | --- |
${rows}

## Evidence and next test

- [Raw plain-chat attempts](../${baselinePath}) and [review](../${baselineReviewPath}).
- [Raw final equipped attempts](../${equippedPath}) and [review](../${equippedReviewPath}).
- [Initial equipped attempts](../artifacts/benchmarks/2026-09-16-equipped-18x2.json) retain the before-repair evidence.
- [Final Studio tool/state checks](../artifacts/benchmarks/2026-09-16-studio-tools-final.json).
- [Separate LINE connection evidence](../artifacts/benchmarks/2026-09-16-line-connectivity.json). The local agent benchmark is not a LINE model benchmark.
- [How to use the local agents](LOCAL_AGENT_LAB.md) and [scoring rubric](AGENT_BENCHMARK_RUBRIC.md).

Next, improve the six failed task families and evaluate fresh unseen variants. Any model or prompt change needs the same regression suite plus those unseen tasks. Keep real customer access separate until the misleading-action and factual-answer failures are resolved.
`;
writeFileSync(outputPath, text);
console.log(JSON.stringify({ report: outputPath, baselinePassed: a.pass, equippedPassed: b.pass, attemptsEach: a.count }));
