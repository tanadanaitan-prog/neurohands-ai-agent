"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");

// DRAFT: Backend must separately approve/pin this SDK in package.json/lockfile.
// No dependency changes, automatic console capture, or message-handler changes here.
const SDK_VERSION = "11.6.0";
const SERVER_FILE = path.resolve(__dirname, "../server.js");
const SUMMARY = "Neurohands Express error; private details withheld";

// A positive schema, not a list of sensitive key names: arbitrary text can also
// appear in error messages, stack source, tags, URLs, breadcrumbs and future fields.
// Retain only fixed labels and bounded line/column numbers for this source file.
function beforeSend(event, hint) {
  try {
    if (!event || typeof event !== "object" || (event.type && event.type !== "error")) return null;
    if (hint) hint.attachments = [];
    const frames = [];
    const inputFrames = event.exception?.values?.[0]?.stacktrace?.frames;
    if (Array.isArray(inputFrames)) {
      for (const frame of inputFrames.slice(-30)) {
        if (!frame) continue;
        // Snapshot once: getters must not change a value after it is checked.
        const { filename, lineno, colno } = frame;
        if (![SERVER_FILE, "src/server.js"].includes(filename)) continue;
        if (!Number.isSafeInteger(lineno) || lineno < 1 || lineno > 100000) continue;
        const safe = { filename: "src/server.js", lineno, in_app: true };
        if (Number.isSafeInteger(colno) && colno >= 0 && colno <= 10000) safe.colno = colno;
        frames.push(safe);
      }
    }
    const exception = { type: "NeurohandsExpressError", value: SUMMARY };
    if (frames.length) exception.stacktrace = { frames };
    return {
      // Never copy a caller-supplied event ID, which could itself be a reply token.
      event_id: randomUUID().replaceAll("-", ""),
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      exception: { values: [exception] },
      tags: { privacy_filter: "allowlist-v1" },
    };
  } catch {
    // Unreadable properties or unexpected input must drop telemetry, not leak it.
    return null;
  }
}

// beforeSend does not cover every Sentry envelope item (e.g. attachments/logs).
// Rebuild the wire envelope too, dropping non-error items and SDK-added metadata.
function privacyTransport(transport) {
  return {
    send(envelope) {
      try {
        if (!Array.isArray(envelope?.[1])) return Promise.resolve({});
        const item = envelope[1].find((entry) => entry?.[0]?.type === "event");
        if (!item) return Promise.resolve({});
        const safe = beforeSend(item[1]);
        if (!safe) return Promise.resolve({});
        return Promise.resolve(transport.send([
          { event_id: safe.event_id, sent_at: new Date().toISOString() },
          [[{ type: "event" }, safe]],
        ])).catch(() => ({}));
      } catch {
        return Promise.resolve({});
      }
    },
    flush(timeout) {
      try { return Promise.resolve(transport.flush(timeout)).catch(() => false); }
      catch { return Promise.resolve(false); }
    },
  };
}

function disabled(status) {
  return {
    enabled: false, status,
    middleware(error, _req, _res, next) { next(error); },
    flush: async () => true,
    close: async () => true,
  };
}

function createSentry({ env = process.env, loadSdk = () => require("@sentry/node"), makeTransport } = {}) {
  const dsn = env.SENTRY_DSN;
  if (typeof dsn !== "string" || !dsn.trim()) return disabled("disabled_no_dsn");
  let sdk;
  try { sdk = loadSdk(); }
  catch { return disabled("disabled_sdk_unavailable"); }
  // Re-qualify the transport test before changing this explicitly tested version.
  if (sdk.SDK_VERSION !== SDK_VERSION) return disabled("disabled_sdk_version");
  let client;
  try {
    client = new sdk.NodeClient({
      dsn,
      debug: false,
      integrations: [],
      defaultIntegrations: false,
      stackParser: sdk.defaultStackParser,
      transport: (options) => privacyTransport((makeTransport || sdk.makeNodeTransport)(options)),
      beforeSend,
      beforeBreadcrumb: () => null,
      beforeSendTransaction: () => null,
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
      dataCollection: {
        userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
        urlQueryParams: false, graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false }, databaseQueryData: false,
        queues: false, stackFrameVariables: false, frameContextLines: 0,
      },
      sendClientReports: false,
      enableLogs: false,
      enableMetrics: false,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      profileSessionSampleRate: 0,
      tracePropagationTargets: [],
      includeServerName: false,
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
    });
    client.init();
    // This client is not installed as the global Sentry client. No request object
    // or global console/error hooks are attached. The transport is its final gate.
    const scope = new sdk.Scope();
    scope.setClient(client);
    return {
      enabled: true, status: "configured",
      middleware(error, _req, _res, next) {
        try { scope.captureException(error); } catch { /* Telemetry cannot break a reply. */ }
        next(error);
      },
      flush: (timeout = 2000) => client.flush(timeout),
      close: (timeout = 2000) => client.close(timeout),
    };
  } catch {
    try { Promise.resolve(client?.close(0)).catch(() => {}); } catch { /* No logging. */ }
    return disabled("disabled_sdk_initialization");
  }
}

module.exports = { beforeSend, privacyTransport, createSentry };
