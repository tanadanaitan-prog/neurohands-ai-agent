const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PGlite } = require("@electric-sql/pglite");

function browserHarness(pageHtml, { file, session, finalizeResults = [], completeTransfer = false }) {
  const inlineScripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(inlineScripts.length > 0, "The upload page must contain an inline controller");
  const values = new Map();
  const uploads = [];
  const calls = { session: 0, finalize: 0 };
  const statusNode = { textContent: "" };
  const button = { disabled: false };
  const input = { files: [file] };
  const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

  class Upload {
    constructor(uploadFile, options) {
      this.file = uploadFile;
      this.options = options;
      uploads.push(this);
    }

    async findPreviousUploads() { return []; }
    resumeFromPreviousUpload(previous) { this.previous = previous; }
    start() {
      if (completeTransfer) this.options.onSuccess();
    }
  }

  const context = {
    console,
    location: { search: "?t=browser-test-token" },
    document: { getElementById: (id) => ({ f: input, st: statusNode, "upload-button": button })[id] },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    fetch: async (url) => {
      if (String(url).startsWith("/api/upload/session?")) {
        calls.session++;
        return response(200, { ...session });
      }
      if (String(url).startsWith("/api/upload/finalize?")) {
        const result = finalizeResults[calls.finalize++] || { status: 200, data: { doc_code: session.doc_code, parsed: "unsupported" } };
        return response(result.status, result.data);
      }
      throw new Error(`Unexpected browser request: ${url}`);
    },
    tus: { Upload },
  };
  vm.runInNewContext(inlineScripts.at(-1), context, { filename: "resumable-upload-page.js" });
  return { context, values, uploads, calls, statusNode, button };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, overrides = {}) {
  Object.assign(process.env, {
    LINE_CHANNEL_SECRET: "local-upload-signing", LINE_CHANNEL_ACCESS_TOKEN: "local-line",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    SUPABASE_URL: "https://project-ref.supabase.co", SUPABASE_SERVICE_KEY: "sb_secret_local-upload",
    FOUNDER_LINE_ID: "operator", NEUROHANDS_API_KEY: "local-api", GEMINI_API_KEY: "local-model",
    GEMINI_ENABLED: "true", RESUMABLE_UPLOAD_ENABLED: "true", UPLOAD_MAX_BYTES: "50000000",
    ENABLE_STUDIO: "false", ...overrides,
  });
  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");
  const tables = {
    client_accounts: [{ id: 1, client_code: "KNC", company: "KNC Glass", active: true }],
    client_documents: [], staff_activations: [], client_agent_bindings: [],
  };
  const state = { tables, requests: [], objectSize: null, signingFails: false, cleanupFails: false };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(String(address));
    const method = options.method || "GET";
    state.requests.push({ host: url.hostname, path: url.pathname, method });
    assert.equal(url.hostname, "project-ref.supabase.co", "The server must never proxy TUS file bytes");
    assert.equal(options.headers.apikey, "sb_secret_local-upload");
    assert.equal(options.headers.Authorization, undefined);

    if (url.pathname.startsWith("/storage/v1/object/upload/sign/neurohands-docs/")) {
      assert.equal(method, "POST");
      if (state.signingFails) return json({ message: "injected" }, 503);
      return json({ url: `${url.pathname.replace("/storage/v1", "")}?token=signed-upload-token` });
    }
    if (url.pathname.startsWith("/storage/v1/object/info/neurohands-docs/")) {
      assert.equal(method, "GET");
      return json({ size: state.objectSize });
    }
    if (url.pathname.startsWith("/storage/v1/object/authenticated/neurohands-docs/")) {
      assert.fail("Large-file finalization must not download the object through Railway");
    }
    if (url.pathname === "/storage/v1/object/neurohands-docs") {
      assert.equal(method, "DELETE");
      const { prefixes } = JSON.parse(options.body);
      return state.cleanupFails ? json({ message: "injected" }, 503) : json([{ name: prefixes[0] }]);
    }

    const name = url.pathname.replace("/rest/v1/", "");
    assert.ok(Object.hasOwn(tables, name), `Unexpected table ${name}`);
    const matches = (row) => [...url.searchParams].every(([key, value]) => {
      if (["select", "order", "limit"].includes(key)) return true;
      if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
      return true;
    });
    if (method === "GET") return json(tables[name].filter(matches));
    const fields = JSON.parse(options.body);
    if (method === "POST") {
      const row = { id: tables[name].length + 1, ...fields };
      tables[name].push(row);
      return json([row], 201);
    }
    assert.equal(method, "PATCH");
    const updated = tables[name].filter(matches);
    updated.forEach((row) => Object.assign(row, fields));
    return options.headers.Prefer?.includes("return=representation") ? json(updated) : new Response(null, { status: 204 });
  });

  const server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (urlPath, value, method = "POST") => new Promise((resolve, reject) => {
    const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
    const request = http.request({ host: "127.0.0.1", port: server.address().port, path: urlPath, method,
      headers: body ? { "content-type": "application/json", "content-length": body.length } : {} }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text, data: text && response.headers["content-type"]?.includes("json") ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    request.end(body);
  });
  return { gateway, state, request };
}

test("gated resumable upload sessions keep large file bytes out of Railway", async (t) => {
  const f = await fixture(t);
  const token = f.gateway.makeUploadToken(1, "sales", "operator");
  const page = await f.request(`/upload?t=${token}`, undefined, "GET");
  assert.equal(page.status, 200);
  assert.match(page.text, /max 50 MB/);
  assert.match(page.text, /files above 10 MiB are stored for review/);
  assert.match(page.text, /tus-4\.3\.1\.min\.js/);
  assert.match(page.headers["content-security-policy"], /project-ref\.storage\.supabase\.co/);
  const inlineScripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(inlineScripts.length > 0);
  for (const script of inlineScripts) assert.doesNotThrow(() => new Function(script));
  const clientLibrary = await f.request("/assets/tus-4.3.1.min.js", undefined, "GET");
  assert.equal(clientLibrary.status, 200);
  assert.match(clientLibrary.headers["content-type"], /javascript/);
  const size = 11 * 1024 * 1024;
  const started = await f.request(`/api/upload/session?t=${token}`, { file_name: "catalog.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: size });
  assert.equal(started.status, 200);
  assert.equal(started.data.endpoint, "https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign");
  assert.equal(started.data.signature, "signed-upload-token");
  assert.equal(started.data.chunk_bytes, 6 * 1024 * 1024);
  assert.equal(started.data.max_bytes, 50000000);
  assert.ok(started.data.signature_expires_at > Date.now());
  assert.ok(started.data.reuse_until > started.data.signature_expires_at);
  assert.equal(started.data.storage_path.startsWith("KNC/SAL/"), true);
  assert.equal(f.state.tables.client_documents[0].size_bytes, size);
  assert.equal(f.state.tables.client_documents[0].parsed_status, "pending");

  const refreshed = await f.request(`/api/upload/signature?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.signature, "signed-upload-token");
  assert.ok(refreshed.data.signature_expires_at > Date.now());

  f.state.objectSize = size;
  const completed = await f.request(`/api/upload/finalize?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.parsed, "unsupported");
  assert.equal(f.state.tables.client_documents[0].parsed_summary.original_stored, true);
  assert.equal(f.state.tables.client_documents[0].parsed_summary.extraction_complete, false);
  assert.equal(f.state.requests.some((request) => request.host === "project-ref.storage.supabase.co"), false);

  const repeated = await f.request(`/api/upload/finalize?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(repeated.status, 200, "Finalization is idempotent after confirmed storage");
  const refreshAfterCompletion = await f.request(`/api/upload/signature?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(refreshAfterCompletion.status, 404);
});

test("browser resume fingerprints are isolated by the tenant-bound document code", async (t) => {
  const f = await fixture(t);
  const token = f.gateway.makeUploadToken(1, "sales", "operator");
  const page = await f.request(`/upload?t=${token}`, undefined, "GET");
  assert.equal(page.status, 200);
  const file = { name: "same-file.pdf", type: "application/pdf", size: 20_000_000, lastModified: 12345 };
  const common = {
    endpoint: "https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign",
    bucket: "neurohands-docs", chunk_bytes: 6 * 1024 * 1024,
    signature: "signed-upload-token", signature_expires_at: Date.now() + 60_000,
    reuse_until: Date.now() + 3_600_000,
  };
  const knc = browserHarness(page.text, {
    file,
    session: { ...common, doc_code: "KNC-SAL-DOC-ONE", storage_path: "KNC/SAL/KNC-SAL-DOC-ONE.pdf" },
  });
  const other = browserHarness(page.text, {
    file,
    session: { ...common, doc_code: "OTHER-SAL-DOC-TWO", storage_path: "OTHER/SAL/OTHER-SAL-DOC-TWO.pdf" },
  });

  await knc.context.up();
  await other.context.up();
  assert.equal(knc.uploads.length, 1);
  assert.equal(other.uploads.length, 1);
  const kncFingerprint = await knc.uploads[0].options.fingerprint();
  const otherFingerprint = await other.uploads[0].options.fingerprint();
  assert.equal(kncFingerprint, "nh-resumable-KNC-SAL-DOC-ONE");
  assert.equal(otherFingerprint, "nh-resumable-OTHER-SAL-DOC-TWO");
  assert.notEqual(kncFingerprint, otherFingerprint, "The same browser File must not resume another tenant's upload URL");
});

test("browser retries finalization without uploading the completed TUS object again", async (t) => {
  const f = await fixture(t);
  const token = f.gateway.makeUploadToken(1, "sales", "operator");
  const page = await f.request(`/upload?t=${token}`, undefined, "GET");
  const session = {
    doc_code: "KNC-SAL-COMPLETE", storage_path: "KNC/SAL/KNC-SAL-COMPLETE.pdf",
    endpoint: "https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign",
    bucket: "neurohands-docs", chunk_bytes: 6 * 1024 * 1024,
    signature: "signed-upload-token", signature_expires_at: Date.now() + 60_000,
    reuse_until: Date.now() + 3_600_000,
  };
  const browser = browserHarness(page.text, {
    file: { name: "complete.pdf", type: "application/pdf", size: 20_000_000, lastModified: 54321 },
    session,
    completeTransfer: true,
    finalizeResults: [
      { status: 409, data: { error: "Storage has not confirmed the complete file" } },
      { status: 200, data: { doc_code: session.doc_code, parsed: "unsupported" } },
    ],
  });

  await browser.context.up();
  await settle();
  assert.equal(browser.calls.session, 1);
  assert.equal(browser.calls.finalize, 1);
  assert.equal(browser.uploads.length, 1);
  assert.equal(JSON.parse([...browser.values.values()][0]).transfer_complete, true);
  assert.equal(browser.button.disabled, false);

  await browser.context.up();
  assert.equal(browser.calls.session, 1, "Retry must reuse the existing document reservation");
  assert.equal(browser.calls.finalize, 2);
  assert.equal(browser.uploads.length, 1, "Retry must not create a second TUS upload");
  assert.equal(browser.values.size, 0, "Successful finalization clears the completed local session");
  assert.equal(browser.statusNode.textContent, `Filed as ${session.doc_code} — unsupported`);
});

test("resumable upload initiation fails closed on limit, token, authorization and signing errors", async (t) => {
  await t.test("50 MB exact-byte boundary", async (t) => {
    const f = await fixture(t);
    const token = f.gateway.makeUploadToken(1, "sales", "operator");
    const accepted = await f.request(`/api/upload/session?t=${token}`, { file_name: "archive.pdf", mime: "application/pdf", size_bytes: 50000000 });
    assert.equal(accepted.status, 200);
    const rejected = await f.request(`/api/upload/session?t=${token}`, { file_name: "archive.pdf", mime: "application/pdf", size_bytes: 50000001 });
    assert.equal(rejected.status, 413);
  });
  await t.test("tampered token", async (t) => {
    const f = await fixture(t);
    const result = await f.request("/api/upload/session?t=invalid", { file_name: "archive.pdf", mime: "application/pdf", size_bytes: 1 });
    assert.equal(result.status, 403);
    assert.equal(f.state.tables.client_documents.length, 0);
  });
  await t.test("disabled client", async (t) => {
    const f = await fixture(t);
    f.state.tables.client_accounts[0].active = false;
    const token = f.gateway.makeUploadToken(1, "sales", "operator");
    const result = await f.request(`/api/upload/session?t=${token}`, { file_name: "archive.pdf", mime: "application/pdf", size_bytes: 1 });
    assert.equal(result.status, 403);
    assert.equal(f.state.tables.client_documents.length, 0);
  });
  await t.test("signing failure leaves auditable failed metadata", async (t) => {
    const f = await fixture(t);
    f.state.signingFails = true;
    const token = f.gateway.makeUploadToken(1, "sales", "operator");
    const result = await f.request(`/api/upload/session?t=${token}`, { file_name: "archive.pdf", mime: "application/pdf", size_bytes: 1 });
    assert.equal(result.status, 503);
    assert.equal(f.state.tables.client_documents[0].parsed_status, "failed");
    assert.equal(f.state.tables.client_documents[0].parsed_summary.original_stored, false);
  });
  await t.test("invalid or above-plan configuration fails before reservation", async (t) => {
    for (const [name, value] of [["malformed", "invalid"], ["above Free limit", "50000001"]]) {
      await t.test(name, async (t) => {
        const f = await fixture(t, { UPLOAD_MAX_BYTES: value });
        const token = f.gateway.makeUploadToken(1, "sales", "operator");
        const result = await f.request(`/api/upload/session?t=${token}`, {
          file_name: "archive.pdf", mime: "application/pdf", size_bytes: 1,
        });
        assert.equal(result.status, 503);
        assert.equal(f.state.tables.client_documents.length, 0);
      });
    }
  });
});

test("ordinary-user sessions, signature refresh and finalization stay inside an active account binding", async (t) => {
  const f = await fixture(t);
  f.state.tables.client_accounts.push({ id: 2, client_code: "OTHER", company: "Other Client", active: true });
  const binding = { id: 1, line_user_id: "ordinary-user", client_account_id: 1, department: "sales", status: "active" };
  f.state.tables.client_agent_bindings.push(binding);
  const ownToken = f.gateway.makeUploadToken(1, "sales", "ordinary-user");
  const foreignToken = f.gateway.makeUploadToken(2, "sales", "ordinary-user");

  const own = await f.request(`/api/upload/session?t=${ownToken}`, {
    file_name: "customer.pdf", mime: "application/pdf", size_bytes: 20_000_000,
  });
  assert.equal(own.status, 200);
  assert.equal(f.state.tables.client_documents.length, 1);
  assert.equal(f.state.tables.client_documents[0].client_account_id, 1);

  const foreign = await f.request(`/api/upload/session?t=${foreignToken}`, {
    file_name: "customer.pdf", mime: "application/pdf", size_bytes: 20_000_000,
  });
  assert.equal(foreign.status, 403);
  assert.equal(f.state.tables.client_documents.length, 1, "Cross-account denial must happen before reserving metadata");

  binding.status = "revoked";
  const signaturesBeforeRevocation = f.state.requests.filter((request) => request.path.startsWith("/storage/v1/object/upload/sign/")).length;
  const refresh = await f.request(`/api/upload/signature?t=${ownToken}`, { doc_code: own.data.doc_code });
  assert.equal(refresh.status, 403);
  const finalize = await f.request(`/api/upload/finalize?t=${ownToken}`, { doc_code: own.data.doc_code });
  assert.equal(finalize.status, 403);
  assert.equal(f.state.tables.client_documents[0].parsed_status, "pending");
  assert.equal(
    f.state.requests.filter((request) => request.path.startsWith("/storage/v1/object/upload/sign/")).length,
    signaturesBeforeRevocation,
    "A revoked user must not receive another signed Storage capability",
  );
});

test("resumable finalization refuses cross-client references and size mismatches", async (t) => {
  const f = await fixture(t);
  const token = f.gateway.makeUploadToken(1, "sales", "operator");
  const started = await f.request(`/api/upload/session?t=${token}`, { file_name: "archive.pdf", mime: "application/pdf", size_bytes: 20000000 });
  f.state.objectSize = 19999999;
  f.state.requests.length = 0;
  const mismatch = await f.request(`/api/upload/finalize?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.data.terminal, true);
  assert.equal(f.state.tables.client_documents[0].parsed_status, "failed");
  assert.equal(f.state.tables.client_documents[0].parsed_summary.original_stored, false);
  assert.equal(f.state.tables.client_documents[0].parsed_summary.upload_state, "size_mismatch_removed");
  assert.equal(f.state.requests.some((request) => request.method === "DELETE"), true);
  const pendingWrite = f.state.requests.findIndex((request) => request.method === "PATCH" && request.path === "/rest/v1/client_documents");
  const objectDelete = f.state.requests.findIndex((request) => request.method === "DELETE");
  assert.ok(pendingWrite >= 0 && pendingWrite < objectDelete, "Cleanup intent must be stored before deleting the object");

  const repeated = await f.request(`/api/upload/finalize?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(repeated.status, 409);
  assert.equal(repeated.data.terminal, true, "A lost terminal response must remain terminal on retry");

  const otherToken = f.gateway.makeUploadToken(1, "marketing", "operator");
  const wrongDepartment = await f.request(`/api/upload/finalize?t=${otherToken}`, { doc_code: started.data.doc_code });
  assert.equal(wrongDepartment.status, 404);
});

test("a failed size-mismatch cleanup stays retryable without issuing another upload signature", async (t) => {
  const f = await fixture(t);
  const token = f.gateway.makeUploadToken(1, "sales", "operator");
  const started = await f.request(`/api/upload/session?t=${token}`, {
    file_name: "archive.pdf", mime: "application/pdf", size_bytes: 20_000_000,
  });
  f.state.objectSize = 19_999_999;
  f.state.cleanupFails = true;

  const first = await f.request(`/api/upload/finalize?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(first.status, 503);
  assert.equal(first.data.terminal, false);
  assert.equal(f.state.tables.client_documents[0].parsed_status, "failed");
  assert.equal(f.state.tables.client_documents[0].parsed_summary.upload_state, "size_mismatch_cleanup_pending");
  const refresh = await f.request(`/api/upload/signature?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(refresh.status, 404, "Cleanup-pending sessions must not receive a fresh upload capability");

  f.state.cleanupFails = false;
  const retried = await f.request(`/api/upload/finalize?t=${token}`, { doc_code: started.data.doc_code });
  assert.equal(retried.status, 409);
  assert.equal(retried.data.terminal, true);
  assert.equal(f.state.tables.client_documents[0].parsed_summary.original_stored, false);
  assert.equal(f.state.tables.client_documents[0].parsed_summary.upload_state, "size_mismatch_removed");
});

test("resumable upload metadata migration enforces the exact 50 MB boundary", async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  await database.exec(fs.readFileSync(path.join(__dirname, "fixtures/legacy-schema.sql"), "utf8"));
  await database.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql"), "utf8"));
  await database.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260917103000_resumable_upload_metadata.sql"), "utf8"));
  const account = (await database.query("select id from client_accounts where client_code='KNC'")).rows[0].id;
  const insert = (code, size) => database.query(
    "insert into client_documents(doc_code,client_account_id,department,file_name,mime,size_bytes,storage_path) values ($1,$2,'sales','archive.pdf','application/pdf',$3,$4)",
    [code, account, size, `KNC/SAL/${code}.pdf`],
  );
  await insert("EXACT-50MB", 50000000);
  await assert.rejects(insert("OVER-50MB", 50000001), { code: "23514" });
});
