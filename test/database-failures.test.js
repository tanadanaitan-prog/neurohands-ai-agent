const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DATABASE_FAILURES,
  classifyDatabaseFailure,
  readDatabaseFailure,
  databaseOperationError,
  databaseFailureCode,
} = require("../src/lib/database-failures");

test("database failures use bounded fixed classifications", async (t) => {
  const cases = [
    [503, { code: "25006", message: "private read-only detail" }, DATABASE_FAILURES.READ_ONLY],
    [503, { code: "53300", message: "private connection detail" }, DATABASE_FAILURES.CONNECTION_EXHAUSTED],
    [504, { code: "PGRST003", message: "private pool detail" }, DATABASE_FAILURES.CONNECTION_EXHAUSTED],
    [503, { code: "PGRST000", message: "private host detail" }, DATABASE_FAILURES.UNAVAILABLE],
    [503, { code: "57P03", message: "private restart detail" }, DATABASE_FAILURES.UNAVAILABLE],
    [503, { code: "57014", message: "private query detail" }, DATABASE_FAILURES.TIMEOUT],
    [504, null, DATABASE_FAILURES.TIMEOUT],
    [500, { code: "private-unknown", message: "private body" }, DATABASE_FAILURES.REQUEST_FAILED],
  ];
  for (const [status, payload, expected] of cases) {
    await t.test(`${status} ${payload?.code || "no-body"}`, async () => {
      assert.equal(classifyDatabaseFailure(status, payload), expected);
      const response = new Response(payload ? JSON.stringify(payload) : null, { status });
      assert.equal(await readDatabaseFailure(response), expected);
    });
  }
});

test("database failure reading is byte bounded, abortable, and never returns upstream text", async () => {
  const secret = "PRIVATE-DATABASE-SENTINEL";
  const oversized = new Response(JSON.stringify({ code: "25006", message: secret.repeat(1000) }), { status: 503 });
  assert.equal(await readDatabaseFailure(oversized, { maxBytes: 32 }), DATABASE_FAILURES.REQUEST_FAILED);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await readDatabaseFailure(new Response(JSON.stringify({ code: "25006" }), { status: 503 }), {
    signal: controller.signal,
  }), DATABASE_FAILURES.TIMEOUT);
  const error = databaseOperationError(DATABASE_FAILURES.READ_ONLY);
  assert.equal(error.message, "Database operation failed");
  assert.equal(error.message.includes(secret), false);
  assert.equal(databaseFailureCode(error), DATABASE_FAILURES.READ_ONLY);
  assert.equal(databaseFailureCode(new Error(secret)), null);
});
