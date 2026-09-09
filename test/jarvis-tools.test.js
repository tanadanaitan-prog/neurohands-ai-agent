const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createJarvisTools } = require("../src/lib/jarvis-tools");

const READ_NAMES = ["get_recent_orders", "get_order_status", "get_product_info", "get_edging_info", "get_lead_time", "recall_customer", "list_tasks", "list_documents", "read_document"];
const WRITE_ARGS = {
  create_task: { title: "Call the customer", domain: "sales" },
  create_support_case: { subject: "Damaged glass", detail: "Customer reported a broken panel", urgency: "high" },
  request_human: { reason: "Confirm the delivery date" },
  remember_customer: { content: "Prefers morning deliveries", memory_type: "preference" },
};
const schemaFields = {
  get_recent_orders: [], get_order_status: ["order_number"], get_product_info: ["query"], get_edging_info: [],
  get_lead_time: ["order_number"], recall_customer: [], list_tasks: [], list_documents: [], read_document: ["doc_code"],
  ...Object.fromEntries(Object.entries(WRITE_ARGS).map(([name, args]) => [name, Object.keys(args)])),
};

function fixture() {
  const state = {
    staff: new Set(["operator-one", "operator-two"]), auth: [], queries: [], logs: [], reads: [], proposals: [], writes: [],
    accounts: [{ id: 11, client_code: "KNC", company: "KNC Glass", active: true, private_value: "do not expose" },
      { id: 22, client_code: "OTH", company: "Other company", active: true },
      { id: 33, client_code: "OFF", company: "Inactive company", active: false }],
    documents: [{ account: 11, department: "sales", code: "KNC-DOC", text: "KNC-only reference 739261" },
      { account: 22, department: "sales", code: "OTH-DOC", text: "Other client's private reference" },
      { account: 11, department: "hr", code: "KNC-HR", text: "Personnel-only reference" }],
  };
  const toolSchemas = Object.fromEntries(Object.entries(schemaFields).map(([name, fields]) => [name, {
    name, description: name, parameters: { type: "object", properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])) },
  }]));
  const db = async (path, options = {}) => {
    state.queries.push({ path, options });
    if (path === "tool_calls") {
      if (state.failLog === "throw") throw new Error("private database details");
      if (state.failLog) return null;
      state.logs.push(options.body);
      return [{ id: state.logs.length }];
    }
    const url = new URL(`https://database.invalid/${path}`);
    assert.equal(url.pathname, "/client_accounts", "Only supported client metadata queries may reach this mock");
    assert.equal(url.searchParams.get("active"), "eq.true");
    if (state.failAccounts) return null;
    return state.accounts.filter((account) => account.active && (!url.searchParams.has("client_code") || `eq.${account.client_code}` === url.searchParams.get("client_code")));
  };
  const toolHandlers = Object.fromEntries(READ_NAMES.map((name) => [name, async (ctx, args) => {
    state.reads.push({ name, ctx, args });
    if (state.failRead === "throw") throw new Error("private business details");
    if (state.failRead) return { error: "private extraction details" };
    if (name === "read_document") {
      const doc = state.documents.find((item) => item.account === ctx.clientAccountId && item.department === ctx.department && item.code === args.doc_code);
      return doc ? { found: true, readable: true, content: doc.text } : { found: false };
    }
    return { found: true, name };
  }]));
  for (const name of Object.keys(WRITE_ARGS)) toolHandlers[name] = async (...args) => { state.writes.push({ name, args }); throw new Error("A proposed action must never execute directly"); };
  const tools = createJarvisTools({
    db, toolSchemas, toolHandlers, departments: { sales: "SAL", hr: "HRS" },
    isStaff: async (user) => { state.auth.push(user); if (state.failAuth) throw new Error("private identity failure"); return state.staff.has(user) ? { role: "staff" } : null; },
    normalizeDepartment: (value) => ({ sale: "sales", human_resources: "hr" })[value.toLowerCase()] || value.toLowerCase(),
    buildDailyDigest: async () => { state.digests = (state.digests || 0) + 1; if (state.failDigest) throw new Error("private digest failure"); return "Live digest: one delayed order"; },
    proposeNote: async (content, category, operator, toolName, toolArgs, accountId, department, sourceRunId) => {
      state.proposals.push({ content, category, operator, toolName, toolArgs, accountId, department, sourceRunId, status: "pending" });
      if (state.failProposal) throw new Error("private proposal failure");
      return state.proposals.length;
    },
  });
  return { state, tools, toolSchemas, ctx: { lineUserId: "operator-one" } };
}

test("Jarvis schemas expose bounded scoped reads and proposal tools, never direct business writes", () => {
  const { tools, toolSchemas } = fixture();
  assert.deepEqual(tools.schemas.map((schema) => schema.name), ["list_clients", "operations_status", ...READ_NAMES, "propose_note", "propose_action"]);
  for (const name of READ_NAMES) {
    const params = tools.schemas.find((schema) => schema.name === name).parameters;
    assert.ok(params.required.includes("client_code"));
    assert.ok(params.required.includes("department"));
    assert.equal(params.additionalProperties, false);
    assert.equal(toolSchemas[name].parameters.properties.client_code, undefined, "Shared customer schemas remain unchanged");
  }
  assert.ok(tools.schemas.find((schema) => schema.name === "read_document").parameters.required.includes("doc_code"));
});

test("customers and revoked operators cannot read business data or make proposals", async () => {
  const { tools, state, ctx } = fixture();
  const first = await tools.execute(ctx, 1, "list_clients", {});
  assert.deepEqual(first.clients, [{ client_code: "KNC", company: "KNC Glass" }, { client_code: "OTH", company: "Other company" }]);
  const businessQueries = state.queries.filter((query) => query.path !== "tool_calls").length;
  state.staff.delete(ctx.lineUserId);
  for (const name of ["list_clients", "operations_status", "read_document", "propose_note", "propose_action"]) {
    const out = await tools.execute(ctx, 1, name, {});
    assert.match(out.error, /Operator access/);
    assert.equal(state.logs.at(-1).allowed, false);
    assert.equal(state.logs.at(-1).status, "blocked");
  }
  assert.equal(state.auth.length, 6, "Authorization is rechecked for each invocation");
  assert.equal(state.queries.filter((query) => query.path !== "tool_calls").length, businessQueries);
  assert.equal(state.digests, undefined);
  assert.equal(state.reads.length, 0);
  assert.equal(state.proposals.length, 0);
  assert.equal(ctx.toolFailed, true);
  const customer = { lineUserId: "customer" };
  assert.match((await tools.execute(customer, 2, "list_clients", {})).error, /Operator access/);
});

test("document reads use resolved company and department, preserving the real tool name in evidence", async () => {
  const { tools, state, ctx } = fixture();
  ctx.clientAccountId = 999;
  ctx.department = "hr";
  const out = await tools.execute(ctx, 7, "read_document", { client_code: "knc", department: "sale", doc_code: "KNC-DOC" });
  assert.equal(out.content, "KNC-only reference 739261");
  assert.deepEqual(state.reads[0].args, { doc_code: "KNC-DOC" });
  assert.equal(state.reads[0].ctx.clientAccountId, 11);
  assert.equal(state.reads[0].ctx.department, "sales");
  assert.equal(state.reads[0].ctx.lineUserId, "operator-one");
  assert.deepEqual(state.logs[0], { run_id: 7, agent_code: null, tool_name: "read_document",
    input: { client_code: "knc", department: "sale", doc_code: "KNC-DOC" }, output: out, allowed: true, status: "success" });
  for (const doc_code of ["OTH-DOC", "KNC-HR"]) {
    assert.deepEqual(await tools.execute(ctx, 7, "read_document", { client_code: "KNC", department: "sales", doc_code }), { found: false });
  }
});

test("each exposed business read resolves an active account before invoking the existing handler", async () => {
  const { tools, state, ctx } = fixture();
  for (const name of READ_NAMES) {
    await tools.execute(ctx, 3, name, { client_code: "KNC", department: "sales", ...(name === "read_document" ? { doc_code: "KNC-DOC" } : {}) });
  }
  assert.deepEqual(state.reads.map((read) => read.name), READ_NAMES);
  assert.equal(state.queries.filter((query) => query.path.startsWith("client_accounts?")).length, READ_NAMES.length);
  const digest = await tools.execute(ctx, 3, "operations_status", {});
  assert.deepEqual(digest, { digest: "Live digest: one delayed order" });
});

test("unknown, direct-write and raw network/query tools are blocked even for an operator", async () => {
  const { tools, state, ctx } = fixture();
  for (const name of [...Object.keys(WRITE_ARGS), "get_client_profile", "execute_sql", "fetch_url", "__proto__"]) {
    assert.match((await tools.execute(ctx, 4, name, {})).error, /not available/);
    assert.equal(state.logs.at(-1).status, "blocked");
    assert.equal(state.logs.at(-1).allowed, false);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.queries.filter((query) => query.path !== "tool_calls").length, 0);
});

test("malformed scope or forged identity fields never reach a business handler", async () => {
  const { tools, state, ctx } = fixture();
  const valid = { client_code: "KNC", department: "sales", doc_code: "KNC-DOC" };
  for (const args of [null, [], "KNC", { ...valid, client_account_id: 22 }, { ...valid, lineUserId: "operator-two" },
    { ...valid, doc_code: {} }, { ...valid, doc_code: "x".repeat(161) }, { ...valid, client_code: "KNC&active=eq.false" },
    { ...valid, department: "unknown" }, { ...valid, client_code: "OFF" }, { ...valid, client_code: "MISSING" },
    { client_code: "KNC", department: "sales" }]) {
    const out = await tools.execute(ctx, 5, "read_document", args);
    assert.equal(typeof out.error, "string");
    assert.equal(state.logs.at(-1).status, "error");
  }
  assert.equal(state.reads.length, 0);
});

test("business writes become pending proposals belonging to the requesting operator", async () => {
  const { tools, state } = fixture();
  for (const [tool_name, tool_args] of Object.entries(WRITE_ARGS)) {
    const ctx = { lineUserId: "operator-two" };
    const result = await tools.execute(ctx, 8, "propose_action", { client_code: "knc", department: "sales", tool_name, tool_args });
    assert.equal(result.executed, false);
    assert.equal(result.requires_approval, true);
    assert.deepEqual(ctx.proposal, { id: result.proposal_id, content: result.content });
    assert.deepEqual(state.proposals.at(-1), { content: result.content, category: "general", operator: "operator-two", toolName: tool_name,
      toolArgs: tool_args, accountId: 11, department: "sales", sourceRunId: 8, status: "pending" });
    assert.ok(result.content.includes(JSON.stringify(tool_args)), "The approval includes the concrete proposed arguments");
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.reads.length, 0);
});

test("note categories are validated and concurrent proposals cannot create more than one pending item per run", async () => {
  const { tools, state, ctx } = fixture();
  const results = await Promise.all([
    tools.execute(ctx, 9, "propose_note", { content: "Remember this owner decision", category: "learning" }),
    tools.execute(ctx, 9, "propose_note", { content: "A second proposal", category: "general" }),
  ]);
  assert.equal(state.proposals.length, 1);
  assert.equal(results.filter((result) => result.proposed).length, 1);
  assert.match(results.find((result) => result.error).error, /Only one proposal/);
  assert.equal(state.proposals[0].operator, "operator-one");
  assert.equal(state.proposals[0].category, "learning");
  assert.equal(state.proposals[0].toolName, null);
  for (const category of ["general", "market"]) {
    assert.equal((await tools.execute({ lineUserId: "operator-one" }, 10, "propose_note", { content: "Scoped owner note", category })).proposed, true);
  }
});

test("invalid proposal arguments never create a pending item or execute a write", async () => {
  const { tools, state, ctx } = fixture();
  const action = { client_code: "KNC", department: "sales", tool_name: "create_task", tool_args: { title: "Call" } };
  const cases = [
    ["propose_note", { content: " ", category: "general" }],
    ["propose_note", { content: "x".repeat(2001), category: "general" }],
    ["propose_note", { content: "Note", category: "system" }],
    ["propose_note", { content: "Note", category: "general", proposed_by: "operator-two" }],
    ["propose_action", { ...action, tool_name: "read_document" }],
    ["propose_action", { ...action, tool_args: [] }],
    ["propose_action", { ...action, tool_args: {} }],
    ["propose_action", { ...action, tool_args: { title: "Call", subject: "Unexpected action field" } }],
    ["propose_action", { ...action, tool_args: { title: "Call", client_account_id: 22 } }],
    ["propose_action", { ...action, tool_name: "remember_customer", tool_args: { content: "Note", memory_type: "password" } }],
  ];
  for (const [name, args] of cases) assert.equal(typeof (await tools.execute(ctx, 11, name, args)).error, "string");
  assert.equal(state.proposals.length, 0);
  assert.equal(state.writes.length, 0);
});

test("dependency failures remain failures with safe evidence instead of false success", async () => {
  for (const [failure, name, args] of [
    ["failAuth", "list_clients", {}], ["failAccounts", "list_clients", {}],
    ["failDigest", "operations_status", {}],
    ["failRead", "read_document", { client_code: "KNC", department: "sales", doc_code: "KNC-DOC" }],
    ["failProposal", "propose_note", { content: "Owner decision", category: "general" }],
  ]) {
    const { tools, state, ctx } = fixture();
    state[failure] = "throw";
    const result = await tools.execute(ctx, 12, name, args);
    assert.match(result.error, /could not complete/);
    assert.equal(ctx.toolFailed, true);
    assert.equal(state.logs[0].status, "error");
    assert.equal(JSON.stringify(state.logs).includes("private"), false);
    if (failure === "failProposal") {
      state.failProposal = false;
      assert.match((await tools.execute(ctx, 12, name, args)).error, /Only one proposal/);
      assert.equal(state.proposals.length, 1, "An uncertain proposal insert is not repeated");
    }
  }
  const { tools, state, ctx } = fixture();
  state.failRead = true;
  assert.match((await tools.execute(ctx, 13, "read_document", { client_code: "KNC", department: "sales", doc_code: "KNC-DOC" })).error, /could not complete/);
  assert.equal(state.logs[0].status, "error");
});

test("failed audit persistence throws and marks the run failed", async () => {
  for (const mode of [true, "throw"]) {
    const { tools, state, ctx } = fixture();
    state.failLog = mode;
    await assert.rejects(tools.execute(ctx, 14, "operations_status", {}), /Jarvis tool evidence could not be saved/);
    assert.equal(ctx.toolFailed, true);
  }
});

test("unbounded invalid arguments cannot overflow the stored audit input", async () => {
  const { tools, state, ctx } = fixture();
  const result = await tools.execute(ctx, 15, "propose_note", { content: "x".repeat(20000), category: "general" });
  assert.equal(typeof result.error, "string");
  assert.deepEqual(state.logs[0].input, { rejected_input: true });
  assert.equal(state.proposals.length, 0);
});
