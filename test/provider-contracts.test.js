"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  checkProviderContracts,
  installedInterfaces,
} = require("../scripts/check-provider-contracts");
const {
  buildGeminiRequest,
  buildOpenAICompatibleRequest,
  validateProviderFixtures,
  validateProviderRequestFixtures,
} = require("../src/lib/provider-contracts");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("the pinned provider and SDK compatibility pack passes offline", async () => {
  const result = await checkProviderContracts();
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.schemaValid, true);
  assert.equal(result.compatibilityValid, true);
  assert.equal(result.productionCalls, 0);
  assert.equal(result.checkedPackageCount, 6);
  assert.ok(result.checkedInterfaceCount >= 10);
  assert.equal(result.checkedRequestCount, 2);
  assert.deepEqual(validateProviderFixtures(), []);
  assert.deepEqual(validateProviderRequestFixtures(), []);
});

test("the production request encoders produce the registered Gemini and OpenAI-compatible contracts", async () => {
  const calls = [];
  const captureFetch = async (request) => {
    calls.push({ url: request.url, body: JSON.parse(JSON.stringify(request.body)) });
    return new Response("{}", { status: 200 });
  };
  const gemini = buildGeminiRequest({
    model: "fixture-model",
    systemInstruction: "fixture policy",
    contents: [{ role: "user", parts: [{ text: "fixture question" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 16 },
    tools: [{ name: "fixture_tool", description: "fixture", parameters: {
      type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
    } }],
  });
  const fallback = buildOpenAICompatibleRequest({
    baseUrl: "https://fixture.invalid/v1/",
    model: "fixture-chat",
    body: { messages: [{ role: "user", content: "fixture question" }] },
  });
  await captureFetch(gemini);
  await captureFetch(fallback);

  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent");
  const declaration = calls[0].body.tools[0].functionDeclarations[0];
  assert.equal(declaration.parametersJsonSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(declaration, "parameters"), false);
  assert.equal(calls[0].body.system_instruction.parts[0].text, "fixture policy");
  assert.equal(calls[0].body.contents[0].parts[0].text, "fixture question");
  assert.equal(calls[1].url, "https://fixture.invalid/v1/chat/completions");
  assert.deepEqual(calls[1].body, {
    model: "fixture-chat",
    messages: [{ role: "user", content: "fixture question" }],
  });
});

test("an intentional provider API contract change exits nonzero and names the blocked interface", () => {
  const checker = require.resolve("../scripts/check-provider-contracts");
  const registerPath = require.resolve("../config/provider-contracts.v1.json");
  const program = `
    const { checkProviderContracts } = require(${JSON.stringify(checker)});
    const register = JSON.parse(JSON.stringify(require(${JSON.stringify(registerPath)})));
    register.providers.gemini.apiVersion = "v2-unreviewed";
    checkProviderContracts({ register }).then((result) => {
      process.stdout.write(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    });
  `;
  const run = spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, "");
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.service === "gemini" &&
    error.interface === "apiVersion" && error.code === "UNSUPPORTED_PROVIDER_CONTRACT"));
  assert.equal(result.productionCalls, 0);
  assert.equal(result.checkedRequestCount, 2);
});

test("a removed installed SDK method blocks compatibility before dispatch", async () => {
  const interfaces = await installedInterfaces();
  const changed = clone(interfaces);
  changed.langsmith["Client.createRun"] = false;
  const result = await checkProviderContracts({ interfaces: changed });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.service === "langsmith" &&
    error.interface === "Client.createRun" && error.code === "REQUIRED_INTERFACE_MISSING"));
  assert.equal(result.productionCalls, 0);
});

test("declared or locked SDK version drift blocks compatibility", async () => {
  const packageJson = clone(require("../package.json"));
  const packageLock = clone(require("../package-lock.json"));
  packageJson.devDependencies.langsmith = "0.10.5";
  packageLock.packages["node_modules/langsmith"].version = "0.10.5";
  const result = await checkProviderContracts({ packageJson, packageLock });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.interface === "package:langsmith" &&
    error.code === "PACKAGE_VERSION_MISMATCH"));
});

test("the CLI emits one safe result and makes no production call", () => {
  const run = spawnSync(process.execPath, [require.resolve("../scripts/check-provider-contracts")], {
    encoding: "utf8",
    env: { ...process.env, GEMINI_API_KEY: "must-not-be-used", FALLBACK_API_KEY: "must-not-be-used" },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.stderr, "");
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.productionCalls, 0);
  assert.equal(run.stdout.includes("must-not-be-used"), false);
});
