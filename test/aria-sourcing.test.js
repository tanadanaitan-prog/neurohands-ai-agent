// Aria sourcing fix: missing documents fail, rule 9 asks for a source, unsupported numbers hand off.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const USER = "Ufixturearia";
const AGENT = { agent_code: "AGT-001", callsign: "Aria", agent_name: "Sales", objective: "Help", domains: [], responsibilities: [],
  allowed_tools: ["get_product_info", "read_document", "request_human"] };
const HANDOFF = /Sorry, our team needs to confirm this information first/;

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

// Gemini replies in order from `turns`; each turn is a list of parts.
function fakeBackend(t, turns) {
  const log = { systems: [], toolCalls: [], runPatches: [] };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = new URL(url);
    const method = options.method || "GET";
    if (address.hostname === "generativelanguage.googleapis.com") {
      log.systems.push(JSON.parse(options.body).system_instruction.parts[0].text);
      return json({ candidates: [{ content: { parts: turns.shift() } }] });
    }
    const table = address.pathname.replace("/rest/v1/", "");
    if (table === "client_agent_bindings") return json([{ client_account_id: 1, department: "sales", line_user_id: USER, status: "active" }]);
    if (table === "client_accounts") return json([{ id: 1, active: true }]);
    if (table === "glass_types") return json([{ product_code: "G6", glass_name: "Clear 6mm", thickness_mm: 6, price_per_sqft: 450 }]);
    if (table === "tool_calls") log.toolCalls.push(JSON.parse(options.body));
    if (table.startsWith("agent_runs") && method === "PATCH") log.runPatches.push(JSON.parse(options.body));
    if (method !== "GET") return json([{ id: 1 }]);
    return json([]);
  });
  return log;
}

const ctx = () => ({ lineUserId: USER, clientAccountId: 1, department: "sales", allowedTools: [] });
const call = (name, args = {}) => [{ functionCall: { name, args } }];

test("read_document with no matching document is logged as an error and answered with the no-information reply", async (t) => {
  const gateway = loadGateway(t);
  const log = fakeBackend(t, [call("read_document", { doc_code: "DOC-NONE" }), [{ text: "The document says the price is 450." }]]);
  const c = ctx();
  const reply = await gateway.runAgent(c, "What does DOC-NONE say?", AGENT);
  assert.deepEqual(log.toolCalls[0].output, { found: false, error: "Document not found." });
  assert.equal(log.toolCalls[0].status, "error");
  assert.equal(c.runStatus, "completed");
  assert.doesNotMatch(reply, /450/);
  assert.match(reply, /I don't have that information/);
  assert.doesNotMatch(reply, /Some work may already be saved/);
  assert.equal(log.runPatches.at(-1).error, "Document not found; no-information reply");
});

test("Aria's prompt asks for a Source line and a request_human handoff (rule 9)", async (t) => {
  const gateway = loadGateway(t);
  const log = fakeBackend(t, [[{ text: "Hello, how can I help?" }]]);
  await gateway.runAgent(ctx(), "hi", AGENT);
  assert.match(log.systems[0], /9\. When you used a document, end your reply with "Source: <doc_code>"; when you used a price tool, say "per current price list"\. If no tool result supports the answer, say you don't have it and call request_human/);
});

test("a price with no successful tool result is replaced by the Thai/English handoff", async (t) => {
  const gateway = loadGateway(t);
  const log = fakeBackend(t, [[{ text: "กระจกใส 6 มม. ราคา 450 บาทต่อตารางฟุต" }]]);
  const c = ctx();
  const reply = await gateway.runAgent(c, "ราคากระจกเท่าไหร่", AGENT);
  assert.match(reply, HANDOFF);
  assert.match(reply, /ขออภัย/);
  assert.equal(c.runStatus, "completed");
  assert.equal(log.runPatches.at(-1).error, "Unsupported number replaced with handoff");
});

test("Thai digits without a tool result also hand off", async (t) => {
  const gateway = loadGateway(t);
  fakeBackend(t, [[{ text: "ราคา ๔๕๐ บาท" }]]);
  assert.match(await gateway.runAgent(ctx(), "ราคา?", AGENT), HANDOFF);
});

test("a reply with no number and no tool passes through unchanged", async (t) => {
  const gateway = loadGateway(t);
  fakeBackend(t, [[{ text: "Hello, how can I help?" }]]);
  assert.equal(await gateway.runAgent(ctx(), "hi", AGENT), "Hello, how can I help?");
});

test("a normal priced reply backed by a successful tool result passes through unchanged", async (t) => {
  const gateway = loadGateway(t);
  const log = fakeBackend(t, [call("get_product_info", { query: "clear" }), [{ text: "Clear 6mm is 450 THB per sq ft." }]]);
  const c = ctx();
  const reply = await gateway.runAgent(c, "price of clear glass?", AGENT);
  assert.equal(log.toolCalls[0].status, "success");
  assert.equal(reply, "Clear 6mm is 450 THB per sq ft.");
  assert.equal(c.runStatus, "completed");
  assert.equal(log.runPatches.at(-1).error, null);
});

test("web API returns 200 with the no-information reply when a document is not found", async (t) => {
  const gateway = loadGateway(t);
  fakeBackend(t, [call("read_document", { doc_code: "DOC-NONE" }), [{ text: "It costs 450." }]]);
  const c = ctx();
  const reply = await gateway.runAgent(c, "DOC-NONE price?", AGENT);
  assert.equal(c.runStatus === "error" ? 503 : 200, 200);
  assert.match(reply, /ขออภัย/);
});

test("a successful list_documents call does not back an invented price", async (t) => {
  const gateway = loadGateway(t);
  const agent = { ...AGENT, allowed_tools: [...AGENT.allowed_tools, "list_documents"] };
  const log = fakeBackend(t, [call("list_documents"), [{ text: "Clear 6mm is 999 THB per sq ft." }]]);
  const c = ctx();
  const reply = await gateway.runAgent(c, "price of clear glass?", agent);
  assert.equal(log.toolCalls[0].status, "success");
  assert.match(reply, HANDOFF);
  assert.equal(log.runPatches.at(-1).error, "Unsupported number replaced with handoff");
});
