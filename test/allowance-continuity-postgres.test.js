"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createSupabaseAllowanceContinuityStore } = require("../src/lib/supabase-allowance-continuity-store");

const migrationDirectory = path.join(__dirname, "../supabase/migrations");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_allowance_continuity.sql"));
assert.equal(migrationNames.length, 1, "Exactly one allowance continuity migration must exist");
const migrationSql = fs.readFileSync(path.join(migrationDirectory, migrationNames[0]), "utf8");

const THRESHOLD_ALLOWANCE = Object.freeze({
  poolId: "gemini_project",
  remaining: 3,
  unit: "request",
  verifiedAt: "2026-09-18T08:00:00.000Z",
  evidenceRef: "allowance.snapshot.001",
  resetAt: "2026-09-20T08:00:00.000Z",
  resetEvidenceRef: null,
});
const HARD_LIMIT_ALLOWANCE = Object.freeze({ ...THRESHOLD_ALLOWANCE, remaining: 0 });
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

function claimInput(suffix, overrides = {}) {
  return {
    alertKey: `threshold.gemini.${suffix}`,
    fingerprint: sha(`fingerprint:${suffix}`),
    kind: "threshold",
    actionKey: `accepted.action.${suffix}`,
    destination: "private-founder-destination",
    allowance: THRESHOLD_ALLOWANCE,
    policyVersion: "allowance-continuity.v1",
    approvalRef: "approval.local.001",
    ...overrides,
  };
}

function continuityInput(suffix, overrides = {}) {
  return {
    eventKey: `continuity.gemini.${suffix}`,
    fingerprint: sha(`continuity:${suffix}`),
    actionKey: `accepted.action.${suffix}`,
    reasonCode: "CONTINUITY_HARD_LIMIT",
    completed: false,
    allowance: HARD_LIMIT_ALLOWANCE,
    responseCode: "STATIC_CONTINUITY_RESPONSE",
    responseDigest: sha("approved static response"),
    policyVersion: "allowance-continuity.v1",
    approvalRef: "approval.local.001",
    ...overrides,
  };
}

function rpcAdapter(db) {
  const specifications = {
    nh_claim_allowance_alert: [
      ["p_alert_key", "text"], ["p_fingerprint", "text"], ["p_kind", "text"],
      ["p_action_key", "text"], ["p_destination_digest", "text"], ["p_allowance", "jsonb"],
      ["p_policy_version", "text"], ["p_approval_ref", "text"],
    ],
    nh_finish_allowance_alert: [
      ["p_claim_id", "uuid"], ["p_fingerprint", "text"], ["p_state", "text"],
      ["p_failure_code", "text"], ["p_receipt_digest", "text"],
    ],
    nh_record_allowance_continuity_event: [
      ["p_event_key", "text"], ["p_fingerprint", "text"], ["p_action_key", "text"],
      ["p_reason_code", "text"], ["p_completed", "boolean"], ["p_allowance", "jsonb"],
      ["p_response_code", "text"], ["p_response_digest", "text"],
      ["p_policy_version", "text"], ["p_approval_ref", "text"],
    ],
  };
  return async (name, parameters) => {
    const fields = specifications[name];
    if (!fields) throw new Error(`Unexpected RPC: ${name}`);
    const placeholders = fields.map(([, type], index) => `$${index + 1}::${type}`).join(", ");
    const values = fields.map(([field, type]) => type === "jsonb"
      ? JSON.stringify(parameters[field])
      : parameters[field]);
    const query = await db.query(`select public.${name}(${placeholders}) as result`, values);
    return { data: query.rows[0].result, error: null };
  };
}

test("durable allowance continuity claims, outcomes and browser denial in isolated PostgreSQL", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);
  await db.exec(migrationSql);
  const store = createSupabaseAllowanceContinuityStore({ rpc: rpcAdapter(db) });

  await t.test("concurrent claims create one durable alert and later claims are replays", async () => {
    const input = claimInput("concurrent");
    await db.exec("set role service_role");
    let results;
    try {
      results = await Promise.all([store.claimAlert(input), store.claimAlert(input)]);
    } finally {
      await db.exec("reset role");
    }
    assert.equal(results.filter((result) => result.newClaim).length, 1);
    assert.equal(results.every((result) => result.state === "claimed"), true);
    assert.equal(new Set(results.map((result) => result.claimId)).size, 1);
    assert.equal(new Set(results.map((result) => result.fingerprint)).size, 1);

    await db.exec("set role service_role");
    try {
      const replay = await store.claimAlert(input);
      assert.deepEqual(replay, {
        state: "claimed", newClaim: false,
        claimId: results[0].claimId, fingerprint: input.fingerprint,
      });
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("uncertain, failed and delivered outcomes are explicit terminal states", async () => {
    const uncertainInput = claimInput("uncertain");
    const failedInput = claimInput("failed");
    const deliveredInput = claimInput("delivered");
    await db.exec("set role service_role");
    try {
      const uncertain = await store.claimAlert(uncertainInput);
      assert.deepEqual(await store.finishAlert({
        claimId: uncertain.claimId,
        fingerprint: uncertain.fingerprint,
        state: "uncertain",
        failureCode: "delivery_timeout",
      }), { recorded: true, state: "uncertain" });
      assert.equal((await store.claimAlert(uncertainInput)).state, "uncertain");
      assert.deepEqual(await store.finishAlert({
        claimId: uncertain.claimId,
        fingerprint: uncertain.fingerprint,
        state: "delivered",
        receiptId: "late-receipt-must-not-win",
      }), { recorded: false, state: "uncertain" });

      const failed = await store.claimAlert(failedInput);
      assert.deepEqual(await store.finishAlert({
        claimId: failed.claimId,
        fingerprint: failed.fingerprint,
        state: "failed",
        failureCode: "transport_failed",
      }), { recorded: true, state: "failed" });
      assert.equal((await store.claimAlert(failedInput)).state, "failed");

      const delivered = await store.claimAlert(deliveredInput);
      const finished = {
        claimId: delivered.claimId,
        fingerprint: delivered.fingerprint,
        state: "delivered",
        receiptId: "line-receipt-local-001",
      };
      assert.deepEqual(await store.finishAlert(finished), { recorded: true, state: "delivered" });
      assert.deepEqual(await store.finishAlert(finished), { recorded: true, state: "delivered" });
      assert.equal((await store.claimAlert(deliveredInput)).state, "delivered");
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("a conflicting alert identity cannot overwrite the first claim", async () => {
    const input = claimInput("conflict");
    await db.exec("set role service_role");
    try {
      const first = await store.claimAlert(input);
      const conflict = await store.claimAlert({ ...input, fingerprint: sha("different fingerprint") });
      assert.equal(first.newClaim, true);
      assert.deepEqual(conflict, {
        state: "conflict", newClaim: false, claimId: null, fingerprint: null,
      });
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("hard-limit continuity evidence is durable, idempotent and conflict detecting", async () => {
    const input = continuityInput("hard-limit");
    await db.exec("set role service_role");
    try {
      const results = await Promise.all([
        store.recordContinuity(input),
        store.recordContinuity(input),
      ]);
      assert.equal(results.every((result) => result.recorded && !result.conflict), true);
      assert.equal(results.filter((result) => result.idempotent).length, 1);
      assert.deepEqual(await store.recordContinuity({
        ...input,
        fingerprint: sha("different continuity fingerprint"),
      }), { recorded: false, conflict: true, idempotent: false });
    } finally {
      await db.exec("reset role");
    }
    const row = (await db.query(`
      select completed, reason_code, response_code
      from public.nh_allowance_continuity_events where event_key = $1
    `, [input.eventKey])).rows[0];
    assert.deepEqual(row, {
      completed: false,
      reason_code: "CONTINUITY_HARD_LIMIT",
      response_code: "STATIC_CONTINUITY_RESPONSE",
    });
  });

  await t.test("browser roles cannot read or invoke continuity storage", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query("select * from public.nh_allowance_alerts"), /permission denied/i);
        await assert.rejects(db.query("select * from public.nh_allowance_continuity_events"), /permission denied/i);
        await assert.rejects(store.claimAlert(claimInput(`browser-${role}`)), {
          code: "ALLOWANCE_CONTINUITY_RPC_FAILED",
        });
      } finally {
        await db.exec("reset role");
      }
    }
  });

  await t.test("service role cannot forge a delivered receipt through direct table writes", async () => {
    const input = claimInput("direct-forgery");
    await db.exec("set role service_role");
    try {
      const claim = await store.claimAlert(input);
      assert.equal(claim.newClaim, true);
      await assert.rejects(db.query(`
        update public.nh_allowance_alerts
        set state = 'delivered', receipt_digest = $1, finished_at = clock_timestamp()
        where claim_id = $2
      `, [sha("forged receipt"), claim.claimId]), /permission denied/i);
      await assert.rejects(db.query(`
        insert into public.nh_allowance_alerts (
          alert_key, fingerprint, kind, action_key, destination_digest, allowance,
          policy_version, approval_ref, state, receipt_digest, finished_at
        ) values ($1, $2, 'threshold', $3, $4, $5::jsonb,
          'allowance-continuity.v1', 'approval.local.001', 'delivered', $6, clock_timestamp())
      `, [
        "threshold.gemini.forged-insert", sha("forged insert"), "accepted.action.forged",
        sha("founder"), JSON.stringify(THRESHOLD_ALLOWANCE), sha("forged receipt"),
      ]), /permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("stored destination and receipt evidence are digests rather than raw identifiers", async () => {
    const rows = (await db.query(`
      select destination_digest, receipt_digest
      from public.nh_allowance_alerts
      where alert_key = 'threshold.gemini.delivered'
    `)).rows;
    assert.equal(rows.length, 1);
    assert.match(rows[0].destination_digest, /^[0-9a-f]{64}$/);
    assert.match(rows[0].receipt_digest, /^[0-9a-f]{64}$/);
    assert.notEqual(rows[0].destination_digest, "private-founder-destination");
    assert.notEqual(rows[0].receipt_digest, "line-receipt-local-001");
  });
});

test("the continuity adapter sanitizes RPC failures and honors a pre-aborted request", async () => {
  assert.throws(() => createSupabaseAllowanceContinuityStore(), /server-only Supabase RPC/);
  const failing = createSupabaseAllowanceContinuityStore({
    rpc: async () => ({ data: null, error: { message: "private database detail" } }),
  });
  await assert.rejects(failing.claimAlert(claimInput("rpc-failure")), (error) => {
    assert.equal(error.code, "ALLOWANCE_CONTINUITY_RPC_FAILED");
    assert.equal(error.message.includes("private database detail"), false);
    return true;
  });

  let calls = 0;
  const aborted = createSupabaseAllowanceContinuityStore({
    rpc: async () => { calls += 1; return { data: {}, error: null }; },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(aborted.claimAlert({ ...claimInput("aborted"), signal: controller.signal }), {
    name: "AbortError",
    code: "ALLOWANCE_CONTINUITY_ABORTED",
  });
  assert.equal(calls, 0);
});
