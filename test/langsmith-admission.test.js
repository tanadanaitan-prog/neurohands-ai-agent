"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

test("explicit LangSmith trace stops before upload while private allowance is unresolved", () => {
  const privateFixture = "lsv2_test-only-not-a-real-key";
  const child = spawnSync(process.execPath, [require.resolve("../scripts/langgraph-lab.mjs"), "trace"], {
    env: { ...process.env, LANGSMITH_API_KEY: privateFixture },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /Software Passport admission: ALLOWANCE_UNKNOWN/);
  assert.equal(child.stderr.includes(privateFixture), false);
});
