"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const telemetry = require("../src/observability/sentry");
const { beforeSend, privacyTransport, createSentry } = telemetry;

// Synthetic only: neither real customer identifiers nor a usable Sentry DSN.
const PRIVATE = {
  text: "SYNTHETIC_LINE_MESSAGE_สอบถามราคา",
  userId: "U11111111111111111111111111111111",
  displayName: "SYNTHETIC_DISPLAY_NAME",
  replyToken: "22222222222222222222222222222222",
  header: "SYNTHETIC_AUTH_HEADER", cookie: "SYNTHETIC_SESSION_COOKIE",
};
const DSN = "https://synthetic@example.invalid/1";
const webhook = { events: [{ type: "message", source: { userId: PRIVATE.userId },
  message: { type: "text", text: PRIVATE.text }, replyToken: PRIVATE.replyToken,
  displayName: PRIVATE.displayName }] };
const combined = Object.values(PRIVATE).join(" ");
const SERVER = path.resolve(__dirname, "../src/server.js");

function assertPrivateAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const marker of Object.values(PRIVATE)) assert.ok(!serialized.includes(marker), "private marker survived");
}

function assertSafeEvent(event) {
  assertPrivateAbsent(event);
  assert.deepEqual(Object.keys(event).sort(), ["event_id", "exception", "level", "platform", "tags", "timestamp"]);
  assert.match(event.event_id, /^[a-f0-9]{32}$/);
  assert.notEqual(event.event_id, PRIVATE.replyToken);
  assert.equal(event.level, "error");
  assert.equal(event.platform, "node");
  assert.deepEqual(event.tags, { privacy_filter: "allowlist-v1" });
  assert.ok(Math.abs(event.timestamp - Date.now() / 1000) < 10);
  assert.equal(event.exception.values.length, 1);
  const error = event.exception.values[0];
  assert.equal(error.type, "NeurohandsExpressError");
  assert.equal(error.value, "Neurohands Express error; private details withheld");
  assert.deepEqual(Object.keys(error).sort(), error.stacktrace ? ["stacktrace", "type", "value"] : ["type", "value"]);
  for (const frame of error.stacktrace?.frames || []) {
    assert.equal(frame.filename, "src/server.js");
    assert.ok(Object.keys(frame).every((key) => ["filename", "lineno", "colno", "in_app"].includes(key)));
  }
}

function unsafeEvent() {
  return {
    event_id: PRIVATE.replyToken, timestamp: 1, message: combined, logentry: { message: combined, params: [webhook] },
    user: { id: PRIVATE.userId, username: PRIVATE.displayName },
    request: { data: webhook, body: webhook, headers: { authorization: PRIVATE.header },
      cookies: PRIVATE.cookie, url: `https://example.invalid/${PRIVATE.userId}?q=${PRIVATE.replyToken}` },
    extra: { nested: [{ webhook }] }, contexts: { line: webhook }, tags: { [PRIVATE.userId]: combined },
    breadcrumbs: [{ message: combined, data: webhook }], fingerprint: [combined],
    transaction: combined, server_name: combined, release: combined, environment: combined,
    modules: { [combined]: combined }, sdk: { name: combined }, future_field: webhook,
    exception: { values: [{ type: combined, value: combined, mechanism: { data: webhook },
      stacktrace: { frames: [{ filename: SERVER, lineno: 1456, colno: 7, function: combined,
        vars: webhook, pre_context: [combined], context_line: combined, post_context: [combined], abs_path: combined }] } },
      { value: combined }] },
  };
}

test("beforeSend removes synthetic LINE data in webhook, error, scope and future fields", () => {
  const input = unsafeEvent();
  const original = JSON.stringify(input);
  const safe = beforeSend(input);
  assertSafeEvent(safe);
  assert.deepEqual(safe.exception.values[0].stacktrace.frames,
    [{ filename: "src/server.js", lineno: 1456, colno: 7, in_app: true }]);
  assert.equal(JSON.stringify(input), original, "do not alter the application's original error data");
});

test("arbitrary strings and opaque nested copies never become output fields", () => {
  for (const field of ["message", "extra", "contexts", "request", "user", "breadcrumbs", "future", PRIVATE.userId]) {
    for (const value of [combined, webhook, JSON.stringify(webhook), Buffer.from(combined)]) {
      assertSafeEvent(beforeSend({ [field]: value }));
    }
  }
});

test("stack filenames, functions, source and invalid numeric fields are not retained", () => {
  const safe = beforeSend({ exception: { values: [{ stacktrace: { frames: [
    { filename: `src/${combined}.js`, lineno: 1 },
    { filename: SERVER, lineno: PRIVATE.text },
    { filename: SERVER, lineno: Infinity },
    { filename: SERVER, lineno: -1 },
    { filename: SERVER, lineno: 100001 },
    { filename: SERVER, lineno: 12, colno: PRIVATE.replyToken },
  ] } }] } });
  assertSafeEvent(safe);
  assert.deepEqual(safe.exception.values[0].stacktrace.frames, [{ filename: "src/server.js", lineno: 12, in_app: true }]);
});

test("cycles and untrusted toJSON are ignored without traversing customer payloads", () => {
  const input = unsafeEvent(); input.extra.self = input;
  input.toJSON = () => { throw new Error("must not serialize raw input"); };
  assertSafeEvent(beforeSend(input));
});

test("unreadable structures and non-error events are dropped", () => {
  assert.equal(beforeSend(Object.defineProperty({}, "exception", { get() { throw Error("bad getter"); } })), null);
  for (const value of [null, undefined, "text", 7, { type: "transaction" }, { type: "replay_event" }]) {
    assert.equal(beforeSend(value), null);
  }
});

test("attachments are removed even when their names and content hold private values", () => {
  const hint = { attachments: [{ filename: PRIVATE.displayName, data: Buffer.from(combined) }], originalException: new Error(combined) };
  assertSafeEvent(beforeSend(unsafeEvent(), hint));
  assert.deepEqual(hint.attachments, []);
  assert.equal(beforeSend(unsafeEvent(), Object.freeze(hint)), null);
});

test("final transport removes envelope metadata, added fields and every non-error item", async () => {
  const sent = [];
  const transport = privacyTransport({ send: async (envelope) => { sent.push(envelope); return {}; }, flush: async () => true });
  await transport.send([{ trace: webhook, sdk: webhook, event_id: PRIVATE.replyToken }, [
    [{ type: "attachment", filename: PRIVATE.displayName }, Buffer.from(combined)],
    [{ type: "event", custom: webhook }, unsafeEvent()],
    ...["transaction", "span", "log", "metric", "session", "client_report", "profile", "replay_event", "feedback"]
      .map((type) => [{ type }, webhook]),
  ]]);
  assert.equal(sent.length, 1);
  assertPrivateAbsent(sent);
  assert.deepEqual(Object.keys(sent[0][0]).sort(), ["event_id", "sent_at"]);
  assert.equal(sent[0][1].length, 1);
  assert.deepEqual(sent[0][1][0][0], { type: "event" });
  assertSafeEvent(sent[0][1][0][1]);
  assert.equal(sent[0][0].event_id, sent[0][1][0][1].event_id);
});

test("malformed envelopes and non-error-only telemetry never reach transport", async () => {
  let calls = 0;
  const transport = privacyTransport({ send() { calls++; }, flush: async () => true });
  for (const value of [null, {}, [], [{}, []], [{}, [[{ type: "attachment" }, combined]]],
    [{}, [[{ type: "event" }, { type: "transaction", message: combined }]]]]) await transport.send(value);
  assert.equal(calls, 0);
});

test("stateful stack getters cannot replace checked numbers with private text", async () => {
  const sent = [];
  const transport = privacyTransport({ send: async (envelope) => { sent.push(envelope); }, flush: async () => true });
  const calls = { lineno: 0, colno: 0 };
  const frame = { filename: SERVER };
  for (const key of Object.keys(calls)) Object.defineProperty(frame, key, {
    get() { return ++calls[key] <= 3 ? 7 : combined; },
  });
  await transport.send([{}, [[{ type: "event" }, { exception: { values: [{ stacktrace: { frames: [frame] } }] } }]]]);
  assert.equal(sent.length, 1);
  assertSafeEvent(sent[0][1][0][1]);
  assert.deepEqual(calls, { lineno: 1, colno: 1 });
  assert.equal(sent[0][1][0][1].exception.values[0].stacktrace.frames[0].lineno, 7);
});

test("transport errors do not escape into application handling", async () => {
  for (const fail of [() => { throw Error(combined); }, async () => { throw Error(combined); }]) {
    const transport = privacyTransport({ send: fail, flush: fail });
    await transport.send([{}, [[{ type: "event" }, unsafeEvent()]]]);
    assert.equal(await transport.flush(1), false);
  }
});

function fakeSdk({ captureFails = false, initFails = false } = {}) {
  const record = { captured: [] };
  const sdk = {
    SDK_VERSION: "11.6.0", defaultStackParser: () => [],
    NodeClient: class {
      constructor(options) { record.options = options; }
      init() { if (initFails) throw Error(combined); }
      async flush() { return true; }
      async close() { record.closed = true; return true; }
    },
    Scope: class {
      setClient(client) { record.client = client; }
      captureException(error) { if (captureFails) throw Error(combined); record.captured.push(error); }
    },
  };
  return { sdk, record };
}

test("no DSN means no SDK import, initialization or transport", () => {
  for (const SENTRY_DSN of [undefined, "", "   "]) {
    const result = createSentry({ env: { SENTRY_DSN }, loadSdk() { assert.fail("SDK must remain unloaded"); } });
    assert.equal(result.enabled, false);
    assert.equal(result.status, "disabled_no_dsn");
  }
});

test("missing, unqualified or failing SDK disables telemetry without crashing server", () => {
  assert.equal(createSentry({ env: { SENTRY_DSN: DSN }, loadSdk() { throw Error("missing"); } }).status, "disabled_sdk_unavailable");
  assert.equal(createSentry({ env: { SENTRY_DSN: DSN }, loadSdk: () => ({ SDK_VERSION: "future" }) }).status, "disabled_sdk_version");
  const { sdk } = fakeSdk({ initFails: true });
  assert.equal(createSentry({ env: { SENTRY_DSN: DSN }, loadSdk: () => sdk }).status, "disabled_sdk_initialization");
});

test("setup disables automatic capture paths and supplies the privacy hooks", () => {
  const { sdk, record } = fakeSdk();
  assert.equal(createSentry({ env: { SENTRY_DSN: DSN }, loadSdk: () => sdk }).enabled, true);
  const options = record.options;
  assert.equal(options.beforeSend, beforeSend);
  assert.deepEqual(options.integrations, []);
  for (const flag of ["defaultIntegrations", "debug", "enableLogs", "enableMetrics", "sendClientReports",
    "includeServerName", "enableOpenTelemetrySetup", "enableRuntimeChannelInjection"]) assert.equal(options[flag], false);
  assert.equal(options.tracesSampleRate, 0);
  assert.deepEqual(options.dataCollection.httpBodies, []);
  for (const hook of ["beforeBreadcrumb", "beforeSendTransaction", "beforeSendLog", "beforeSendMetric"]) assert.equal(options[hook](webhook), null);
});

test("middleware forwards the identical error once and never reads/modifies the request or reply", () => {
  for (const enabled of [false, true]) for (const captureFails of [false, true]) {
    const { sdk } = fakeSdk({ captureFails });
    const instance = createSentry({ env: { SENTRY_DSN: enabled ? DSN : "" }, loadSdk: () => sdk });
    const forbidden = new Proxy({}, { get() { assert.fail("must not read request/response"); }, set() { assert.fail("must not modify request/response"); } });
    const error = new Error(combined); let count = 0;
    instance.middleware(error, forbidden, forbidden, (received) => { assert.equal(received, error); count++; });
    assert.equal(count, 1);
  }
});

let realSdk;
try { realSdk = require("@sentry/node"); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

test("real SDK sends only sanitized error envelopes; no network transport", { skip: !realSdk && "optional SDK not installed in draft" }, async () => {
  const sent = [];
  const instance = createSentry({ env: { SENTRY_DSN: DSN }, loadSdk: () => realSdk,
    makeTransport: () => ({ send: async (envelope) => { sent.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
  try {
    assert.equal(instance.enabled, true);
    const error = new Error(JSON.stringify(webhook));
    error.stack = `Error: ${combined}\n    at privateFunction (${SERVER}:1456:7)`;
    error.request = { body: webhook, headers: PRIVATE.header, cookies: PRIVATE.cookie };
    error.cause = new Error(combined);
    let forwarded = false;
    instance.middleware(error, webhook, {}, (actual) => { assert.equal(actual, error); forwarded = true; });
    assert.equal(forwarded, true);
    assert.equal(await instance.flush(), true);
    assert.equal(sent.length, 1, "positive control: an event must actually pass the SDK");
    assertPrivateAbsent(sent);
    assertSafeEvent(sent[0][1][0][1]);
    assert.deepEqual(sent[0][1][0][1].exception.values[0].stacktrace.frames,
      [{ filename: "src/server.js", lineno: 1456, colno: 7, in_app: true }]);
  } finally { await instance.close(); }
});

test("actual gateway retains its invalid-JSON response with Sentry enabled", { skip: !realSdk && "optional SDK not installed in draft" }, async (t) => {
  const sent = [];
  const instance = createSentry({ env: { SENTRY_DSN: DSN }, loadSdk: () => realSdk,
    makeTransport: () => ({ send: async (envelope) => { sent.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
  assert.equal(instance.enabled, true);
  t.mock.method(telemetry, "createSentry", () => instance);
  delete require.cache[require.resolve("../src/server")];
  const { app } = require("../src/server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/agent/run", method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": PRIVATE.header, Cookie: PRIVATE.cookie } }, (res) => {
        let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on("error", reject); req.end(`{"private":"${combined}`);
    });
    assert.deepEqual(result, { status: 400, body: { error: "Invalid request body" } });
    await instance.flush();
    assert.equal(sent.length, 1);
    assertPrivateAbsent(sent);
    assertSafeEvent(sent[0][1][0][1]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await instance.close();
    delete require.cache[require.resolve("../src/server")];
  }
});
