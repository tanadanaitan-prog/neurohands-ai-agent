"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  validateContractRegister,
  validateProviderFixtures,
  validateProviderRequestFixtures,
} = require("../src/lib/provider-contracts");

const ROOT = path.resolve(__dirname, "..");
const REGISTER_PATH = path.join(ROOT, "config", "provider-contracts.v1.json");

const REQUIRED_INTERFACES = Object.freeze({
  langsmith: Object.freeze(["Client", "Client.createRun", "Client.readProject", "Client.runs.retrieve"]),
  langgraph: Object.freeze(["StateGraph", "StateSchema", "MessagesValue", "START", "END"]),
  langchainCore: Object.freeze(["AIMessage", "HumanMessage", "SystemMessage", "ToolMessage"]),
  ollama: Object.freeze(["ChatOllama"]),
  supabase: Object.freeze(["createClient"]),
  langgraphCli: Object.freeze(["bin.langgraphjs"]),
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeError(service, iface, code) {
  return Object.freeze({ service, interface: iface, code });
}

async function installedInterfaces(rootDir = ROOT) {
  const result = {};
  try {
    const module = await import("langsmith");
    const runsModule = await import(pathToFileURL(path.join(
      rootDir, "node_modules", "langsmith", "dist", "_openapi_client", "resources", "runs", "runs.js"
    )).href);
    const runsGetter = Object.getOwnPropertyDescriptor(module.Client?.prototype || {}, "runs")?.get;
    const runsResource = typeof runsModule.Runs === "function" ? new runsModule.Runs({}) : null;
    result.langsmith = {
      Client: typeof module.Client === "function",
      "Client.createRun": typeof module.Client?.prototype?.createRun === "function",
      "Client.readProject": typeof module.Client?.prototype?.readProject === "function",
      "Client.runs.retrieve": typeof runsGetter === "function" && typeof runsResource?.retrieve === "function",
    };
  } catch {
    result.langsmith = {};
  }
  try {
    const module = await import("@langchain/langgraph");
    result.langgraph = Object.fromEntries(REQUIRED_INTERFACES.langgraph.map((name) => [name, module[name] !== undefined]));
  } catch {
    result.langgraph = {};
  }
  try {
    const module = await import("@langchain/core/messages");
    result.langchainCore = Object.fromEntries(REQUIRED_INTERFACES.langchainCore.map((name) => [name, typeof module[name] === "function"]));
  } catch {
    result.langchainCore = {};
  }
  try {
    const module = await import("@langchain/ollama");
    result.ollama = { ChatOllama: typeof module.ChatOllama === "function" };
  } catch {
    result.ollama = {};
  }
  try {
    const module = require("@supabase/supabase-js");
    result.supabase = { createClient: typeof module.createClient === "function" };
  } catch {
    result.supabase = {};
  }
  try {
    const manifest = readJson(path.join(rootDir, "node_modules", "@langchain", "langgraph-cli", "package.json"));
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.langgraphjs;
    result.langgraphCli = { "bin.langgraphjs": typeof entry === "string" && fs.existsSync(path.join(rootDir, "node_modules", "@langchain", "langgraph-cli", entry)) };
  } catch {
    result.langgraphCli = {};
  }
  return result;
}

function evaluateContracts({ register, packageJson, packageLock, interfaces }) {
  const errors = [
    ...validateContractRegister(register),
    ...validateProviderFixtures(),
    ...validateProviderRequestFixtures(),
  ];
  const rootLock = packageLock?.packages?.[""];
  for (const [name, expected] of Object.entries(register?.packages || {})) {
    const declared = packageJson?.dependencies?.[name] ?? packageJson?.devDependencies?.[name];
    const lockedDeclaration = rootLock?.dependencies?.[name] ?? rootLock?.devDependencies?.[name];
    const installed = packageLock?.packages?.[`node_modules/${name}`]?.version;
    if (declared !== expected || lockedDeclaration !== expected || installed !== expected) {
      errors.push(safeError("node", `package:${name}`, "PACKAGE_VERSION_MISMATCH"));
    }
  }
  for (const [service, names] of Object.entries(REQUIRED_INTERFACES)) {
    for (const name of names) {
      if (interfaces?.[service]?.[name] !== true) {
        errors.push(safeError(service, name, "REQUIRED_INTERFACE_MISSING"));
      }
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    schemaValid: validateContractRegister(register).length === 0,
    compatibilityValid: errors.length === 0,
    productionCalls: 0,
    checkedPackageCount: Object.keys(register?.packages || {}).length,
    checkedInterfaceCount: Object.values(REQUIRED_INTERFACES).reduce((sum, values) => sum + values.length, 0),
    checkedRequestCount: 2,
    errors,
  });
}

async function checkProviderContracts({
  rootDir = ROOT,
  register = null,
  packageJson = null,
  packageLock = null,
  interfaces = null,
} = {}) {
  try {
    const loadedRegister = register || readJson(path.join(rootDir, "config", "provider-contracts.v1.json"));
    return evaluateContracts({
      register: loadedRegister,
      packageJson: packageJson || readJson(path.join(rootDir, "package.json")),
      packageLock: packageLock || readJson(path.join(rootDir, "package-lock.json")),
      interfaces: interfaces || await installedInterfaces(rootDir),
    });
  } catch {
    return Object.freeze({
      ok: false,
      schemaValid: false,
      compatibilityValid: false,
      productionCalls: 0,
      checkedPackageCount: 0,
      checkedInterfaceCount: 0,
      checkedRequestCount: 0,
      errors: [safeError("registry", "load", "CONTRACT_CHECK_UNAVAILABLE")],
    });
  }
}

if (require.main === module) {
  checkProviderContracts().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  });
}

module.exports = {
  REGISTER_PATH,
  REQUIRED_INTERFACES,
  checkProviderContracts,
  evaluateContracts,
  installedInterfaces,
};
