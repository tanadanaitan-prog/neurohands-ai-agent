"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { parseDocument } = require("../src/lib/document-parser");
const {
  createIsolatedBackup,
  restoreIsolatedBackup,
  runRestoredDocumentWorkflow,
} = require("../src/lib/isolated-backup-restore");

const TABLES = [
  "client_accounts",
  "client_agent_bindings",
  "client_documents",
  "agent_runs",
  "tool_calls",
  "jarvis_audit_log",
];
const ALPHA_USER = "fictional-user-alpha";
const BETA_USER = "fictional-user-beta";
const DOCUMENT_CODE = "FIXA-RECOVERY-001";
const OBJECT_PATH = "FIXA/SAL/2026-09/FIXA-RECOVERY-001.csv";
const ORIGINAL = Buffer.from([
  "item,quantity,unit_price_thb",
  "Fictional panel,3,120",
  "Fictional packing,1,40",
].join("\n"), "utf8");

async function createSchema() {
  const db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  await db.exec(fs.readFileSync(path.join(__dirname, "fixtures/legacy-schema.sql"), "utf8"));
  await db.exec(fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260907123525_phase1_gateway_recovery.sql"),
    "utf8",
  ));
  await db.query("delete from client_accounts where client_code='KNC'");
  return db;
}

async function jsonRows(db, sql, parameters) {
  return (await db.query(sql, parameters)).rows.map((row) => row.record);
}

function parseAuditScope(row) {
  try {
    const detail = JSON.parse(row.detail);
    return detail && typeof detail === "object" && !Array.isArray(detail) ? detail.scope : null;
  } catch {
    return null;
  }
}

function createRecordReader(db) {
  return async ({ clientAccountId, clientCode }) => {
    const auditCandidates = await jsonRows(db,
      "select to_jsonb(j) record from jarvis_audit_log j where j.line_user_id in " +
        "(select line_user_id from client_agent_bindings where client_account_id=$1) order by j.id",
      [clientAccountId]);
    return {
      client_accounts: await jsonRows(db,
      "select to_jsonb(a) record from client_accounts a where id=$1 order by id", [clientAccountId]),
      client_agent_bindings: await jsonRows(db,
      "select to_jsonb(b) record from client_agent_bindings b where client_account_id=$1 order by id", [clientAccountId]),
      client_documents: await jsonRows(db,
      "select to_jsonb(d) record from client_documents d where client_account_id=$1 order by id", [clientAccountId]),
      agent_runs: await jsonRows(db,
      "select to_jsonb(r) record from agent_runs r where client_account_id=$1 order by id", [clientAccountId]),
      tool_calls: await jsonRows(db,
      "select to_jsonb(t) record from tool_calls t join agent_runs r on r.id=t.run_id where r.client_account_id=$1 order by t.id",
      [clientAccountId]),
      jarvis_audit_log: auditCandidates.filter((row) => {
        const auditScope = parseAuditScope(row);
        return String(auditScope?.clientAccountId) === String(clientAccountId) && auditScope?.clientCode === clientCode;
      }),
    };
  };
}

async function insertJsonRecord(db, table, record) {
  await db.query(
    `insert into public.${table} overriding system value ` +
      `select (jsonb_populate_record(null::public.${table}, $1::jsonb)).*`,
    [JSON.stringify(record)],
  );
}

function createRecordDestination(db) {
  const readScopedRecords = createRecordReader(db);
  let restoreCalls = 0;
  let cleanupCalls = 0;
  return {
    get restoreCalls() { return restoreCalls; },
    get cleanupCalls() { return cleanupCalls; },
    readScopedRecords,
    async assertClean() {
      for (const table of TABLES) {
        const count = (await db.query(`select count(*)::int n from public.${table}`)).rows[0].n;
        if (count !== 0) return false;
      }
      return true;
    },
    async restore(records) {
      restoreCalls += 1;
      await db.exec("begin");
      try {
        for (const table of TABLES) {
          for (const record of records[table]) await insertJsonRecord(db, table, record);
          await db.query(
            "select setval(pg_get_serial_sequence($1,'id'), greatest(coalesce(max(id),1),1), count(*) > 0) " +
              `from public.${table}`,
            [`public.${table}`],
          );
        }
        await db.exec("commit");
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    },
    async cleanup(_scope, _records, _manifest) {
      cleanupCalls += 1;
      await db.exec("begin");
      try {
        for (const table of [...TABLES].reverse()) await db.query(`delete from public.${table}`);
        await db.exec("commit");
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    },
  };
}

function createObjectStore(initial = new Map()) {
  const objects = new Map([...initial].map(([key, value]) => [key, Buffer.from(value)]));
  let reads = 0;
  return {
    objects,
    get reads() { return reads; },
    async assertClean(paths) { return paths.every((item) => !objects.has(item)); },
    async put(objectPath, bytes) { objects.set(objectPath, Buffer.from(bytes)); },
    async get(objectPath) { reads += 1; return objects.has(objectPath) ? Buffer.from(objects.get(objectPath)) : null; },
    async delete(objectPath) { objects.delete(objectPath); },
  };
}

async function seedSource(db) {
  const parsed = await parseDocument("fictional-recovery.csv", "text/csv", ORIGINAL);
  assert.equal(parsed.status, "parsed");
  const alpha = (await db.query(
    "insert into client_accounts(client_code,company) values ('FIXA','Fictional Alpha Company') returning id",
  )).rows[0].id;
  const beta = (await db.query(
    "insert into client_accounts(client_code,company) values ('FIXB','Fictional Beta Company') returning id",
  )).rows[0].id;
  await db.query(
    "insert into client_agent_bindings(client_account_id,line_user_id,department,role,status) " +
      "values ($1,$2,'sales','member','active'),($3,$2,'finance','member','active')",
    [alpha, ALPHA_USER, beta],
  );
  await db.query(
    "insert into client_documents(doc_code,client_account_id,department,file_name,mime,size_bytes,storage_path," +
      "uploaded_by,parsed_status,parsed_summary,row_count) values ($1,$2,'sales','fictional-recovery.csv','text/csv',$3,$4,$5,'parsed',$6,$7)",
    [DOCUMENT_CODE, alpha, ORIGINAL.length, OBJECT_PATH, ALPHA_USER, JSON.stringify(parsed.summary), parsed.rows],
  );
  const betaBytes = Buffer.from("item,quantity,unit_price_thb\nPrivate beta row,1,999", "utf8");
  const betaParsed = await parseDocument("fictional-beta.csv", "text/csv", betaBytes);
  await db.query(
    "insert into client_documents(doc_code,client_account_id,department,file_name,mime,size_bytes,storage_path," +
      "uploaded_by,parsed_status,parsed_summary,row_count) values " +
      "('FIXB-PRIVATE-001',$1,'finance','fictional-beta.csv','text/csv',$2,'FIXB/FIN/2026-09/FIXB-PRIVATE-001.csv',$3,'parsed',$4,$5)",
    [beta, betaBytes.length, ALPHA_USER, JSON.stringify(betaParsed.summary), betaParsed.rows],
  );
  const alphaRun = (await db.query(
    "insert into agent_runs(agent_code,line_user_id,client_account_id,department,objective,input,status,iterations,output,completed_at) " +
      "values ('AGT-001',$1,$2,'sales','Read restored evidence','fixture question','completed',1,'400 THB',now()) returning id",
    [ALPHA_USER, alpha],
  )).rows[0].id;
  const betaRun = (await db.query(
    "insert into agent_runs(agent_code,line_user_id,client_account_id,department,input,status,iterations,output,completed_at) " +
      "values ('AGT-001',$1,$2,'finance','private beta question','completed',1,'999 THB',now()) returning id",
    [ALPHA_USER, beta],
  )).rows[0].id;
  await db.query(
    "insert into tool_calls(run_id,agent_code,tool_name,input,output,allowed,status) values " +
      "($1,'AGT-001','read_document',$2,$3,true,'success'),($4,'AGT-001','read_document',$5,$6,true,'success')",
    [
      alphaRun, JSON.stringify({ doc_code: DOCUMENT_CODE }), JSON.stringify({ verified_total: 400 }),
      betaRun, JSON.stringify({ doc_code: "FIXB-PRIVATE-001" }), JSON.stringify({ verified_total: 999 }),
    ],
  );
  const auditRows = (await db.query(
    "insert into jarvis_audit_log(event_type,detail,line_user_id) values " +
      "('fictional_document_verified',$1,$3)," +
      "('fictional_document_verified',$2,$3) returning id",
    [
      JSON.stringify({
        scope: { clientAccountId: String(alpha), clientCode: "FIXA" },
        evidence: { label: "Alpha recovery evidence" },
      }),
      JSON.stringify({
        scope: { clientAccountId: String(beta), clientCode: "FIXB" },
        evidence: { label: "Beta private evidence" },
      }),
      ALPHA_USER,
    ],
  )).rows;
  return {
    alpha: String(alpha),
    beta: String(beta),
    betaAuditId: String(auditRows[1].id),
    betaBytes,
    sourceObjects: new Map([
      [OBJECT_PATH, ORIGINAL],
      ["FIXB/FIN/2026-09/FIXB-PRIVATE-001.csv", betaBytes],
    ]),
  };
}

function createApplicationDependencies(db, objectStore) {
  return {
    async resolveAuthorizedDocument({ actorId, clientCode, department, docCode }) {
      const result = await db.query(
        "select d.*, a.client_code from client_documents d " +
          "join client_accounts a on a.id=d.client_account_id and a.active=true " +
          "join client_agent_bindings b on b.client_account_id=a.id and b.status='active' " +
          "and b.line_user_id=$1 and b.department=$2 " +
          "where a.client_code=$3 and d.department=$2 and d.doc_code=$4 limit 1",
        [actorId, department, clientCode, docCode],
      );
      return result.rows[0] || null;
    },
    readPrivateObject: (objectPath) => objectStore.get(objectPath),
    async recordAudit(entry) {
      await db.query(
        "insert into jarvis_audit_log(event_type,detail,line_user_id) values ($1,$2,$3)",
        [entry.event, JSON.stringify({
          scope: { clientAccountId: entry.clientAccountId, clientCode: entry.clientCode },
          evidence: {
            docCode: entry.docCode,
            sourceSha256: entry.sourceSha256,
            answerSha256: entry.answerSha256,
          },
        }), entry.actorId],
      );
      return { persisted: true };
    },
  };
}

test("C12 restores scoped records, audit evidence and original private objects into clean isolated destinations", async (t) => {
  const sourceDb = await createSchema();
  t.after(() => sourceDb.close());
  const fixture = await seedSource(sourceDb);
  const scope = { clientAccountId: fixture.alpha, clientCode: "FIXA" };
  const readSourceRecords = createRecordReader(sourceDb);
  const backup = await createIsolatedBackup({
    scope,
    readScopedRecords: readSourceRecords,
    readPrivateObject: async (objectPath) => fixture.sourceObjects.get(objectPath) || null,
  });

  assert.equal(backup.format, "neurohands-isolated-recovery/v1");
  assert.equal(backup.manifest.objectCount, 1);
  assert.equal(backup.manifest.recordCount, 6);
  assert.equal(backup.manifest.objects[0].path, OBJECT_PATH);
  assert.equal(backup.manifest.objects[0].byteLength, ORIGINAL.length);
  assert.equal(backup.manifest.objects[0].sha256, createHash("sha256").update(ORIGINAL).digest("hex"));
  assert.match(backup.manifest.contentSha256, /^[0-9a-f]{64}$/);
  const sourceRecords = await readSourceRecords(scope);
  const sharedActorAudits = await jsonRows(sourceDb,
    "select to_jsonb(j) record from jarvis_audit_log j where line_user_id=$1 order by id",
    [ALPHA_USER]);
  assert.equal(sharedActorAudits.length, 2, "the fixture exercises one LINE actor shared by two clients");
  assert.equal(sourceRecords.jarvis_audit_log.length, 1);
  assert.deepEqual(parseAuditScope(sourceRecords.jarvis_audit_log[0]), scope);
  assert.deepEqual(
    backup.manifest.records.map(({ table, id }) => ({ table, id })),
    TABLES.flatMap((table) => sourceRecords[table].map(({ id }) => ({ table, id: String(id) }))),
  );
  assert.equal(backup.manifest.records.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)), true);
  assert.equal(Object.isFrozen(backup), true);
  assert.equal(JSON.stringify(backup).includes("FIXB-PRIVATE-001"), false);
  assert.equal(JSON.stringify(backup).includes("999 THB"), false);

  await t.test("a shared LINE actor cannot carry another client's structured audit evidence into the backup", async () => {
    const leakedRecords = structuredClone(sourceRecords);
    leakedRecords.jarvis_audit_log.push(sharedActorAudits.find((row) => String(row.id) === fixture.betaAuditId));
    let objectReads = 0;
    await assert.rejects(createIsolatedBackup({
      scope,
      readScopedRecords: async () => leakedRecords,
      readPrivateObject: async () => { objectReads += 1; return ORIGINAL; },
    }), (error) => error.code === "BACKUP_SCOPE_MISMATCH");
    assert.equal(objectReads, 0, "cross-client audit evidence is rejected before object access");
  });

  await t.test("an object path outside the exact client-code prefix is rejected before object access", async () => {
    const leakedRecords = structuredClone(sourceRecords);
    leakedRecords.client_documents[0].storage_path = "FIXA2/SAL/2026-09/FIXA-RECOVERY-001.csv";
    let objectReads = 0;
    await assert.rejects(createIsolatedBackup({
      scope,
      readScopedRecords: async () => leakedRecords,
      readPrivateObject: async () => { objectReads += 1; return ORIGINAL; },
    }), (error) => error.code === "BACKUP_SCOPE_MISMATCH");
    assert.equal(objectReads, 0, "cross-prefix paths are rejected before object access");
  });

  await t.test("exact rows and objects restore, permissions hold, and the authorized app answer comes from the original", async (t) => {
    const destinationDb = await createSchema();
    t.after(() => destinationDb.close());
    const records = createRecordDestination(destinationDb);
    const objects = createObjectStore();
    const report = await restoreIsolatedBackup({
      bundle: backup,
      destinationRecords: records,
      destinationObjects: objects,
    });
    assert.deepEqual(report, {
      ok: true,
      code: "RESTORE_VERIFIED",
      contentSha256: backup.manifest.contentSha256,
      recordCount: 6,
      objectCount: 1,
    });
    assert.deepEqual(objects.objects.get(OBJECT_PATH), ORIGINAL);
    assert.deepEqual(await records.readScopedRecords(scope), sourceRecords);

    for (const role of ["anon", "authenticated"]) {
      await destinationDb.exec(`set role ${role}`);
      try {
        await assert.rejects(destinationDb.query("select * from client_documents"), { code: "42501" });
        await assert.rejects(destinationDb.query("select * from jarvis_audit_log"), { code: "42501" });
      } finally {
        await destinationDb.exec("reset role");
      }
    }

    const dependencies = createApplicationDependencies(destinationDb, objects);
    const answer = await runRestoredDocumentWorkflow({
      actorId: ALPHA_USER,
      clientCode: "FIXA",
      department: "sales",
      docCode: DOCUMENT_CODE,
    }, dependencies);
    assert.equal(answer.status, "verified");
    assert.equal(answer.code, "RESTORED_DOCUMENT_ANSWER_VERIFIED");
    assert.equal(answer.answer, "The verified total is 400.00 THB before tax.");
    assert.equal(answer.evidence.sourceSha256, backup.manifest.objects[0].sha256);
    const workflowAudits = (await destinationDb.query(
      "select detail from jarvis_audit_log where event_type='restored_document_answer_verified'",
    )).rows;
    assert.equal(workflowAudits.length, 1);
    assert.deepEqual(JSON.parse(workflowAudits[0].detail).scope, scope);

    const readsBeforeDenial = objects.reads;
    const denied = await runRestoredDocumentWorkflow({
      actorId: BETA_USER,
      clientCode: "FIXA",
      department: "sales",
      docCode: DOCUMENT_CODE,
    }, dependencies);
    assert.deepEqual(denied, {
      status: "denied", code: "RESTORED_DOCUMENT_NOT_AUTHORIZED", answer: null, evidence: null,
    });
    assert.equal(objects.reads, readsBeforeDenial, "cross-client denial occurs before object access");

    objects.objects.set(OBJECT_PATH, Buffer.from("tampered", "utf8"));
    const tampered = await runRestoredDocumentWorkflow({
      actorId: ALPHA_USER, clientCode: "FIXA", department: "sales", docCode: DOCUMENT_CODE,
    }, dependencies);
    assert.equal(tampered.code, "RESTORED_OBJECT_TAMPERED");
    assert.equal(tampered.answer, null);
    objects.objects.delete(OBJECT_PATH);
    const missing = await runRestoredDocumentWorkflow({
      actorId: ALPHA_USER, clientCode: "FIXA", department: "sales", docCode: DOCUMENT_CODE,
    }, dependencies);
    assert.equal(missing.code, "RESTORED_OBJECT_MISSING");
    assert.equal(missing.answer, null);
  });

  await t.test("a missing source object fails visibly before a backup can be claimed", async () => {
    await assert.rejects(createIsolatedBackup({
      scope,
      readScopedRecords: readSourceRecords,
      readPrivateObject: async () => null,
    }), (error) => error.code === "BACKUP_OBJECT_MISSING");
  });

  await t.test("a tampered backup fails validation before either destination is touched", async () => {
    const tampered = structuredClone(backup);
    tampered.payload.objects[OBJECT_PATH] = Buffer.from("changed", "utf8").toString("base64");
    let cleanChecks = 0;
    let puts = 0;
    await assert.rejects(restoreIsolatedBackup({
      bundle: tampered,
      destinationRecords: {
        async assertClean() { cleanChecks += 1; return true; },
        async restore() { throw new Error("must not run"); },
        async readScopedRecords() { throw new Error("must not run"); },
      },
      destinationObjects: {
        async assertClean() { cleanChecks += 1; return true; },
        async put() { puts += 1; },
        async get() { return null; },
        async delete() {},
      },
    }), (error) => error.code === "BACKUP_MANIFEST_MISMATCH");
    assert.equal(cleanChecks, 0);
    assert.equal(puts, 0);
  });

  await t.test("a destination that alters object bytes fails before database restoration", async () => {
    const destinationDb = await createSchema();
    t.after(() => destinationDb.close());
    const records = createRecordDestination(destinationDb);
    const badObjects = createObjectStore();
    badObjects.put = async (objectPath) => badObjects.objects.set(objectPath, Buffer.from("altered", "utf8"));
    await assert.rejects(restoreIsolatedBackup({
      bundle: backup,
      destinationRecords: records,
      destinationObjects: badObjects,
    }), (error) => error.code === "RESTORE_OBJECT_TAMPERED");
    assert.equal(records.restoreCalls, 0);
    assert.equal(badObjects.objects.size, 0, "failed object is removed from the isolated destination");
  });

  await t.test("a post-restore record mismatch cleans both destinations and permits a retry", async (t) => {
    const destinationDb = await createSchema();
    t.after(() => destinationDb.close());
    const records = createRecordDestination(destinationDb);
    const restoreRecords = records.restore.bind(records);
    records.restore = async (...args) => {
      await restoreRecords(...args);
      if (records.restoreCalls === 1) {
        await destinationDb.query("update agent_runs set output='post-restore mismatch'");
      }
    };
    const objects = createObjectStore();

    await assert.rejects(restoreIsolatedBackup({
      bundle: backup,
      destinationRecords: records,
      destinationObjects: objects,
    }), (error) => error.code === "RESTORE_RECORD_VERIFY_FAILED");
    assert.equal(records.cleanupCalls, 1);
    assert.equal(await records.assertClean(), true, "database rows are removed after verification failure");
    assert.equal(await objects.assertClean([OBJECT_PATH]), true, "restored objects are removed after verification failure");

    const retry = await restoreIsolatedBackup({
      bundle: backup,
      destinationRecords: records,
      destinationObjects: objects,
    });
    assert.equal(retry.code, "RESTORE_VERIFIED");
    assert.equal(records.restoreCalls, 2);
  });

  await t.test("a post-restore object mismatch cleans both destinations and permits a retry", async (t) => {
    const destinationDb = await createSchema();
    t.after(() => destinationDb.close());
    const records = createRecordDestination(destinationDb);
    const objects = createObjectStore();
    const readObject = objects.get.bind(objects);
    objects.get = async (objectPath) => {
      const value = await readObject(objectPath);
      if (records.restoreCalls === 1 && objects.reads === 2) return Buffer.from("post-restore mismatch", "utf8");
      return value;
    };

    await assert.rejects(restoreIsolatedBackup({
      bundle: backup,
      destinationRecords: records,
      destinationObjects: objects,
    }), (error) => error.code === "RESTORE_OBJECT_TAMPERED");
    assert.equal(records.cleanupCalls, 1);
    assert.equal(await records.assertClean(), true, "database rows are removed after object verification failure");
    assert.equal(await objects.assertClean([OBJECT_PATH]), true, "restored objects are removed after object verification failure");

    const retry = await restoreIsolatedBackup({
      bundle: backup,
      destinationRecords: records,
      destinationObjects: objects,
    });
    assert.equal(retry.code, "RESTORE_VERIFIED");
    assert.equal(records.restoreCalls, 2);
  });
});
