const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JARVIS_OBJECTIVE, loadJarvisContext } = require("../src/lib/jarvis-context");

const run = (id, operator = "operator-a", overrides = {}) => ({
  id, line_user_id: operator, run_kind: "operator", client_account_id: null, agent_code: null, department: "operations", objective: JARVIS_OBJECTIVE,
  status: "completed", input: `Question ${id}`, output: `Answer ${id}`, created_at: `2026-09-09T12:00:0${id}Z`,
  delivered_at: "2026-09-09T13:00:00Z", ...overrides,
});
const note = (id, operator = "operator-a", overrides = {}) => ({
  id, proposed_by: operator, status: "confirmed", tool_name: null, category: "general", content: `Note ${id}`,
  confirmed_at: `2026-09-09T12:00:0${id}Z`, ...overrides,
});
const reader = ({ runs = [], notes = [] } = {}) => async (query) => query.startsWith("agent_runs?") ? runs : notes;

test("Jarvis context scopes both queries and returned evidence to the individual operator", async () => {
  const calls = [];
  const db = async (query) => {
    const url = new URL(query, "https://database.invalid/");
    calls.push(url);
    if (url.pathname === "/jarvis_notes") {
      assert.equal(url.searchParams.get("status"), "eq.confirmed");
      assert.equal(url.searchParams.get("tool_name"), "is.null");
      assert.equal(url.searchParams.get("order"), "confirmed_at.desc,id.desc");
      assert.equal(url.searchParams.get("limit"), "10");
      assert.ok(url.searchParams.get("select").split(",").includes("status"));
      return [note(2, "operator-b"), note(1)];
    }
    assert.equal(url.pathname, "/agent_runs");
    assert.equal(url.searchParams.get("run_kind"), "eq.operator");
    assert.equal(url.searchParams.get("client_account_id"), "is.null");
    assert.equal(url.searchParams.get("agent_code"), "is.null");
    assert.equal(url.searchParams.get("department"), "eq.operations");
    assert.equal(url.searchParams.get("objective"), `eq.${JARVIS_OBJECTIVE}`);
    assert.equal(url.searchParams.get("status"), "eq.completed");
    assert.equal(url.searchParams.get("delivered_at"), "not.is.null");
    assert.equal(url.searchParams.get("order"), "created_at.desc,id.desc");
    assert.equal(url.searchParams.get("limit"), "4");
    assert.ok(url.searchParams.get("select").split(",").includes("status"));
    return [run(2, "operator-b"), run(1)];
  };
  const [first, second] = await Promise.all([loadJarvisContext(db, "operator-a"), loadJarvisContext(db, "operator-b")]);
  assert.deepEqual(first, {
    history: [{ role: "user", content: "Question 1" }, { role: "assistant", content: "Answer 1" }],
    notes: [{ category: "general", content: "Note 1" }],
  });
  assert.deepEqual(second, {
    history: [{ role: "user", content: "Question 2" }, { role: "assistant", content: "Answer 2" }],
    notes: [{ category: "general", content: "Note 2" }],
  });
  for (const operator of ["operator-a", "operator-b"]) {
    assert.equal(calls.filter((url) => url.searchParams.get("proposed_by") === `eq.${operator}`).length, 1);
    assert.equal(calls.filter((url) => url.searchParams.get("line_user_id") === `eq.${operator}`).length, 1);
  }
});

test("operator values are encoded and cannot add or replace query filters", async () => {
  const operator = "operator&status=eq.failed";
  const calls = [];
  assert.deepEqual(await loadJarvisContext(async (query) => { calls.push(new URL(query, "https://database.invalid/")); return []; }, operator),
    { history: [], notes: [] });
  assert.equal(calls[0].searchParams.get("proposed_by"), `eq.${operator}`);
  assert.equal(calls[0].searchParams.get("status"), "eq.confirmed");
  assert.equal(calls[1].searchParams.get("line_user_id"), `eq.${operator}`);
  assert.equal(calls[1].searchParams.get("status"), "eq.completed");
});

test("the newest four complete turns are returned in chronological order without mutating database rows", async () => {
  const runs = [run(5), run(4), run(3), run(2), run(1)];
  const result = await loadJarvisContext(reader({ runs }), "operator-a");
  assert.deepEqual(result.history, [2, 3, 4, 5].flatMap((id) => [
    { role: "user", content: `Question ${id}` }, { role: "assistant", content: `Answer ${id}` },
  ]));
  assert.deepEqual(runs.map(({ id }) => id), [5, 4, 3, 2, 1]);
});

test("failed, pending, incomplete and other-role evidence never enters Jarvis context", async () => {
  const runs = [
    null, run(8, "operator-a", { status: "error" }), run(7, "operator-a", { status: "started" }),
    run(6, "operator-a", { agent_code: "AGT-001" }), run(5, "operator-a", { department: "sales" }),
    run(4, "operator-a", { objective: "Different workflow" }), run(3, "operator-a", { status: undefined }),
    run(2, "operator-a", { input: " " }), run(1, "operator-a", { output: null }),
    run(10, "operator-a", { run_kind: "client" }), run(9, "operator-a", { client_account_id: 1 }),
    run(12, "operator-a", { delivered_at: null }), run(11, "operator-a", { delivered_at: "Invalid date" }),
  ];
  const notes = [
    null, note(5, "operator-a", { status: "pending" }), note(4, "operator-a", { status: "failed" }),
    note(3, "operator-a", { status: "executing" }), note(2, "operator-a", { category: null }),
    note(1, "operator-a", { content: " " }),
  ];
  assert.deepEqual(await loadJarvisContext(reader({ runs, notes }), "operator-a"), { history: [], notes: [] });
});

test("history and confirmed notes have content and count bounds without coercing invalid values", async () => {
  const notes = Array.from({ length: 12 }, (_, index) => note(12 - index, "operator-a", { content: `  ${"n".repeat(1200)}  ` }));
  notes.unshift(note(20, "operator-a", { content: { text: "Not a string" } }));
  const result = await loadJarvisContext(reader({
    runs: [run(2, "operator-a", { input: ["Invalid input"], output: "Valid answer" }),
      run(1, "operator-a", { input: `  ${"q".repeat(2000)}  `, output: `  ${"a".repeat(2000)}  ` })],
    notes,
  }), "operator-a");
  assert.deepEqual(result.history, [{ role: "user", content: "q".repeat(1500) }, { role: "assistant", content: "a".repeat(1500) }]);
  assert.equal(result.notes.length, 10);
  assert.ok(result.notes.every((item) => item.content === "n".repeat(1000)));
});

test("confirmed action proposals are excluded from durable operator notes", async () => {
  const context = await loadJarvisContext(reader({ notes: [
    note(3, "operator-a", { tool_name: "create_task", content: "Create a task" }),
    note(2, "operator-a", { tool_name: undefined, content: "Unknown note type" }),
    note(1, "operator-a", { content: "Use Thai for business summaries" }),
  ] }), "operator-a");
  assert.deepEqual(context.notes, [{ category: "general", content: "Use Thai for business summaries" }]);
});

test("a failed or malformed context read propagates rather than inventing empty history", async (t) => {
  for (const table of ["agent_runs", "jarvis_notes"]) {
    await t.test(`${table} failure`, async () => {
      const failure = new Error("Fixture database unavailable");
      await assert.rejects(loadJarvisContext(async (query) => {
        if (query.startsWith(`${table}?`)) throw failure;
        return [];
      }, "operator-a"), (error) => error === failure);
    });
    await t.test(`${table} malformed result`, async () => {
      await assert.rejects(loadJarvisContext(async (query) => query.startsWith(`${table}?`) ? { error: "invalid response" } : [], "operator-a"),
        /Jarvis context could not be loaded/);
    });
  }
});

test("missing operator identity cannot trigger an unscoped database read", async () => {
  const noRead = () => { assert.fail("An invalid identity must not query the database"); };
  for (const operator of [undefined, null, "", "  ", 42]) {
    await assert.rejects(loadJarvisContext(noRead, operator), TypeError);
  }
  await assert.rejects(loadJarvisContext(null, "operator-a"), TypeError);
});
