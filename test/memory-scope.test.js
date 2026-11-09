// S1: customer memories and tasks must be scoped to the LINE user, not only the client account.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const U1 = "Ufixtureuser1", U2 = "Ufixtureuser2";
const U1_FACT = "U1-private-fact-prefers-tempered-glass";
const U2_FACT = "U2-own-fact-budget-5000";
const STORE = {
  agent_memory: [
    { client_account_id: 1, line_user_id: U1, active: true, memory_type: "preference", content: U1_FACT },
    { client_account_id: 1, line_user_id: U2, active: true, memory_type: "preference", content: U2_FACT },
  ],
  agent_tasks: [
    { id: 11, client_account_id: 1, line_user_id: U1, status: "open", title: "U1-private-task", domain: "sales" },
    { id: 12, client_account_id: 1, line_user_id: U2, status: "open", title: "U2-own-task", domain: "sales" },
  ],
};

// Minimal PostgREST-style eq filtering, so an unscoped query really would leak.
function filterRows(rows, params) {
  return rows.filter((row) => [...params].every(([key, value]) => {
    if (["select", "order", "limit"].includes(key)) return true;
    if (!value.startsWith("eq.")) return true;
    return String(row[key]) === value.slice(3);
  }));
}

function loadGateway(t) {
  const values = {
    FOUNDER_LINE_ID: "Ufixturefounder", LINE_CHANNEL_ACCESS_TOKEN: "fixture-token", GEMINI_API_KEY: "fixture-key", GEMINI_ENABLED: "true", GEMINI_MODEL: "fixture-gemini",
    FALLBACK_API_KEY: "", SUPABASE_URL: "https://database.invalid", SUPABASE_SERVICE_KEY: "sb_secret_fixture", ENABLE_STUDIO: "false",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[require.resolve("../src/server")];
  });
  delete require.cache[require.resolve("../src/server")];
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  return require("../src/server");
}

function fakeBackend(t, { onGemini } = {}) {
  const queries = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = new URL(url);
    if (address.hostname === "generativelanguage.googleapis.com") {
      onGemini?.(JSON.parse(options.body));
      return json({ candidates: [{ content: { parts: [{ text: "Fixture answer" }] } }] });
    }
    if (address.hostname === "api.line.me") return json({});
    assert.equal(address.hostname, "database.invalid");
    const table = address.pathname.replace("/rest/v1/", "");
    queries.push({ table, params: Object.fromEntries(address.searchParams), method: options.method || "GET" });
    if (STORE[table] && (options.method || "GET") === "GET") return json(filterRows(STORE[table], address.searchParams));
    if (table === "client_agent_bindings") {
      const user = address.searchParams.get("line_user_id")?.slice(3);
      return json([{ client_account_id: 1, department: "sales", line_user_id: user, status: "active" }]);
    }
    if (table === "client_accounts") return json([{ id: 1, active: true }]);
    if ((options.method || "GET") !== "GET") return json([{ id: 1 }]);
    return json([]);
  });
  return queries;
}

test("loadMemories returns only the requesting user's facts", async (t) => {
  const gateway = loadGateway(t);
  const queries = fakeBackend(t);
  const memories = await gateway.loadMemories({ clientAccountId: 1, lineUserId: U2 });
  assert.deepEqual(memories.map((m) => m.content), [U2_FACT]);
  const q = queries.find((x) => x.table === "agent_memory");
  assert.equal(q.params.client_account_id, "eq.1");
  assert.equal(q.params.line_user_id, `eq.${U2}`);
});

test("loadMemories without a LINE user returns nothing and makes no query", async (t) => {
  const gateway = loadGateway(t);
  const queries = fakeBackend(t);
  assert.deepEqual(await gateway.loadMemories({ clientAccountId: 1 }), []);
  assert.equal(queries.length, 0);
});

test("recall_customer and list_tasks tools are scoped to the LINE user", async (t) => {
  const gateway = loadGateway(t);
  const queries = fakeBackend(t);
  const ctx = { clientAccountId: 1, lineUserId: U2, allowedTools: ["recall_customer", "list_tasks"] };
  const recalled = await gateway.executeToolWithLog(ctx, 1, "recall_customer", {});
  assert.deepEqual(recalled.memories.map((m) => m.content), [U2_FACT]);
  const tasks = await gateway.executeToolWithLog(ctx, 1, "list_tasks", {});
  assert.deepEqual(tasks.tasks.map((x) => x.title), ["U2-own-task"]);
  for (const table of ["agent_memory", "agent_tasks"]) {
    const q = queries.find((x) => x.table === table);
    assert.equal(q.params.client_account_id, "eq.1");
    assert.equal(q.params.line_user_id, `eq.${U2}`);
  }
});

test("agent card memory count includes only the requesting user's facts", async (t) => {
  const gateway = loadGateway(t);
  const queries = fakeBackend(t);
  const card = await gateway.getAgentCard(U2);
  assert.match(card, /Memory: 1 stored fact\(s\)/);
  const q = queries.find((x) => x.table === "agent_memory");
  assert.equal(q.params.line_user_id, `eq.${U2}`);
});

test("Aria's prompt for one user never contains another user's remembered facts", async (t) => {
  const gateway = loadGateway(t);
  let prompt = "";
  fakeBackend(t, { onGemini: (body) => { prompt += JSON.stringify(body); } });
  const ctx = { lineUserId: U2, clientAccountId: 1, department: "sales" };
  const agent = { agent_code: "AGT-001", allowed_tools: [], domains: [], responsibilities: [] };
  await gateway.runAgent(ctx, "What do you remember about me?", agent);
  assert.ok(prompt.length > 0, "Gemini was called");
  assert.ok(prompt.includes(U2_FACT), "own fact is present");
  assert.equal(prompt.includes(U1_FACT), false, "another user's fact must not reach the prompt");
});

test("a customer cannot reach the staff-only account-wide memory or digest commands", async (t) => {
  const gateway = loadGateway(t);
  const queries = fakeBackend(t);
  for (const text of ["brief", "memory:"]) {
    await gateway.handleEvent({ type: "message", message: { type: "text", text }, source: { type: "user", userId: U2 },
      replyToken: "fixture-reply", webhookEventId: `fixture-${text}`, timestamp: Date.now() });
  }
  const staffCheck = queries.filter((x) => x.table === "staff_activations");
  assert.ok(staffCheck.length >= 2, "the staff gate is consulted for each message");
  for (const q of queries.filter((x) => ["agent_memory", "agent_tasks"].includes(x.table) && x.method === "GET")) {
    assert.equal(q.params.line_user_id, `eq.${U2}`, `unscoped ${q.table} read reached from a customer chat`);
  }
});
