"use strict";

const { createHash } = require("node:crypto");
const { parseDocument } = require("./document-parser");

const FORMAT = "neurohands-isolated-recovery/v1";
const TABLES = Object.freeze([
  "client_accounts",
  "client_agent_bindings",
  "client_documents",
  "agent_runs",
  "tool_calls",
  "jarvis_audit_log",
]);
const SAFE_ID = /^[1-9][0-9]*$/;
const CLIENT_CODE = /^[A-Z0-9_-]{2,24}$/;
const ACTOR_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const DEPARTMENT = /^[a-z][a-z0-9_-]{1,39}$/;
const DOC_CODE = /^[A-Za-z0-9_-]{2,160}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/;

class RecoveryProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryProofError";
    this.code = code;
  }
}

function fail(code) {
  throw new RecoveryProofError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("BACKUP_RECORD_INVALID");
    seen.add(value);
    const result = `[${value.map((item) => canonical(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value) || seen.has(value)) fail("BACKUP_RECORD_INVALID");
  seen.add(value);
  const result = `{${Object.keys(value).sort().map((key) => {
    if (typeof value[key] === "undefined") fail("BACKUP_RECORD_INVALID");
    return `${JSON.stringify(key)}:${canonical(value[key], seen)}`;
  }).join(",")}}`;
  seen.delete(value);
  return result;
}

function cloneJson(value) {
  return JSON.parse(canonical(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function sameId(left, right) {
  return SAFE_ID.test(String(left)) && String(left) === String(right);
}

function validObjectPath(value) {
  return typeof value === "string" && OBJECT_PATH.test(value) && value.includes("/") &&
    !value.includes("//") && !value.endsWith("/");
}

function validScopedObjectPath(value, clientCode) {
  return validObjectPath(value) && value.startsWith(`${clientCode}/`);
}

function validateScope(value) {
  if (!isPlainObject(value) || !SAFE_ID.test(String(value.clientAccountId)) ||
      typeof value.clientCode !== "string" || !CLIENT_CODE.test(value.clientCode)) {
    fail("BACKUP_SCOPE_INVALID");
  }
  return Object.freeze({ clientAccountId: String(value.clientAccountId), clientCode: value.clientCode });
}

function validateRecordSet(rawRecords, rawScope) {
  const scope = validateScope(rawScope);
  if (!isPlainObject(rawRecords) || Object.keys(rawRecords).length !== TABLES.length ||
      TABLES.some((table) => !Array.isArray(rawRecords[table]))) {
    fail("BACKUP_RECORD_SET_INVALID");
  }
  if (Object.keys(rawRecords).some((table) => !TABLES.includes(table))) fail("BACKUP_RECORD_SET_INVALID");

  const records = Object.fromEntries(TABLES.map((table) => [table, rawRecords[table].map(cloneJson)]));
  for (const table of TABLES) {
    const identities = new Set();
    for (const row of records[table]) {
      if (!isPlainObject(row) || !SAFE_ID.test(String(row.id)) || identities.has(String(row.id))) {
        fail("BACKUP_RECORD_ID_INVALID");
      }
      identities.add(String(row.id));
    }
    records[table].sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0);
  }

  const accounts = records.client_accounts;
  if (accounts.length !== 1 || !sameId(accounts[0].id, scope.clientAccountId) ||
      accounts[0].client_code !== scope.clientCode) {
    fail("BACKUP_SCOPE_MISMATCH");
  }
  const scopedTables = ["client_agent_bindings", "client_documents", "agent_runs"];
  if (scopedTables.some((table) => records[table].some((row) => !sameId(row.client_account_id, scope.clientAccountId)))) {
    fail("BACKUP_SCOPE_MISMATCH");
  }
  if (records.client_agent_bindings.length === 0 || records.client_documents.length === 0 ||
      records.agent_runs.length === 0 || records.tool_calls.length === 0 || records.jarvis_audit_log.length === 0) {
    fail("BACKUP_EVIDENCE_INCOMPLETE");
  }

  const actors = new Set();
  for (const row of records.client_agent_bindings) {
    if (typeof row.line_user_id !== "string" || !ACTOR_ID.test(row.line_user_id)) fail("BACKUP_RECORD_INVALID");
    actors.add(row.line_user_id);
  }
  const runIds = new Set(records.agent_runs.map((row) => String(row.id)));
  if (records.agent_runs.some((row) => !actors.has(row.line_user_id)) ||
      records.tool_calls.some((row) => !runIds.has(String(row.run_id)))) {
    fail("BACKUP_SCOPE_MISMATCH");
  }
  for (const row of records.jarvis_audit_log) {
    if (!actors.has(row.line_user_id)) fail("BACKUP_SCOPE_MISMATCH");
    if (typeof row.detail !== "string") fail("BACKUP_AUDIT_SCOPE_INVALID");
    let detail;
    try { detail = JSON.parse(row.detail); } catch { fail("BACKUP_AUDIT_SCOPE_INVALID"); }
    const auditScope = detail?.scope;
    if (!isPlainObject(detail) || !isPlainObject(auditScope) ||
        typeof auditScope.clientAccountId !== "string" || !SAFE_ID.test(auditScope.clientAccountId) ||
        typeof auditScope.clientCode !== "string" || !CLIENT_CODE.test(auditScope.clientCode)) {
      fail("BACKUP_AUDIT_SCOPE_INVALID");
    }
    if (!sameId(auditScope.clientAccountId, scope.clientAccountId) || auditScope.clientCode !== scope.clientCode) {
      fail("BACKUP_SCOPE_MISMATCH");
    }
  }

  const paths = new Set();
  for (const row of records.client_documents) {
    const source = row.parsed_summary?.source;
    if (validObjectPath(row.storage_path) && !validScopedObjectPath(row.storage_path, scope.clientCode)) {
      fail("BACKUP_SCOPE_MISMATCH");
    }
    if (typeof row.doc_code !== "string" || !DOC_CODE.test(row.doc_code) ||
        !validScopedObjectPath(row.storage_path, scope.clientCode) ||
        paths.has(row.storage_path) || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 1 ||
        !isPlainObject(source) || !SHA256.test(source.sha256) || Number(source.size_bytes) !== Number(row.size_bytes)) {
      fail("BACKUP_DOCUMENT_METADATA_INVALID");
    }
    paths.add(row.storage_path);
  }
  return { scope, records: deepFreeze(records) };
}

function recordManifest(records) {
  return TABLES.flatMap((table) => records[table].map((row) => Object.freeze({
    table,
    id: String(row.id),
    sha256: sha256(canonical(row)),
  })));
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("BACKUP_OBJECT_ENCODING_INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("BACKUP_OBJECT_ENCODING_INVALID");
  return bytes;
}

function buildManifest(scope, records, objectData) {
  const recordEntries = recordManifest(records);
  const objectEntries = Object.keys(objectData).sort().map((path) => {
    if (!validObjectPath(path)) fail("BACKUP_OBJECT_PATH_INVALID");
    if (!validScopedObjectPath(path, scope.clientCode)) fail("BACKUP_SCOPE_MISMATCH");
    const bytes = decodeBase64(objectData[path]);
    return Object.freeze({ path, byteLength: bytes.length, sha256: sha256(bytes) });
  });
  const content = {
    format: FORMAT,
    scope,
    recordCount: recordEntries.length,
    records: recordEntries,
    objectCount: objectEntries.length,
    objects: objectEntries,
  };
  return Object.freeze({ ...content, contentSha256: sha256(canonical(content)) });
}

function validateObjectMetadata(records, manifest) {
  const documents = new Map(records.client_documents.map((row) => [row.storage_path, row]));
  if (documents.size !== manifest.objects.length) fail("BACKUP_OBJECT_SET_MISMATCH");
  for (const object of manifest.objects) {
    const document = documents.get(object.path);
    if (!document || Number(document.size_bytes) !== object.byteLength ||
        document.parsed_summary.source.sha256 !== object.sha256) {
      fail("BACKUP_OBJECT_METADATA_MISMATCH");
    }
  }
}

function verifyBundle(bundle) {
  try {
    if (!isPlainObject(bundle) || bundle.format !== FORMAT || !isPlainObject(bundle.payload) ||
        !isPlainObject(bundle.payload.records) || !isPlainObject(bundle.payload.objects) || !isPlainObject(bundle.manifest)) {
      fail("BACKUP_FORMAT_INVALID");
    }
    const { scope, records } = validateRecordSet(bundle.payload.records, bundle.scope);
    const objectData = cloneJson(bundle.payload.objects);
    const expectedManifest = buildManifest(scope, records, objectData);
    if (canonical(expectedManifest) !== canonical(bundle.manifest)) fail("BACKUP_MANIFEST_MISMATCH");
    validateObjectMetadata(records, expectedManifest);
    return deepFreeze({ scope, records, objectData, manifest: expectedManifest });
  } catch (error) {
    if (error instanceof RecoveryProofError) throw error;
    fail("BACKUP_VALIDATION_FAILED");
  }
}

async function createIsolatedBackup({ scope: rawScope, readScopedRecords, readPrivateObject } = {}) {
  if (typeof readScopedRecords !== "function" || typeof readPrivateObject !== "function") {
    fail("BACKUP_SOURCE_REQUIRED");
  }
  const scope = validateScope(rawScope);
  let rawRecords;
  try {
    rawRecords = await readScopedRecords(scope);
  } catch {
    fail("BACKUP_DATABASE_READ_FAILED");
  }
  const { records } = validateRecordSet(rawRecords, scope);
  const objects = {};
  for (const document of records.client_documents) {
    let value;
    try {
      value = await readPrivateObject(document.storage_path);
    } catch {
      fail("BACKUP_OBJECT_READ_FAILED");
    }
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) fail("BACKUP_OBJECT_MISSING");
    const bytes = Buffer.from(value);
    if (bytes.length !== Number(document.size_bytes) || sha256(bytes) !== document.parsed_summary.source.sha256) {
      fail("BACKUP_OBJECT_SOURCE_MISMATCH");
    }
    objects[document.storage_path] = bytes.toString("base64");
  }
  const manifest = buildManifest(scope, records, objects);
  validateObjectMetadata(records, manifest);
  return deepFreeze({
    format: FORMAT,
    scope,
    manifest,
    payload: { records, objects },
  });
}

async function cleanupObjects(destinationObjects, paths) {
  for (const path of [...paths].reverse()) {
    try { await destinationObjects.delete(path); } catch { /* A failed cleanup stays a failed restore. */ }
  }
}

async function cleanupObjectWrites(destinationObjects, paths) {
  await cleanupObjects(destinationObjects, paths);
  try {
    return await destinationObjects.assertClean(paths) === true;
  } catch {
    return false;
  }
}

async function cleanupRestoredDestination(destinationRecords, destinationObjects, verified, paths) {
  try {
    await destinationRecords.cleanup(verified.scope, verified.records, verified.manifest);
  } catch { /* Cleanliness is verified below. */ }
  await cleanupObjects(destinationObjects, paths);

  let recordsClean = false;
  let objectsClean = false;
  try {
    recordsClean = await destinationRecords.assertClean(
      verified.scope,
      verified.records,
      verified.manifest,
    ) === true;
  } catch { recordsClean = false; }
  try { objectsClean = await destinationObjects.assertClean(paths) === true; } catch { objectsClean = false; }
  return recordsClean && objectsClean;
}

async function restoreIsolatedBackup({ bundle, destinationRecords, destinationObjects } = {}) {
  const verified = verifyBundle(bundle);
  if (!destinationRecords || typeof destinationRecords.assertClean !== "function" ||
      typeof destinationRecords.restore !== "function" || typeof destinationRecords.cleanup !== "function" ||
      typeof destinationRecords.readScopedRecords !== "function" ||
      !destinationObjects || typeof destinationObjects.assertClean !== "function" ||
      typeof destinationObjects.put !== "function" || typeof destinationObjects.get !== "function" ||
      typeof destinationObjects.delete !== "function") {
    fail("RESTORE_DESTINATION_REQUIRED");
  }
  const paths = verified.manifest.objects.map((item) => item.path);
  let clean;
  try {
    clean = await destinationRecords.assertClean(verified.scope, verified.records, verified.manifest) === true &&
      await destinationObjects.assertClean(paths) === true;
  } catch {
    fail("RESTORE_CLEAN_CHECK_FAILED");
  }
  if (!clean) fail("RESTORE_DESTINATION_NOT_CLEAN");

  const written = [];
  try {
    for (const object of verified.manifest.objects) {
      const bytes = decodeBase64(verified.objectData[object.path]);
      written.push(object.path);
      await destinationObjects.put(object.path, bytes);
      const restored = await destinationObjects.get(object.path);
      if (!(Buffer.isBuffer(restored) || restored instanceof Uint8Array)) fail("RESTORE_OBJECT_MISSING");
      const restoredBytes = Buffer.from(restored);
      if (restoredBytes.length !== object.byteLength || sha256(restoredBytes) !== object.sha256) {
        fail("RESTORE_OBJECT_TAMPERED");
      }
    }
  } catch (error) {
    if (!await cleanupObjectWrites(destinationObjects, written)) fail("RESTORE_CLEANUP_FAILED");
    if (error instanceof RecoveryProofError) throw error;
    fail("RESTORE_OBJECT_WRITE_FAILED");
  }

  try {
    await destinationRecords.restore(verified.records, verified.manifest);
  } catch {
    if (!await cleanupRestoredDestination(destinationRecords, destinationObjects, verified, written)) {
      fail("RESTORE_CLEANUP_FAILED");
    }
    fail("RESTORE_DATABASE_WRITE_FAILED");
  }

  try {
    let rawRestoredRecords;
    try {
      rawRestoredRecords = await destinationRecords.readScopedRecords(verified.scope);
    } catch {
      fail("RESTORE_DATABASE_READ_FAILED");
    }
    let restoredRecords;
    try {
      restoredRecords = validateRecordSet(rawRestoredRecords, verified.scope).records;
    } catch (error) {
      if (error instanceof RecoveryProofError) fail("RESTORE_RECORD_VERIFY_FAILED");
      throw error;
    }
    if (canonical(recordManifest(restoredRecords)) !== canonical(verified.manifest.records)) {
      fail("RESTORE_RECORD_VERIFY_FAILED");
    }
    for (const object of verified.manifest.objects) {
      let restored;
      try { restored = await destinationObjects.get(object.path); } catch { fail("RESTORE_OBJECT_READ_FAILED"); }
      if (!(Buffer.isBuffer(restored) || restored instanceof Uint8Array)) fail("RESTORE_OBJECT_MISSING");
      const bytes = Buffer.from(restored);
      if (bytes.length !== object.byteLength || sha256(bytes) !== object.sha256) fail("RESTORE_OBJECT_TAMPERED");
    }
  } catch (error) {
    if (!await cleanupRestoredDestination(destinationRecords, destinationObjects, verified, written)) {
      fail("RESTORE_CLEANUP_FAILED");
    }
    if (error instanceof RecoveryProofError) throw error;
    fail("RESTORE_VERIFY_FAILED");
  }
  return deepFreeze({
    ok: true,
    code: "RESTORE_VERIFIED",
    contentSha256: verified.manifest.contentSha256,
    recordCount: verified.manifest.recordCount,
    objectCount: verified.manifest.objectCount,
  });
}

function workflowResult({ status, code, answer = null, evidence = null } = {}) {
  return deepFreeze({ status, code, answer, evidence });
}

async function runRestoredDocumentWorkflow(input = {}, dependencies = {}) {
  const { resolveAuthorizedDocument, readPrivateObject, recordAudit, parser = parseDocument } = dependencies;
  if (typeof resolveAuthorizedDocument !== "function" || typeof readPrivateObject !== "function" ||
      typeof recordAudit !== "function" || typeof parser !== "function") {
    return workflowResult({ status: "failed", code: "RESTORED_WORKFLOW_DEPENDENCIES_REQUIRED" });
  }
  let request;
  try {
    const value = input && typeof input === "object" ? input : {};
    request = Object.freeze({
      actorId: value.actorId,
      clientCode: value.clientCode,
      department: value.department,
      docCode: value.docCode,
    });
  } catch {
    return workflowResult({ status: "denied", code: "RESTORED_DOCUMENT_REQUEST_INVALID" });
  }
  if (typeof request.actorId !== "string" || !ACTOR_ID.test(request.actorId) ||
      typeof request.clientCode !== "string" || !CLIENT_CODE.test(request.clientCode) ||
      typeof request.department !== "string" || !DEPARTMENT.test(request.department) ||
      typeof request.docCode !== "string" || !DOC_CODE.test(request.docCode)) {
    return workflowResult({ status: "denied", code: "RESTORED_DOCUMENT_REQUEST_INVALID" });
  }

  let document;
  try { document = await resolveAuthorizedDocument(request); } catch {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_AUTHORIZATION_UNCERTAIN" });
  }
  if (!isPlainObject(document)) return workflowResult({ status: "denied", code: "RESTORED_DOCUMENT_NOT_AUTHORIZED" });
  let metadata;
  try {
    metadata = Object.freeze({
      clientAccountId: String(document.client_account_id),
      clientCode: document.client_code,
      department: document.department,
      docCode: document.doc_code,
      storagePath: document.storage_path,
      fileName: document.file_name,
      mime: document.mime,
      sizeBytes: Number(document.size_bytes),
      sourceSha256: document.parsed_summary?.source?.sha256,
      sourceSizeBytes: Number(document.parsed_summary?.source?.size_bytes),
    });
  } catch {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_METADATA_INVALID" });
  }
  if (!SAFE_ID.test(metadata.clientAccountId) || metadata.clientCode !== request.clientCode ||
      metadata.department !== request.department || metadata.docCode !== request.docCode ||
      !validScopedObjectPath(metadata.storagePath, request.clientCode) ||
      typeof metadata.fileName !== "string" || typeof metadata.mime !== "string" ||
      !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1 ||
      !SHA256.test(metadata.sourceSha256) || metadata.sourceSizeBytes !== metadata.sizeBytes) {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_METADATA_INVALID" });
  }

  let raw;
  try { raw = await readPrivateObject(metadata.storagePath); } catch {
    return workflowResult({ status: "failed", code: "RESTORED_OBJECT_READ_FAILED" });
  }
  if (!(Buffer.isBuffer(raw) || raw instanceof Uint8Array)) {
    return workflowResult({ status: "failed", code: "RESTORED_OBJECT_MISSING" });
  }
  const bytes = Buffer.from(raw);
  if (bytes.length !== metadata.sizeBytes || sha256(bytes) !== metadata.sourceSha256) {
    return workflowResult({ status: "failed", code: "RESTORED_OBJECT_TAMPERED" });
  }

  let parsed;
  try { parsed = await parser(metadata.fileName, metadata.mime, bytes); } catch {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_PARSE_FAILED" });
  }
  if (parsed?.status !== "parsed" || parsed.summary?.source?.sha256 !== metadata.sourceSha256 ||
      Number(parsed.summary?.source?.size_bytes) !== bytes.length) {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_PARSE_FAILED" });
  }
  const rows = parsed.summary?.sheet_data?.[0]?.rows;
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_EVIDENCE_INVALID" });
  }
  const quantityIndex = rows[0].indexOf("quantity");
  const priceIndex = rows[0].indexOf("unit_price_thb");
  if (quantityIndex < 0 || priceIndex < 0) {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_EVIDENCE_INVALID" });
  }
  let total = 0;
  for (const row of rows.slice(1)) {
    const quantity = Number(row[quantityIndex]);
    const unitPrice = Number(row[priceIndex]);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice) || quantity < 0 || unitPrice < 0) {
      return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_EVIDENCE_INVALID" });
    }
    total += quantity * unitPrice;
  }
  if (!Number.isSafeInteger(Math.round(total * 100))) {
    return workflowResult({ status: "failed", code: "RESTORED_DOCUMENT_EVIDENCE_INVALID" });
  }
  const answer = `The verified total is ${total.toFixed(2)} THB before tax.`;
  let audited = false;
  try {
    audited = (await recordAudit(Object.freeze({
      event: "restored_document_answer_verified",
      actorId: request.actorId,
      clientAccountId: metadata.clientAccountId,
      clientCode: request.clientCode,
      department: request.department,
      docCode: request.docCode,
      sourceSha256: metadata.sourceSha256,
      answerSha256: sha256(answer),
    })))?.persisted === true;
  } catch { audited = false; }
  if (!audited) return workflowResult({ status: "failed", code: "RESTORED_WORKFLOW_AUDIT_FAILED" });
  return workflowResult({
    status: "verified",
    code: "RESTORED_DOCUMENT_ANSWER_VERIFIED",
    answer,
    evidence: Object.freeze({ docCode: request.docCode, sourceSha256: metadata.sourceSha256, byteLength: bytes.length }),
  });
}

module.exports = {
  RecoveryProofError,
  createIsolatedBackup,
  restoreIsolatedBackup,
  runRestoredDocumentWorkflow,
};
