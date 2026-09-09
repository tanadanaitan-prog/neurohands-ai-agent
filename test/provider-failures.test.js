const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MAX_ERROR_BYTES, classifyProviderFailure, readProviderFailure, createProviderFailures } = require("../src/lib/provider-failures");

const PRIVATE = "private-fixture-do-not-store-or-log";
const encode = (text) => new TextEncoder().encode(text);
const jsonResponse = (body, status = 429) => new Response(JSON.stringify(body), { status });

test("account-wide provider failures map to bounded categories without returning message content", async () => {
  const examples = [
    ["credit_balance_exhausted", "credit_exhausted"],
    ["insufficient_quota", "quota_exhausted"],
    ["organization_spend_limit_exceeded", "spend_limit_reached"],
    ["project_spend_limit_exceeded", "spend_limit_reached"],
    ["organization_usage_limit_exceeded", "quota_exhausted"],
    ["billing_hard_limit_reached", "spend_limit_reached"],
    ["invalid_api_key", "authentication_rejected"],
  ];
  for (const [code, expected] of examples) {
    const response = jsonResponse({ error: { code, message: PRIVATE, param: PRIVATE }, secret: PRIVATE });
    assert.equal(await readProviderFailure(response), expected);
  }
  assert.equal(await readProviderFailure(jsonResponse({ error: { type: " INSUFFICIENT_QUOTA ", message: PRIVATE } })), "quota_exhausted");
  assert.equal(await readProviderFailure(jsonResponse({ error: { code: "credit_balance_exhausted", type: "insufficient_quota" } })), "credit_exhausted");
  assert.equal(await readProviderFailure(jsonResponse({ error: { code: "billing_hard_limit_reached" } }, 403)), "spend_limit_reached");
});

test("401 rejects authentication immediately without reading or awaiting body cancellation", async () => {
  let cancelled = 0;
  const response = { status: 401, body: {
    getReader() { assert.fail("401 must not read a provider response body"); },
    cancel() { cancelled += 1; return new Promise(() => {}); },
  } };
  assert.equal(await readProviderFailure(response), "authentication_rejected");
  assert.equal(cancelled, 1);
  assert.equal(await readProviderFailure({ status: 401, body: { cancel() { throw new Error(PRIVATE); } } }), "authentication_rejected");
});

test("generic, malformed and unknown responses do not claim billing or authentication failures", async () => {
  const cases = [
    {}, null, [], PRIVATE,
    { error: PRIVATE }, { error: [] },
    { error: { code: PRIVATE, message: "credit_balance_exhausted" } },
    { error: { code: "slow_down" } },
    { error: { code: "rate_limit_exceeded", type: "rate_limit_error" } },
    { error: { code: "model_not_found" } },
    { error: { code: { code: "credit_balance_exhausted" } } },
  ];
  for (const body of cases) assert.equal(await readProviderFailure(jsonResponse(body)), "http_error");
  assert.equal(await readProviderFailure(jsonResponse({ error: { message: PRIVATE } }, 403)), "http_error");
  assert.equal(await readProviderFailure(new Response(`{${PRIVATE}`, { status: 429 })), "http_error");
  assert.equal(await readProviderFailure(new Response(new Uint8Array([0xff]), { status: 429 })), "http_error");
  assert.equal(await readProviderFailure({ status: 429, body: null }), "http_error");
  assert.equal(classifyProviderFailure(200, { error: { code: "credit_balance_exhausted" } }), "http_error");
});

test("streamed bodies are parsed within 16 KiB and oversized input is cancelled before parsing", async () => {
  const prefix = JSON.stringify({ error: { code: "credit_balance_exhausted", message: PRIVATE } });
  const exact = prefix + " ".repeat(MAX_ERROR_BYTES - encode(prefix).length);
  assert.equal(encode(exact).length, MAX_ERROR_BYTES);
  const chunks = [encode(exact.slice(0, 17)), encode(exact.slice(17, 88)), encode(exact.slice(88))];
  const accepted = new Response(new ReadableStream({
    start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); },
  }), { status: 429 });
  assert.equal(await readProviderFailure(accepted), "credit_exhausted");

  for (const maxBytes of [MAX_ERROR_BYTES, MAX_ERROR_BYTES * 10]) {
    let cancelled = 0, reads = 0;
    const oversized = { status: 429, body: { getReader: () => ({
      async read() { reads += 1; return { done: false, value: encode(exact + " ") }; },
      cancel() { cancelled += 1; }, releaseLock() {},
    }) } };
    assert.equal(await readProviderFailure(oversized, { maxBytes }), "http_error");
    assert.equal(reads, 1, "Stop before requesting another chunk after the bound is exceeded");
    assert.equal(cancelled, 1);
  }
  assert.equal(await readProviderFailure(jsonResponse({ error: { code: "credit_balance_exhausted" } }), { maxBytes: 8 }), "http_error");
});

test("bounds are in bytes and empty or invalid configured limits do not read upstream input", async () => {
  const unicode = JSON.stringify({ error: { code: "credit_balance_exhausted", message: "🙂".repeat(4200) } });
  assert.ok(unicode.length < MAX_ERROR_BYTES);
  assert.ok(encode(unicode).length > MAX_ERROR_BYTES);
  assert.equal(await readProviderFailure(new Response(unicode, { status: 429 })), "http_error");
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, "16384"]) {
    let cancelled = false;
    const response = { status: 429, body: {
      getReader() { assert.fail("Invalid bound must not read the stream"); },
      cancel() { cancelled = true; },
    } };
    assert.equal(await readProviderFailure(response, { maxBytes }), "http_error");
    assert.equal(cancelled, true);
  }
});

test("repeated empty chunks cannot bypass the reader bound or retain unbounded chunk metadata", async () => {
  let reads = 0, cancelled = false;
  const response = { status: 429, body: { getReader: () => ({
    async read() { reads += 1; return { done: false, value: new Uint8Array(0) }; },
    cancel() { cancelled = true; }, releaseLock() {},
  }) } };
  assert.equal(await readProviderFailure(response, { maxBytes: 32 }), "http_error");
  assert.equal(reads, 33);
  assert.equal(cancelled, true);

  const body = encode(JSON.stringify({ error: { code: "credit_balance_exhausted" } }));
  let index = 0;
  const oneByteChunks = { status: 429, body: { getReader: () => ({
    async read() { return index === body.length ? { done: true } : { done: false, value: body.subarray(index, ++index) }; },
    cancel() {}, releaseLock() {},
  }) } };
  assert.equal(await readProviderFailure(oneByteChunks, { maxBytes: body.length }), "credit_exhausted");
});

test("caller abort interrupts a stalled read even when cancellation never settles", async () => {
  const controller = new AbortController();
  let reading, cancelled = 0, released = 0;
  const started = new Promise((resolve) => { reading = resolve; });
  const response = { status: 429, body: { getReader: () => ({
    read() { reading(); return new Promise(() => {}); },
    cancel() { cancelled += 1; return new Promise(() => {}); },
    releaseLock() { released += 1; },
  }) } };
  const result = readProviderFailure(response, { signal: controller.signal });
  await started;
  controller.abort(new Error(PRIVATE));
  assert.equal(await result, "http_error");
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test("the supplied deadline bounds stalled bodies and pre-aborted signals do not begin reading", async () => {
  const signal = AbortSignal.timeout(10);
  let watchdog;
  const timedOut = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("Supplied deadline was ignored")), 1000); });
  try {
    const response = { status: 429, body: { getReader: () => ({
      read: () => new Promise(() => {}), cancel() {}, releaseLock() {},
    }) } };
    assert.equal(await Promise.race([readProviderFailure(response, { signal }), timedOut]), "http_error");
  } finally { clearTimeout(watchdog); }

  const controller = new AbortController();
  controller.abort(new Error(PRIVATE));
  let cancelled = false;
  assert.equal(await readProviderFailure({ status: 429, body: {
    getReader() { assert.fail("An already aborted request must not start reading"); },
    cancel() { cancelled = true; },
  } }, { signal: controller.signal }), "http_error");
  assert.equal(cancelled, true);
});

test("stream read and cancellation failures are contained without logging private errors", async (t) => {
  const logs = [];
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (...args) => logs.push(args));
  const response = { status: 429, body: { getReader: () => ({
    async read() { throw new Error(PRIVATE); },
    cancel() { return Promise.reject(new Error(PRIVATE)); }, releaseLock() {},
  }) } };
  assert.equal(await readProviderFailure(response), "http_error");
  assert.equal(await readProviderFailure({ status: 429, body: { getReader() { throw new Error(PRIVATE); } } }), "http_error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs, []);
});

test("failure latches are independent by static route and reset only through a new factory", () => {
  const failures = createProviderFailures();
  assert.equal(failures.get("fallback"), null);
  failures.block("fallback", "credit_exhausted");
  assert.equal(failures.get("fallback"), "credit_exhausted");
  assert.equal(failures.get("gemini"), null);
  assert.equal(failures.get("third"), null);
  failures.block("gemini", "authentication_rejected");
  failures.block("third", "quota_exhausted");
  assert.deepEqual(failures.entries(), [
    { route: "fallback", reason: "credit_exhausted" },
    { route: "gemini", reason: "authentication_rejected" },
    { route: "third", reason: "quota_exhausted" },
  ]);
  const snapshot = failures.entries();
  snapshot[0].reason = PRIVATE;
  assert.equal(failures.get("fallback"), "credit_exhausted");
  assert.equal(failures.reset, undefined);
  assert.deepEqual(createProviderFailures().entries(), []);
  assert.equal(failures.get("fallback"), "credit_exhausted", "A new factory does not reset an existing one");
});

test("only recognized permanent failures and route labels can be stored", () => {
  const failures = createProviderFailures();
  for (const route of [PRIVATE, `https://api.invalid/${PRIVATE}`, "", {}, null]) failures.block(route, "credit_exhausted");
  for (const reason of ["http_error", "timeout", "transport", PRIVATE, null, {}]) failures.block("fallback", reason);
  assert.deepEqual(failures.entries(), []);
  failures.block("fallback", "spend_limit_reached");
  failures.block("fallback", "http_error");
  assert.equal(failures.get("fallback"), "spend_limit_reached", "An unknown error must not clear a permanent block");
  assert.equal(JSON.stringify(failures.entries()).includes(PRIVATE), false);
});
