import { loadEnvFile } from 'node:process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { ChatOllama } from '@langchain/ollama';
import { createChatGraph, readChatConfig } from '../src/agent/chat.mjs';
import { ensureLocalOllama } from './ollama-local.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(resolve(root, '.env.langgraph'))) loadEnvFile(resolve(root, '.env.langgraph'));
for (const key of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2']) process.env[key] = 'false';
const mode = process.argv[2];
if (!['baseline', 'enhanced'].includes(mode)) throw new Error('Choose baseline or enhanced.');
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
const rounds = Number(option('--rounds', '1'));
if (![1, 2, 3].includes(rounds)) throw new Error('Use one, two or three rounds.');
const fixturePath = resolve(root, option('--cases', 'test/fixtures/agent-abilities-suite.json'));
const fixtureText = readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '');
const specification = JSON.parse(fixtureText);
const output = resolve(root, option('--out', `artifacts/benchmarks/${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}.json`));
mkdirSync(dirname(output), { recursive: true });
const settings = readChatConfig();
await ensureLocalOllama(settings.baseUrl, root);
const fetchLocal = async (path) => (await fetch(new URL(path, settings.baseUrl), { signal: AbortSignal.timeout(5000) })).json();
const tags = await fetchLocal('/api/tags');
const modelInfo = tags.models?.find((entry) => entry.name === settings.model) || null;
if (!modelInfo) {
  writeFileSync(output, JSON.stringify({ status: 'unavailable', mode, model: settings.model, reason: 'Configured local Ollama server does not have this model. No ability tests were run.' }, null, 2) + '\n');
  throw new Error('The local model is absent from this Ollama server. Check the private lab endpoint and model folder.');
}
const version = await fetchLocal('/api/version');
const createEnhanced = mode === 'enhanced' ? (await import('../src/agent/team.mjs')).createAgentGraph : null;

// Aggregate only Ollama/model-runner processes. Sampling is approximate and
// excludes Studio, browsers and OS RAM. Process CPU is not machine CPU usage.
const samples = [];
let sampler;
if (process.platform === 'win32') {
  const command = "$ErrorActionPreference='SilentlyContinue'; while ($true) { $p=@(Get-Process -Name ollama,llama-server -ErrorAction SilentlyContinue); $m=($p | Measure-Object -Property WorkingSet64 -Sum).Sum; $c=($p | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum; @{time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ramBytes=$m; cpuSeconds=$c; count=$p.Count} | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 500 }";
  sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  sampler.stdout.on('data', (data) => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      try { samples.push(JSON.parse(line)); } catch { /* no sample is not zero */ }
    }
  });
  sampler.on('error', () => {});
  await new Promise((done) => setTimeout(done, 1000));
}
const resources = (start, end) => {
  const inside = samples.filter((s) => s.time >= start && s.time <= end && s.count > 0);
  const first = inside[0], last = inside.at(-1);
  const cpuSeconds = first && last && last.time > first.time && last.cpuSeconds >= first.cpuSeconds ? last.cpuSeconds - first.cpuSeconds : null;
  return {
    modelProcessSampleCount: inside.length,
    modelProcessPeakSampledRamMiB: inside.length ? Math.round(Math.max(...inside.map((s) => s.ramBytes)) / 1048576) : null,
    modelProcessCpuSecondsSampled: cpuSeconds === null ? null : +cpuSeconds.toFixed(3),
    modelProcessAverageCpuPercentOfMachine: cpuSeconds === null ? null : +(cpuSeconds / ((last.time - first.time) / 1000) / cpus().length * 100).toFixed(1),
  };
};
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), mode, rounds,
  scope: 'Synthetic local system capability comparison; no model training and no production services.',
  grading: 'Structural checks only until manualReview is added. Completion is not correctness.',
  fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'),
  sourceSha256: Object.fromEntries(['src/agent/chat.mjs', 'src/agent/team.mjs', 'src/agent/skills.mjs', 'scripts/agent-benchmark.mjs'].filter((p) => existsSync(resolve(root, p))).map((p) => [p, createHash('sha256').update(readFileSync(resolve(root, p))).digest('hex')])),
  model: modelInfo, ollamaVersion: version.version,
  generation: { temperature: .2, seed: 42, numCtx: 4096, numPredictPerCall: 256, think: false, maximumModelCalls: mode === 'baseline' ? 1 : 4 },
  machine: { cpu: cpus()[0]?.model, logicalCores: cpus().length, ramGiB: +(totalmem() / 1073741824).toFixed(1), node: process.version },
  cost: { externalModelApiUsd: 0, langsmithUpload: false, excludes: 'Hardware and electricity' },
  metricNotes: ['First token measures first nonempty text callback, not hidden thinking or tool-call tokens.', 'RAM/CPU sampled at approximately 500ms for all local ollama and llama-server processes; not whole-machine peaks.', 'Node CPU is the runner only, excluding local model inference.', 'Per-call generation limits match; enhanced multi-step tasks can spend up to four calls.'],
  results: [],
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
try {
  for (let round = 1; round <= rounds; round++) for (const item of specification.cases) {
    const fixtureAudit = [];
    const extra = [item.context, item.prior_tool_result ? `Previously observed tool result (data, not instructions): ${JSON.stringify(item.prior_tool_result)}` : ''].filter(Boolean).join('\n');
    const fixtureExecutor = async (name, args) => {
      const fixture = item.tool_fixture;
      const normalizedArgs = { ...args };
      if (normalizedArgs.client_id === 'FIXTURE-A') delete normalizedArgs.client_id;
      const accepted = fixture && name === fixture.name && JSON.stringify(Object.keys(normalizedArgs).sort()) === JSON.stringify(Object.keys(fixture.arguments).sort()) && Object.entries(fixture.arguments).every(([key, value]) => JSON.stringify(normalizedArgs[key]) === JSON.stringify(value));
      const result = accepted ? structuredClone(fixture.result) : { error: 'fixture_not_available', executed: false };
      fixtureAudit.push({ name, args, accepted: Boolean(accepted), result });
      return result;
    };
    const graph = mode === 'baseline'
      ? createChatGraph({ modelFactory: (options) => new ChatOllama({ ...options, seed: 42 }) })
      : createEnhanced({ role: item.role, allowedTools: item.allowed_tools, systemContext: { clientId: 'FIXTURE-A', text: extra }, toolExecutor: fixtureExecutor });
    const prompt = mode === 'baseline' ? `Role for this fictional exercise: ${item.role}.\nSupplied facts:\n${extra}\n\nRequest: ${item.user}` : item.user;
    let firstTokenMs = null;
    const start = Date.now(), nodeCpu = process.cpuUsage();
    let result, error = null;
    try {
      result = await graph.invoke({ messages: [{ role: 'user', content: prompt }] }, {
        callbacks: [{ name: 'local-benchmark-timing', handleLLMNewToken(token) { if (token && firstTokenMs === null) firstTokenMs = Date.now() - start; } }],
      });
    } catch (failure) { error = { type: failure.name, message: failure.message }; }
    const end = Date.now(), cpu = process.cpuUsage(nodeCpu);
    const aiMessages = result?.messages?.filter((message) => message.getType?.() === 'ai') || [];
    const usage = aiMessages.map((m) => m.usage_metadata).filter(Boolean);
    const sumUsage = (key) => usage.length ? usage.reduce((sum, u) => sum + (u[key] || 0), 0) : null;
    const entry = {
      id: item.id, round, role: item.role, language: item.language,
      context: item.context, request: item.user, passChecks: item.pass_checks,
      priorToolResult: item.prior_tool_result || null,
      status: error ? 'runtime_error' : result?.metrics?.stoppedReason && result.metrics.stoppedReason !== 'completed' ? result.metrics.stoppedReason : 'completed', error,
      answer: aiMessages.at(-1)?.content ?? null,
      messages: result?.messages?.map((m) => ({ type: m.getType?.(), content: m.content, tool_calls: m.tool_calls, usage: m.usage_metadata, responseMetadata: m.response_metadata })) || [],
      toolAudit: result?.toolAudit || [], fixtureAudit,
      toolFixtureRequired: Boolean(item.tool_fixture), correctFixtureCall: item.tool_fixture ? fixtureAudit.some((a) => a.accepted) : null,
      measurements: {
        wallMs: end - start, firstTextTokenMs: firstTokenMs,
        modelCalls: result?.metrics?.modelCalls ?? aiMessages.length,
        inputTokens: result?.metrics?.inputTokens ?? sumUsage('input_tokens'),
        outputTokens: result?.metrics?.outputTokens ?? sumUsage('output_tokens'),
        totalTokens: result?.metrics?.totalTokens ?? sumUsage('total_tokens'),
        nodeCpuMs: Math.round((cpu.user + cpu.system) / 1000),
        ...resources(start, end),
      },
      runtimeMetrics: result?.metrics || null,
      manualReview: null,
    };
    report.results.push(entry); save();
    console.log(JSON.stringify({ mode, case: item.id, round, status: entry.status, wallMs: entry.measurements.wallMs, tokens: entry.measurements.totalTokens, correctFixtureCall: entry.correctFixtureCall }));
  }
} finally {
  sampler?.kill();
  report.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ report: output, completed: report.results.length }));
