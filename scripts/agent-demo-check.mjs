// End-to-end synthetic checks through the same local API used by Studio.
// This script never changes production records or calls a paid provider.
import { Client } from '@langchain/langgraph-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
const client = new Client({ apiUrl: 'http://127.0.0.1:2024' });
const output = { startedAt: new Date().toISOString(), scope: 'Local synthetic Studio API acceptance', grading: 'Tool/state assertions only; answer semantics require separate review.', checks: [] };
const targetIndex = process.argv.indexOf('--out');
const target = targetIndex < 0 ? 'artifacts/benchmarks/' + new Date().toISOString().replace(/[:.]/g, '-') + '-studio-tools.json' : process.argv[targetIndex + 1];
mkdirSync('artifacts/benchmarks', { recursive: true });
const save = () => writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
async function check(graph, thread, prompt, validate) {
  const result = await client.runs.wait(thread.thread_id, graph, { input: { messages: [{ type: 'human', content: [{ type: 'text', text: prompt }] }] } });
  const entry = { graph, threadId: thread.thread_id, prompt, answer: result.messages?.at(-1)?.content, metrics: result.metrics, toolAudit: result.toolAudit, memory: result.memory, tasks: result.tasks, passed: result.metrics?.stoppedReason === 'completed' && validate(result) };
  output.checks.push(entry); save();
  console.log(JSON.stringify({ graph, prompt, passed: entry.passed, answer: entry.answer, tools: entry.toolAudit?.map((a) => ({ agent: a.agent, name: a.name, ok: a.ok })) }));
}
const used = (name) => (r) => r.toolAudit?.some((a) => a.name === name && a.ok);
const concierge = await client.threads.create();
await check('neurohands_concierge', concierge, 'Look up Mango Works and tell me its services.', used('lookup_company'));
const aria = await client.threads.create();
await check('neurohands_aria', aria, 'Check order DEMO-ORDER-001.', used('get_order_status'));
const doc = await client.threads.create();
await check('neurohands_aria', doc, 'Read DEMO-DOC-001 and tell me the cover-printing lead time.', used('read_document'));
const math = await client.threads.create();
await check('neurohands_aria', math, 'Calculate (7 * 45 + 3 * 18) * 0.9 + 25.', (r) => r.toolAudit?.some((a) => a.name === 'calculate' && a.ok && Math.abs(a.result.result - 357.1) < .0001));
const memory = await client.threads.create();
await check('neurohands_aria', memory, 'Save this fictional fact using remember: key delivery_day, value Tuesday.', (r) => r.memory?.delivery_day === 'Tuesday' && used('remember')(r));
await check('neurohands_aria', memory, 'Use recall with key delivery_day and tell me its value.', (r) => r.toolAudit?.some((a) => a.name === 'recall' && a.result.value === 'Tuesday'));
const task = await client.threads.create();
const validTask = (r) => r.tasks?.length === 1 && r.tasks[0].title === 'Prepare demo quote' && r.tasks[0].domain === 'business' && r.tasks[0].due_date === null;
await check('neurohands_aria', task, 'Create a local task titled Prepare demo quote.', (r) => validTask(r) && used('create_task')(r));
await check('neurohands_aria', task, 'Create the same local task titled Prepare demo quote again.', (r) => validTask(r) && used('create_task')(r));
await check('neurohands_aria', task, 'List my local tasks.', (r) => r.tasks?.length === 1 && used('list_tasks')(r));
const fresh = await client.threads.create();
await check('neurohands_aria', fresh, 'Use recall with key delivery_day. If no saved fact exists, say so.', (r) => Object.keys(r.memory || {}).length === 0 && r.toolAudit?.some((a) => a.name === 'recall' && !a.ok));
const jarvis = await client.threads.create();
await check('neurohands_jarvis', jarvis, 'Use delegate_to_agent to ask Concierge to look up Mango Works services, then summarize its answer.', (r) => used('delegate_to_agent')(r) && r.toolAudit?.some((a) => a.agent === 'concierge' && a.name === 'lookup_company' && a.ok));
output.finishedAt = new Date().toISOString();
output.passed = output.checks.filter((c) => c.passed).length;
output.total = output.checks.length;
save();
console.log(JSON.stringify({ passed: output.passed, total: output.total }));
if (output.passed !== output.total) process.exitCode = 1;
