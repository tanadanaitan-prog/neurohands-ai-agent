"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const REQUIRED_FLAGS = Object.freeze([
  "--permission",
  "--no-addons",
  "--disable-proto",
  "--frozen-intrinsics",
]);
const MAX_SOURCE_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SECRET_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key|access[_-]?token)/i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{12,}|\bsb_secret_[A-Za-z0-9_-]{12,}|Bearer\s+\S+|\blsv2_[A-Za-z0-9_-]{12,})/i;
const PERMISSION_KEYS = Object.freeze([
  "filesystemReadDenied",
  "filesystemWriteDenied",
  "childProcessDenied",
  "workerDenied",
  "nativeAddonsDenied",
]);
const ENFORCEMENT_KEYS = Object.freeze([
  "secretFileReadDenied",
  "artifactWriteDenied",
  "childProcessStartDenied",
]);
const ATTEMPT_KEYS = Object.freeze([
  "environmentEnumeration",
  "moduleLoading",
  "secretFileRead",
  "directNetwork",
  "socketNetwork",
  "networkMetadata",
  "productionTools",
  "globalConstructorEscape",
  "objectConstructorEscape",
  "fetchConstructorEscape",
  "toolsConstructorEscape",
]);

// This intentionally adversarial source is fixed and reviewed. It is not a
// general arbitrary-code service. A hosted CI/container boundary remains
// necessary before executing untrusted pull-request code.
const ADVERSARIAL_PROBE = String.raw`
(() => {
  "use strict";
  const blocked = (fn) => {
    try { fn(); return false; } catch { return true; }
  };
  return Object.freeze({
    environmentEnumeration: blocked(() => Object.keys(process.env)),
    moduleLoading: blocked(() => require("node:fs")),
    secretFileRead: blocked(() => require("node:fs").readFileSync(".env", "utf8")),
    directNetwork: blocked(() => fetch("http://169.254.169.254/latest/meta-data")),
    socketNetwork: blocked(() => require("node:net").connect(443, "example.invalid")),
    networkMetadata: blocked(() => require("node:os").networkInterfaces()),
    productionTools: blocked(() => tools.deployProduction()),
    globalConstructorEscape: blocked(() => globalThis.constructor.constructor("return process")()),
    objectConstructorEscape: blocked(() => ({}).constructor.constructor("return process")()),
    fetchConstructorEscape: blocked(() => fetch.constructor("return process")()),
    toolsConstructorEscape: blocked(() => tools.constructor.constructor("return process")()),
  });
})()
`;

const WORKER_SOURCE = String.raw`
"use strict";
const vm = require("node:vm");
const fs = require("node:fs");
const childProcess = require("node:child_process");

const safe = (value) => process.stdout.write(JSON.stringify(value));
const fail = (code) => { safe({ schemaVersion: 1, ok: false, code }); process.exitCode = 1; };
const unsafeKey = /(?:authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key|access[_-]?token)/i;
const unsafeValue = /(?:\bsk-[A-Za-z0-9_-]{12,}|\bsb_secret_[A-Za-z0-9_-]{12,}|Bearer\s+\S+|\blsv2_[A-Za-z0-9_-]{12,})/i;

const originalEntries = Object.entries(process.env);
if (originalEntries.some(([key, value]) => unsafeKey.test(key) || unsafeValue.test(String(value)))) {
  fail("UNSAFE_BOOTSTRAP_ENVIRONMENT");
} else {
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.NEUROHANDS_UNTRUSTED_EXECUTION = "1";

  const permission = (scope) => process.permission && process.permission.has(scope) === false;
  const permissionState = {
    filesystemReadDenied: permission("fs.read"),
    filesystemWriteDenied: permission("fs.write"),
    childProcessDenied: permission("child"),
    workerDenied: permission("worker"),
    nativeAddonsDenied: permission("addons"),
  };
  const attempt = (fn) => {
    try { fn(); return false; }
    catch (error) { return error && error.code === "ERR_ACCESS_DENIED"; }
  };
  const enforcement = {
    secretFileReadDenied: attempt(() => fs.readFileSync(".env", "utf8")),
    artifactWriteDenied: attempt(() => fs.writeFileSync("untrusted-artifact.txt", "forbidden")),
    childProcessStartDenied: attempt(() => childProcess.spawnSync(process.execPath, ["--version"])),
  };

  let source;
  try {
    source = Buffer.from(process.argv[1] || "", "base64url").toString("utf8");
  } catch {
    source = "";
  }
  if (!source || Buffer.byteLength(source, "utf8") > ${MAX_SOURCE_BYTES}) {
    fail("INVALID_PROBE_SOURCE");
  } else if (!Object.values(permissionState).every(Boolean) || !Object.values(enforcement).every(Boolean)) {
    fail("PERMISSION_ENFORCEMENT_UNAVAILABLE");
  } else {
    try {
      const sandbox = Object.create(null);
      const context = vm.createContext(sandbox, {
        name: "neurohands-untrusted-probe",
        codeGeneration: { strings: false, wasm: false },
      });
      const script = new vm.Script(source, { filename: "untrusted-probe.js" });
      const attempts = script.runInContext(context, { timeout: 250, breakOnSigint: true });
      const expected = [
        "environmentEnumeration", "moduleLoading", "secretFileRead", "directNetwork",
        "socketNetwork", "networkMetadata", "productionTools", "globalConstructorEscape",
        "objectConstructorEscape", "fetchConstructorEscape", "toolsConstructorEscape",
      ];
      const valid = attempts && typeof attempts === "object" &&
        expected.every((name) => attempts[name] === true) &&
        Object.keys(attempts).length === expected.length;
      if (!valid) fail("CAPABILITY_EXPOSURE_DETECTED");
      else safe({
        schemaVersion: 1,
        ok: true,
        code: "BOUNDARY_PROBE_PASSED",
        environment: { allowlisted: Object.keys(process.env).length === 1 },
        network: {
          scope: "application_capabilities",
          transport: "absent",
          attemptedPaths: 3,
          osNetworkIsolated: false,
        },
        permissions: permissionState,
        enforcement,
        attempts,
      });
    } catch {
      fail("PROBE_EXECUTION_FAILED");
    }
  }
}
`;

function boundarySupport({
  allowedFlags = process.allowedNodeEnvironmentFlags,
  nodeVersion = process.versions.node,
  platform = process.platform,
} = {}) {
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  const flagsReady = allowedFlags && typeof allowedFlags.has === "function" &&
    REQUIRED_FLAGS.every((flag) => allowedFlags.has(flag));
  const platformReady = ["win32", "linux", "darwin"].includes(platform);
  return Object.freeze({
    supported: Number.isSafeInteger(major) && major >= 22 && flagsReady && platformReady,
    nodeMajor: Number.isSafeInteger(major) ? major : null,
    platform: platformReady ? platform : "unsupported",
    permissionFlagsAvailable: Boolean(flagsReady),
  });
}

function childEnvironment(cwd) {
  if (process.platform === "win32") {
    const root = path.parse(cwd).root || "C:\\";
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || `${root}Windows`;
    return {
      NEUROHANDS_UNTRUSTED_EXECUTION: "1",
      NODE_OPTIONS: "",
      NODE_PATH: "",
      PATH: "",
      SystemRoot: systemRoot,
      SYSTEMROOT: systemRoot,
      windir: systemRoot,
      WINDIR: systemRoot,
      TEMP: cwd,
      TMP: cwd,
      USERPROFILE: cwd,
      HOMEDRIVE: root.replace(/\\$/, ""),
      HOMEPATH: "\\",
      USERNAME: "untrusted",
      USERDOMAIN: "untrusted",
      LOGONSERVER: "",
    };
  }
  return {
    NEUROHANDS_UNTRUSTED_EXECUTION: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    PATH: "",
    HOME: cwd,
    TMPDIR: cwd,
    LANG: "C",
    TZ: "UTC",
  };
}

function rejected(code, detail = {}) {
  return Object.freeze({
    ok: false,
    code,
    spawned: false,
    ...detail,
  });
}

function containsSentinel(value, sentinels) {
  return sentinels.some((sentinel) => typeof sentinel === "string" && sentinel && value.includes(sentinel));
}

function exactTrueFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => value[field] === true);
}

function runUntrustedBoundaryProbe({
  cwd,
  requestedEnvironment = {},
  forbiddenSentinels = [],
} = {}) {
  const support = boundarySupport();
  if (!support.supported) return rejected("BOUNDARY_UNSUPPORTED", { support });
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return rejected("BOUNDARY_WORKDIR_REQUIRED");
  if (!requestedEnvironment || typeof requestedEnvironment !== "object" || Array.isArray(requestedEnvironment)) {
    return rejected("UNTRUSTED_ENVIRONMENT_REJECTED", { rejectedCount: 1 });
  }
  const requested = Object.entries(requestedEnvironment);
  if (requested.length > 0 || requested.some(([key, value]) =>
    SECRET_KEY.test(key) || SECRET_VALUE.test(String(value)))) {
    return rejected("UNTRUSTED_ENVIRONMENT_REJECTED", { rejectedCount: requested.length });
  }
  if (!Array.isArray(forbiddenSentinels) || forbiddenSentinels.some((value) => typeof value !== "string")) {
    return rejected("INVALID_SENTINEL_POLICY");
  }
  const encodedProbe = Buffer.from(ADVERSARIAL_PROBE, "utf8").toString("base64url");
  let child;
  try {
    child = spawnSync(process.execPath, [
      "--permission",
      "--no-addons",
      "--disable-proto=throw",
      "--frozen-intrinsics",
      "--no-warnings",
      "--max-old-space-size=64",
      "--eval",
      WORKER_SOURCE,
      encodedProbe,
    ], {
      cwd,
      env: childEnvironment(cwd),
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return rejected("BOUNDARY_START_FAILED");
  }

  const stdout = typeof child?.stdout === "string" ? child.stdout : "";
  const stderr = typeof child?.stderr === "string" ? child.stderr : "";
  if (containsSentinel(stdout, forbiddenSentinels) || containsSentinel(stderr, forbiddenSentinels)) {
    return Object.freeze({ ok: false, code: "PROHIBITED_OUTPUT_DETECTED", spawned: true });
  }
  if (child?.error || child?.signal || child?.status !== 0 || stderr || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    return Object.freeze({ ok: false, code: "BOUNDARY_CHILD_FAILED", spawned: true });
  }
  let report;
  try { report = JSON.parse(stdout); }
  catch { return Object.freeze({ ok: false, code: "BOUNDARY_REPORT_INVALID", spawned: true }); }
  const valid = report && typeof report === "object" && !Array.isArray(report) &&
    Object.keys(report).length === 8 && report?.schemaVersion === 1 && report?.ok === true &&
    report?.code === "BOUNDARY_PROBE_PASSED" && report?.environment?.allowlisted === true &&
    Object.keys(report.environment).length === 1 &&
    report?.network?.scope === "application_capabilities" &&
    report?.network?.transport === "absent" && report?.network?.attemptedPaths === 3 &&
    report?.network?.osNetworkIsolated === false && Object.keys(report.network).length === 4 &&
    exactTrueFields(report.permissions, PERMISSION_KEYS) &&
    exactTrueFields(report.enforcement, ENFORCEMENT_KEYS) &&
    exactTrueFields(report.attempts, ATTEMPT_KEYS);
  if (!valid) return Object.freeze({ ok: false, code: "BOUNDARY_REPORT_REJECTED", spawned: true });
  return Object.freeze({
    ok: true,
    code: "BOUNDARY_PROBE_PASSED",
    spawned: true,
    environment: Object.freeze({ allowlisted: true }),
    network: Object.freeze({
      scope: "application_capabilities",
      transport: "absent",
      attemptedPaths: 3,
      osNetworkIsolated: false,
    }),
    permissions: Object.freeze({ ...report.permissions }),
    enforcement: Object.freeze({ ...report.enforcement }),
    attempts: Object.freeze({ ...report.attempts }),
  });
}

module.exports = {
  ADVERSARIAL_PROBE,
  REQUIRED_FLAGS,
  boundarySupport,
  runUntrustedBoundaryProbe,
};
