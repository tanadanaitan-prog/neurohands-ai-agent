const { test } = require("node:test");
const assert = require("node:assert/strict");

function fixture(t, document) {
  const env = { SUPABASE_URL: "https://la04-documents.invalid", SUPABASE_SERVICE_KEY: "sb_secret_synthetic",
    GEMINI_API_KEY: "", FALLBACK_API_KEY: "", ENABLE_STUDIO: "false", SOFTWARE_ADMISSION_ENABLED: "false" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[require.resolve("../src/server")];
  });
  const reads = [];
  t.mock.method(globalThis, "fetch", async (target, options = {}) => {
    const url = new URL(target);
    assert.equal(url.hostname, "la04-documents.invalid", "No model or LINE request permitted");
    if (url.pathname.endsWith("/client_documents")) {
      reads.push(url);
      const matches = url.searchParams.get("client_account_id") === `eq.${document.client_account_id}` &&
        url.searchParams.get("department") === `eq.${document.department}` &&
        url.searchParams.get("doc_code") === `eq.${document.doc_code}`;
      return Response.json(matches ? [document] : []);
    }
    assert.ok(url.pathname.endsWith("/tool_calls"));
    assert.equal(options.method, "POST");
    return Response.json([{ id: 1 }]);
  });
  const context = { clientAccountId: 11, lineUserId: "synthetic-client", department: "sales", allowedTools: ["read_document"] };
  return { read: (ctx = context) => gateway.executeToolWithLog(ctx, "synthetic-run", "read_document", { doc_code: "DOC-ONE" }), reads, context };
}

function document(overrides = {}) {
  return { client_account_id: 11, department: "sales", doc_code: "DOC-ONE", file_name: "synthetic.txt",
    parsed_status: "parsed", parsed_summary: { text: "Approved synthetic content", extraction_complete: true }, ...overrides };
}

test("LA04 document tool rejects metadata-only extraction despite parsed label", async t => {
  const f = fixture(t, document({ parsed_summary: { source: { file_name: "blank.txt" }, extraction_complete: true } }));
  assert.equal((await f.read()).readable, false);
});

test("LA04 document tool rejects whitespace content despite parsed label", async t => {
  const f = fixture(t, document({ parsed_summary: { text: " \r\n ", extraction_complete: true } }));
  assert.equal((await f.read()).readable, false);
});

test("LA04 document tool cannot mark partial status as complete", async t => {
  const f = fixture(t, document({ parsed_status: "partial" }));
  const result = await f.read();
  assert.equal(result.readable, true);
  assert.equal(result.extraction_complete, false);
  assert.equal(result.content.extraction_complete, false);
});

test("LA04 document tool retains valid extracted evidence", async t => {
  const f = fixture(t, document());
  const result = await f.read();
  assert.equal(result.readable, true);
  assert.equal(result.content.text, "Approved synthetic content");
  assert.equal(result.extraction_complete, true);
  assert.equal(f.reads[0].searchParams.get("client_account_id"), "eq.11");
  assert.equal(f.reads[0].searchParams.get("department"), "eq.sales");
});

test("LA04 document tool does not read another client or department", async t => {
  const f = fixture(t, document());
  assert.equal((await f.read({ ...f.context, clientAccountId: 22 })).found, false);
  assert.equal((await f.read({ ...f.context, department: "accounting" })).found, false);
});

test("LA04 document tool keeps unsupported files unreadable", async t => {
  const f = fixture(t, document({ file_name: "unread.pdf", parsed_status: "unsupported", parsed_summary: { extraction_complete: false } }));
  const result = await f.read();
  assert.equal(result.readable, false);
  assert.equal(result.parsed_status, "unsupported");
});
