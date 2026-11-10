const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

for (const runnerFails of [false, true]) for (const checkingFails of [false, true]) {
  test(`LA04-R2 deferred Checking settles before ${runnerFails ? "terminal" : "final"} push; checking fails=${checkingFails}`, async () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
    const start = source.indexOf("async function respondAgentWithRace(");
    const end = source.indexOf("\nasync function handleMessage(", start);
    assert.ok(start > 0 && end > start);
    let timer, settleRunner, settleChecking, replyAttempts = 0;
    const delivered = [];
    const runner = new Promise((resolve, reject) => {
      settleRunner = () => runnerFails ? reject(new Error("synthetic runner failure")) : resolve("Final result");
    });
    const context = {
      runAgent: () => runner,
      setTimeout(callback) { timer = callback; return 1; }, clearTimeout() {},
      replyToLine(_token, text) {
        replyAttempts++;
        return new Promise((resolve, reject) => { settleChecking = () => {
          if (checkingFails) reject(new Error("synthetic checking failure"));
          else { delivered.push(text); resolve(true); }
        }; });
      },
      async pushToLine(_user, text) { delivered.push(text); return true; },
      async logMessage() {}, async db() { throw new Error("Unexpected database call"); },
      databaseFailureCode() { return null; },
      C06_DATABASE_DEGRADED_RESPONSE: "Terminal failure", console: { error() {} },
    };
    vm.runInNewContext(source.slice(start, end) + "\nthis.respond = respondAgentWithRace;", context);
    const pending = context.respond({ replyToken: "synthetic-token", source: { userId: "synthetic-user" } }, {}, "Question", {});
    // Attach immediately so the deliberately rejected runner remains observed.
    const outcome = pending.then(() => null, error => error);
    const checking = timer();
    settleRunner();
    await new Promise(setImmediate);
    const premature = [...delivered];
    settleChecking();
    await checking;
    const error = await outcome;
    assert.deepEqual(premature, [], "Final/terminal send must await the pending Checking request");
    assert.equal(replyAttempts, 1, "Never retry an uncertain Checking send");
    assert.deepEqual(delivered, [...(checkingFails ? [] : ["⏳ Checking..."]), runnerFails ? "Terminal failure" : "Final result"]);
    if (runnerFails) assert.match(error?.message || "", /synthetic runner failure/);
    else assert.equal(error, null);
  });
}
