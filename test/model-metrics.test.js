const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createRunMetrics, withRunMetrics, beginModelAttempt, finishModelAttempt, finalizeRunMetrics, formatRunMetrics } = require("../src/lib/model-metrics");

const PRIVATE = "private-fixture-never-in-metrics";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const primary = (total = 78) => json({ candidates: [{ content: { parts: [{ text: PRIVATE }] } }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 71, cachedContentTokenCount: 3, totalTokenCount: total } });

function gatewayFixture(t, overrides = {}) {
  const values = { GEMINI_API_KEY: PRIVATE, GEMINI_MODEL: "gemini-fixture", FALLBACK_API_KEY: PRIVATE, FALLBACK_PROVIDER: "groq",
    FALLBACK_BASE_URL: "https://model.invalid", FALLBACK_MODELS: "first,second", FALLBACK_MODEL: "", ENABLE_STUDIO: "false",
    SUPABASE_URL: "https://database.invalid", SUPABASE_SERVICE_KEY: "sb_secret_fixture", ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");
  const runs = [], logs = [];
  const state = { gateway, runs, logs, model: () => primary() };
  t.mock.method(console, "info", (_label, value) => logs.push(JSON.parse(value)));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(address);
    if (url.hostname !== "database.invalid") return state.model(url, options);
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "client_agent_bindings") return json([{ line_user_id: url.searchParams.get("line_user_id").slice(3), client_account_id: 1, department: "sales", status: "active" }]);
    if (table === "client_accounts") return json([{ id: 1, active: true }]);
    if (table === "agent_memory") return json([]);
    if (table === "tool_calls") return json([{ id: 1, ...JSON.parse(options.body) }]);
    assert.equal(table, "agent_runs");
    const fields = JSON.parse(options.body);
    if (options.method === "POST") { const row = { id: runs.length + 1, ...fields }; runs.push(row); return json([row]); }
    assert.equal(options.method, "PATCH");
    const row = runs.find((run) => String(run.id) === url.searchParams.get("id").slice(3));
    Object.assign(row, fields);
    return json([row]);
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete require.cache[require.resolve("../src/server")];
  });
  state.run = (user = "one") => gateway.runAgent({ lineUserId: user, clientAccountId: 1, department: "sales" }, user,
    { agent_code: "AGT-001", allowed_tools: [], domains: [], responsibilities: [], objective: PRIVATE });
  return state;
}

test("concurrent agent runs keep requests, numeric usage and safe logs in their own run", async (t) => {
  const state = gatewayFixture(t);
  const waiting = [];
  state.model = (_url, options) => new Promise((resolve) => waiting.push({ resolve, user: JSON.parse(options.body).contents[0].parts[0].text }));
  const one = state.run("one"), two = state.run("two");
  for (let cycle = 0; waiting.length < 2 && cycle < 100; cycle += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.length, 2, "Both authorized runs reached their model call");
  waiting.find((request) => request.user === "two").resolve(primary(88));
  waiting.find((request) => request.user === "one").resolve(primary(78));
  assert.deepEqual(await Promise.all([one, two]), [PRIVATE, PRIVATE]);
  for (const run of state.runs) {
    const metrics = run.llm_metrics;
    assert.equal(metrics.attempt_count, 1);
    assert.equal(metrics.attempts[0].run_id, run.id);
    assert.equal(metrics.attempts[0].provider, "gemini");
    assert.equal(metrics.attempts[0].status, "usable_response");
    assert.equal(metrics.totals.total_tokens.complete, run.input === "one" ? 78 : 88);
    assert.equal(metrics.totals.reasoning_tokens.complete, 71);
    assert.equal(metrics.totals.cached_input_tokens.complete, 3);
    assert.equal(metrics.totals.input_tokens.complete, 5, "Cached tokens must not be added twice");
    assert.ok(metrics.run_elapsed_ms >= metrics.model_elapsed_ms);
    assert.equal(JSON.stringify(metrics).includes(PRIVATE), false);
  }
  assert.deepEqual(new Set(state.logs.map((log) => log.run_id)), new Set(state.runs.map((run) => run.id)));
  assert.equal(JSON.stringify(state.logs).includes(PRIVATE), false);
});

test("discarded responses and failed fallback attempts remain in measured sums and unknown counts", async (t) => {
  const state = gatewayFixture(t);
  state.model = (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") return json({ candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 78 } });
    if (JSON.parse(options.body).model === "first") return json({ error: PRIVATE }, 429);
    return json({ choices: [{ message: { content: PRIVATE } }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 1 } } });
  };
  await state.run();
  const metrics = state.runs[0].llm_metrics;
  assert.deepEqual(metrics.attempts.map((attempt) => attempt.status), ["discarded_response", "http_error", "usable_response"]);
  assert.deepEqual(metrics.attempts.map((attempt) => attempt.attempt), [1, 2, 3]);
  assert.equal(metrics.attempts[1].http_status, 429);
  assert.deepEqual(metrics.totals.total_tokens, { observed: 88, unknown_attempts: 1, complete: null });
  assert.equal(metrics.attempts[2].reasoning_tokens, 2);
  assert.match(formatRunMetrics(metrics), /88 observed tokens; 1 attempt\(s\) with unknown usage/);
  assert.equal(JSON.stringify(metrics).includes(PRIVATE), false);
});

test("failed runs retain transport and malformed-body attempts with unknown rather than zero usage", async (t) => {
  const state = gatewayFixture(t, { FALLBACK_MODELS: "first" });
  state.model = (url) => {
    if (url.hostname === "generativelanguage.googleapis.com") throw new DOMException(PRIVATE, "TimeoutError");
    return new Response(PRIVATE);
  };
  assert.match(await state.run(), /could not complete/);
  const run = state.runs[0];
  assert.equal(run.status, "error");
  assert.equal(run.llm_metrics.finalized, true);
  assert.deepEqual(run.llm_metrics.attempts.map((attempt) => attempt.status), ["timeout", "invalid_json"]);
  assert.deepEqual(run.llm_metrics.totals.total_tokens, { observed: null, unknown_attempts: 2, complete: null });
});

test("each tool-loop round contributes tokens even when the requested tool is blocked", async (t) => {
  const state = gatewayFixture(t);
  let round = 0;
  state.model = () => ++round === 1 ? json({ candidates: [{ content: { parts: [{ functionCall: { name: "request_human", args: {} } }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } }) : primary();
  assert.match(await state.run(), /tool did not succeed/);
  const metrics = state.runs[0].llm_metrics;
  assert.equal(state.runs[0].status, "error", "Telemetry must not weaken tool authorization");
  assert.equal(metrics.attempt_count, 2);
  assert.deepEqual(metrics.totals.total_tokens, { observed: 87, unknown_attempts: 0, complete: 87 });
  assert.equal(metrics.totals.reasoning_tokens.complete, null, "Missing reasoning breakdown is not zero");
});

test("missing and invalid numeric usage is unavailable, distinct from finalized zero-call runs and old history", async (t) => {
  const state = gatewayFixture(t);
  state.model = () => json({ candidates: [{ content: { parts: [{ text: "OK" }] } }], usageMetadata: { promptTokenCount: -1, candidatesTokenCount: PRIVATE } });
  await state.run();
  assert.deepEqual(state.runs[0].llm_metrics.totals.total_tokens, { observed: null, unknown_attempts: 1, complete: null });
  assert.deepEqual(finalizeRunMetrics(createRunMetrics(99)).totals.total_tokens, { observed: 0, unknown_attempts: 0, complete: 0 });
  assert.equal(formatRunMetrics(null), "Usage: unavailable for this run.");
  assert.equal(formatRunMetrics(undefined), "Usage: unavailable for this run.");
  assert.equal(formatRunMetrics({ version: 1, finalized: false }), "Usage: unavailable for this run.");
  assert.equal(finalizeRunMetrics(null), null);
});

test("pending attempts never count as complete and unrelated calls do not attach to a finished run", async () => {
  const collector = createRunMetrics(4);
  await withRunMetrics(collector, async () => { beginModelAttempt("Gemini", "fixture-model"); });
  assert.equal(finalizeRunMetrics(collector).totals.total_tokens.complete, null);
  const unrelated = beginModelAttempt("Gemini", PRIVATE, [PRIVATE]);
  finishModelAttempt(unrelated, "usable_response", 200, 1, { usageMetadata: { totalTokenCount: 9 } });
  assert.equal(unrelated.run_id, null);
  assert.equal(unrelated.model, "invalid_model_label");
  assert.equal(collector.attempts.length, 1);
});

test("trace summary rejects malformed version-one numbers instead of displaying undefined or false totals", () => {
  const valid = finalizeRunMetrics(createRunMetrics(1));
  const invalid = [
    { ...valid, totals: { total_tokens: {} } },
    { ...valid, totals: { total_tokens: { observed: 0, unknown_attempts: 0 } } },
    ...["5", false, -1, Infinity, NaN, undefined].map((complete) => ({ ...valid,
      totals: { total_tokens: { complete, observed: 0, unknown_attempts: 0 } } })),
    { ...valid, attempt_count: undefined },
    { ...valid, run_elapsed_ms: "100" },
    { ...valid, model_elapsed_ms: -1 },
    { ...valid, totals: { total_tokens: { complete: 0, observed: 0, unknown_attempts: 1 } } },
    { ...valid, totals: { total_tokens: { complete: 1, observed: 2, unknown_attempts: 0 } } },
  ];
  for (const metrics of invalid) assert.equal(formatRunMetrics(metrics), "Usage: unavailable for this run.");
  assert.match(formatRunMetrics(valid), /0 model call\(s\), 0 total tokens reported/);
});

test("additive metrics migration keeps historical rows unknown and preserves browser restrictions", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table public.agent_runs(id bigint primary key, input text); alter table public.agent_runs enable row level security; revoke all on public.agent_runs from public,anon,authenticated; grant select,update on public.agent_runs to service_role; insert into public.agent_runs values(1,'historical');");
  const migration = fs.readdirSync(path.join(__dirname, "../supabase/migrations")).find((file) => file.endsWith("_agent_run_model_metrics.sql"));
  await db.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations", migration), "utf8"));
  assert.deepEqual((await db.query("select * from public.agent_runs")).rows, [{ id: 1, input: "historical", llm_metrics: null }]);
  await assert.rejects(db.query("update public.agent_runs set llm_metrics='[]'::jsonb"), { code: "23514" });
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select llm_metrics from public.agent_runs"), { code: "42501" });
    await db.exec("reset role");
  }
  await db.exec("set role service_role");
  await db.query("update public.agent_runs set llm_metrics=$1::jsonb where id=1", [JSON.stringify(finalizeRunMetrics(createRunMetrics(1)))]);
  assert.equal((await db.query("select llm_metrics from public.agent_runs")).rows[0].llm_metrics.finalized, true);
});
