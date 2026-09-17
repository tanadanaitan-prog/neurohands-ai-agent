const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const migrationDirectory = path.join(__dirname, "../supabase/migrations");
const migrationName = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_durable_allowance_admission.sql"));

assert.equal(migrationName.length, 1, "Exactly one durable allowance migration must exist");
const migrationSql = fs.readFileSync(path.join(migrationDirectory, migrationName[0]), "utf8");

const future = (minutes = 10) => new Date(Date.now() + minutes * 60_000).toISOString();
const uuid = () => crypto.randomUUID();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function result(db, sql, params = []) {
  return (await db.query(sql, params)).rows[0].result;
}

async function reserve(db, poolId, idempotencyKey, overrides = {}) {
  return result(db, `
    select public.nh_reserve_allowance_bundle(
      $1::text, $2::text, $3::text, $4::text, $5::text,
      $6::jsonb, $7::jsonb, $8::timestamptz
    ) as result
  `, [
    idempotencyKey,
    overrides.requestDigest || digest(idempotencyKey),
    overrides.workload || "engineering",
    overrides.actor || "agent-one",
    overrides.operation || "synthetic_probe",
    JSON.stringify(overrides.actionRequirements || [{ pool: poolId, units: 1 }]),
    JSON.stringify(overrides.verificationRequirements || [{ pool: poolId, units: 1 }]),
    overrides.expiresAt || future(),
  ]);
}

async function dispatch(db, reservationId, dispatchKey, actor = "agent-one") {
  return result(db, `
    select public.nh_mark_allowance_dispatched(
      $1::uuid, $2::uuid, $3::text
    ) as result
  `, [reservationId, dispatchKey, actor]);
}

async function cancel(db, reservationId, cancellationKey, actor = "agent-one") {
  return result(db, `
    select public.nh_cancel_allowance_reservation(
      $1::uuid, $2::uuid, $3::text
    ) as result
  `, [reservationId, cancellationKey, actor]);
}

async function uncertain(db, reservationId, reconciliationKey, actor = "agent-one") {
  return result(db, `
    select public.nh_mark_allowance_reconciliation_required(
      $1::uuid, $2::uuid, $3::text
    ) as result
  `, [reservationId, reconciliationKey, actor]);
}

async function settle(db, reservationId, settlementKey, outcome, actualUnits, actor = "agent-one") {
  return result(db, `
    select public.nh_settle_allowance_reservation(
      $1::uuid, $2::uuid, $3::text, $4::jsonb, $5::text
    ) as result
  `, [reservationId, settlementKey, outcome, JSON.stringify(actualUnits), actor]);
}

async function reconcile(db, at, actor = "allowance-reconciler") {
  return result(db, `
    select public.nh_reconcile_allowance_reservations(
      $1::timestamptz, $2::text
    ) as result
  `, [at, actor]);
}

async function insertPool(db, {
  id,
  status = "verified_available",
  limit = 10,
  remaining = limit,
  threshold = null,
  resetAt = null,
  epoch = null,
}) {
  await db.query(`
    insert into public.nh_allowance_pools (
      pool_id, unit_name, allowance_status, verified_limit_units,
      remaining_units, alert_threshold_units, reset_at, evidence_ref,
      allowance_epoch
    ) values (
      $1, 'request_unit', $2, $3, $4, $5, $6, 'isolated-test',
      coalesce($7::uuid, gen_random_uuid())
    )
  `, [id, status, limit, remaining, threshold, resetAt, epoch]);
}

test("durable allowance admission is atomic, recoverable and unavailable to browser roles", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);
  await db.exec(migrationSql);

  await t.test("concurrent callers cannot both spend the final action-plus-verification budget", async () => {
    await insertPool(db, { id: "final-action", limit: 1, remaining: 1, threshold: 0 });
    await insertPool(db, { id: "final-verification", limit: 1, remaining: 1, threshold: 0 });
    const bundle = {
      actionRequirements: [{ pool: "final-action", units: 1 }],
      verificationRequirements: [{ pool: "final-verification", units: 1 }],
    };
    await db.exec("set role service_role");
    let decisions;
    try {
      decisions = await Promise.all([
        reserve(db, "final-action", "agent-one-final", bundle),
        reserve(db, "final-action", "agent-two-final", { ...bundle, actor: "agent-two" }),
      ]);
    } finally {
      await db.exec("reset role");
    }

    assert.equal(decisions.filter((decision) => decision.allowed).length, 1);
    assert.equal(decisions.filter((decision) => !decision.allowed).length, 1);
    assert.equal(decisions.find((decision) => decision.allowed).code, "ALLOWED_WITH_ALERT");
    assert.equal(decisions.find((decision) => !decision.allowed).code, "ALLOWANCE_EXHAUSTED");

    const pools = (await db.query(`
      select pool_id, allowance_status, remaining_units, version
      from public.nh_allowance_pools
      where pool_id in ('final-action', 'final-verification') order by pool_id
    `)).rows;
    assert.deepEqual(pools, [
      { pool_id: "final-action", allowance_status: "verified_exhausted", remaining_units: 0, version: 2 },
      { pool_id: "final-verification", allowance_status: "verified_exhausted", remaining_units: 0, version: 2 },
    ]);
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_allowance_reservations
      where idempotency_key in ('agent-one-final', 'agent-two-final')
    `)).rows[0].count, 1);
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_allowance_reservation_items
      where pool_id in ('final-action', 'final-verification')
    `)).rows[0].count, 2, "Both pools belong to the one winning bundle");
    assert.deepEqual((await db.query(`
      select event_type, decision_code, count(*)::int as count
      from public.nh_admission_audit
      where pool_id in ('final-action', 'final-verification')
      group by event_type, decision_code order by event_type
    `)).rows, [
      { event_type: "reservation_denied", decision_code: "ALLOWANCE_EXHAUSTED", count: 1 },
      { event_type: "reservation_granted", decision_code: "ALLOWED_WITH_ALERT", count: 2 },
    ]);

    const winnerIndex = decisions.findIndex((decision) => decision.allowed);
    const winnerKey = winnerIndex === 0 ? "agent-one-final" : "agent-two-final";
    const winnerActor = winnerIndex === 0 ? "agent-one" : "agent-two";
    await db.exec("set role service_role");
    try {
      const replay = await reserve(db, "final-action", winnerKey, {
        ...bundle,
        actor: winnerActor,
      });
      assert.deepEqual([replay.allowed, replay.code, replay.replayed], [true, "IDEMPOTENT_REPLAY", true]);
      const conflict = await reserve(db, "final-action", winnerKey, {
        actor: winnerActor,
        actionRequirements: [{ pool: "final-action", units: 2 }],
        verificationRequirements: [{ pool: "final-verification", units: 1 }],
      });
      assert.deepEqual([conflict.allowed, conflict.code], [false, "IDEMPOTENCY_CONFLICT"]);
    } finally {
      await db.exec("reset role");
    }

    await insertPool(db, { id: "atomic-action", limit: 1, remaining: 1 });
    await insertPool(db, {
      id: "atomic-verification",
      status: "verified_exhausted",
      limit: 0,
      remaining: 0,
    });
    await db.exec("set role service_role");
    let deniedBundle;
    try {
      deniedBundle = await reserve(db, "atomic-action", "atomic-all-or-none", {
        actionRequirements: [{ pool: "atomic-action", units: 1 }],
        verificationRequirements: [{ pool: "atomic-verification", units: 1 }],
      });
    } finally {
      await db.exec("reset role");
    }
    assert.deepEqual(
      [deniedBundle.allowed, deniedBundle.code, deniedBundle.pool],
      [false, "ALLOWANCE_EXHAUSTED", "atomic-verification"]
    );
    assert.equal((await db.query(`
      select remaining_units from public.nh_allowance_pools where pool_id = 'atomic-action'
    `)).rows[0].remaining_units, 1, "A later pool denial cannot debit an earlier pool");
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_allowance_reservations
      where idempotency_key = 'atomic-all-or-none'
    `)).rows[0].count, 0);
  });

  await t.test("a metered operation may reserve an action-only or verification-only bundle", async () => {
    await insertPool(db, { id: "asymmetric-bundle", limit: 4, remaining: 4 });
    await db.exec("set role service_role");
    try {
      const actionOnly = await reserve(db, "asymmetric-bundle", "action-only", {
        actionRequirements: [{ pool: "asymmetric-bundle", units: 1 }],
        verificationRequirements: [],
      });
      const verificationOnly = await reserve(db, "asymmetric-bundle", "verification-only", {
        actionRequirements: [],
        verificationRequirements: [{ pool: "asymmetric-bundle", units: 1 }],
      });
      assert.equal(actionOnly.allowed, true);
      assert.equal(verificationOnly.allowed, true);
      await assert.rejects(
        reserve(db, "asymmetric-bundle", "empty-bundle", {
          actionRequirements: [],
          verificationRequirements: [],
        }),
        { code: "22023" }
      );
    } finally {
      await db.exec("reset role");
    }
    assert.equal((await db.query(`
      select remaining_units from public.nh_allowance_pools
      where pool_id = 'asymmetric-bundle'
    `)).rows[0].remaining_units, 2);
  });

  await t.test("an audit write failure rolls back the pool debit and reservation", async () => {
    await insertPool(db, { id: "audit-rollback", limit: 2, remaining: 2 });
    await db.exec(`
      create function public.nh_test_fail_audit_insert()
      returns trigger language plpgsql as $$
      begin
        if new.pool_id = 'audit-rollback' then
          raise exception 'isolated audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger nh_test_fail_audit_insert
      before insert on public.nh_admission_audit
      for each row execute function public.nh_test_fail_audit_insert();
    `);

    await db.exec("set role service_role");
    try {
      await assert.rejects(
        reserve(db, "audit-rollback", "must-roll-back"),
        /isolated audit failure/
      );
    } finally {
      await db.exec("reset role");
    }

    assert.equal((await db.query(`
      select remaining_units from public.nh_allowance_pools
      where pool_id = 'audit-rollback'
    `)).rows[0].remaining_units, 2);
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_allowance_reservations
      where idempotency_key = 'must-roll-back'
    `)).rows[0].count, 0);
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_admission_audit
      where pool_id = 'audit-rollback'
    `)).rows[0].count, 0);

    await db.exec(`
      drop trigger nh_test_fail_audit_insert on public.nh_admission_audit;
      drop function public.nh_test_fail_audit_insert();
    `);
  });

  await t.test("unknown allowance is distinct from verified zero", async () => {
    await insertPool(db, {
      id: "unknown-pool",
      status: "unknown",
      limit: null,
      remaining: null,
    });
    await insertPool(db, {
      id: "zero-pool",
      status: "verified_exhausted",
      limit: 0,
      remaining: 0,
    });

    await db.exec("set role service_role");
    let unknownDecision;
    let zeroDecision;
    try {
      unknownDecision = await reserve(db, "unknown-pool", "unknown-attempt");
      zeroDecision = await reserve(db, "zero-pool", "zero-attempt");
    } finally {
      await db.exec("reset role");
    }
    assert.deepEqual(
      [unknownDecision.code, unknownDecision.remaining_units],
      ["ALLOWANCE_UNKNOWN", null]
    );
    assert.deepEqual(
      [zeroDecision.code, zeroDecision.remaining_units],
      ["ALLOWANCE_EXHAUSTED", 0]
    );
    assert.equal(unknownDecision.allowed, false);
    assert.equal(zeroDecision.allowed, false);

    await assert.rejects(db.query(`
      insert into public.nh_allowance_pools (
        pool_id, unit_name, allowance_status, verified_limit_units, remaining_units
      ) values ('invalid-unknown-zero', 'request_unit', 'unknown', null, 0)
    `), { code: "23514" });
  });

  await t.test("an expired verified allowance snapshot cannot authorize new work", async () => {
    await insertPool(db, {
      id: "expired-snapshot",
      limit: 5,
      remaining: 5,
      resetAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await db.exec("set role service_role");
    let denied;
    try {
      denied = await reserve(db, "expired-snapshot", "expired-snapshot-attempt");
    } finally {
      await db.exec("reset role");
    }
    assert.deepEqual(
      [denied.allowed, denied.code, denied.remaining_units],
      [false, "ALLOWANCE_SNAPSHOT_EXPIRED", 5]
    );
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_allowance_reservations
      where idempotency_key = 'expired-snapshot-attempt'
    `)).rows[0].count, 0);
    assert.equal((await db.query(`
      select remaining_units from public.nh_allowance_pools
      where pool_id = 'expired-snapshot'
    `)).rows[0].remaining_units, 5);
  });

  await t.test("a reservation lease cannot cross the verified allowance reset", async () => {
    await insertPool(db, {
      id: "near-reset-snapshot",
      limit: 5,
      remaining: 5,
      resetAt: future(2),
    });
    await db.exec("set role service_role");
    let denied;
    try {
      denied = await reserve(db, "near-reset-snapshot", "cross-reset-attempt", {
        expiresAt: future(5),
      });
    } finally {
      await db.exec("reset role");
    }
    assert.deepEqual(
      [denied.allowed, denied.code, denied.remaining_units],
      [false, "ALLOWANCE_LEASE_CROSSES_RESET", 5]
    );
    assert.equal((await db.query(`
      select count(*)::int as count from public.nh_allowance_reservations
      where idempotency_key = 'cross-reset-attempt'
    `)).rows[0].count, 0);
  });

  await t.test("dispatch revalidates the current allowance epoch and expiry", async () => {
    await insertPool(db, {
      id: "dispatch-expiry",
      limit: 5,
      remaining: 5,
      resetAt: future(5),
    });
    await db.exec("set role service_role");
    let reservation;
    try {
      reservation = await reserve(db, "dispatch-expiry", "dispatch-before-reset", {
        expiresAt: future(4),
      });
    } finally {
      await db.exec("reset role");
    }
    assert.equal(reservation.allowed, true);
    await db.query(`
      update public.nh_allowance_pools
      set reset_at = $1::timestamptz, updated_at = clock_timestamp()
      where pool_id = 'dispatch-expiry'
    `, [new Date(Date.now() - 60_000).toISOString()]);
    await db.exec("set role service_role");
    try {
      const denied = await dispatch(db, reservation.reservation_id, uuid());
      assert.deepEqual(
        [denied.allowed, denied.code, denied.state],
        [false, "ALLOWANCE_SNAPSHOT_EXPIRED", "reserved"]
      );
    } finally {
      await db.exec("reset role");
    }
    assert.equal((await db.query(`
      select remaining_units from public.nh_allowance_pools
      where pool_id = 'dispatch-expiry'
    `)).rows[0].remaining_units, 3);
  });

  await t.test("old reservations cannot refund into a refreshed epoch and dispatched work blocks refresh", async () => {
    for (const poolId of ["epoch-cancel", "epoch-settle", "epoch-reclaim"]) {
      await insertPool(db, { id: poolId, limit: 10, remaining: 10 });
    }
    await db.exec("set role service_role");
    let cancellation;
    let settlement;
    let reclamation;
    try {
      cancellation = await reserve(db, "epoch-cancel", "old-epoch-cancel");
      settlement = await reserve(db, "epoch-settle", "old-epoch-settle");
      reclamation = await reserve(db, "epoch-reclaim", "old-epoch-reclaim", { expiresAt: future(1) });
      assert.equal((await dispatch(db, settlement.reservation_id, uuid())).allowed, true);
    } finally {
      await db.exec("reset role");
    }

    const oldEpochs = (await db.query(`
      select pool_id, allowance_epoch from public.nh_allowance_reservation_items
      where reservation_id in ($1::uuid, $2::uuid, $3::uuid)
      order by pool_id
    `, [cancellation.reservation_id, settlement.reservation_id, reclamation.reservation_id])).rows;
    await assert.rejects(db.query(`
      update public.nh_allowance_pools
      set allowance_epoch = gen_random_uuid(), remaining_units = 10,
          allowance_status = 'verified_available', version = version + 1
      where pool_id = 'epoch-settle'
    `), { code: "55000" });
    await db.exec("set role service_role");
    try {
      assert.equal((await settle(
        db,
        settlement.reservation_id,
        uuid(),
        "completed",
        [{ pool: "epoch-settle", units: 1 }]
      )).allowed, true);
    } finally {
      await db.exec("reset role");
    }
    await db.query(`
      update public.nh_allowance_pools
      set allowance_epoch = gen_random_uuid(), remaining_units = 10,
          allowance_status = 'verified_available', reset_at = $1::timestamptz,
          version = version + 1, updated_at = clock_timestamp()
      where pool_id in ('epoch-cancel', 'epoch-reclaim')
    `, [future(60)]);
    const refreshedEpochs = (await db.query(`
      select pool_id, allowance_epoch, remaining_units
      from public.nh_allowance_pools
      where pool_id in ('epoch-cancel', 'epoch-reclaim')
      order by pool_id
    `)).rows;
    assert.equal(refreshedEpochs.every((row) =>
      row.allowance_epoch !== oldEpochs.find((old) => old.pool_id === row.pool_id).allowance_epoch
        && row.remaining_units === 10
    ), true);

    await db.exec("set role service_role");
    try {
      const staleDispatch = await dispatch(db, cancellation.reservation_id, uuid());
      assert.deepEqual(
        [staleDispatch.allowed, staleDispatch.code, staleDispatch.state],
        [false, "ALLOWANCE_EPOCH_CHANGED", "reserved"]
      );
      assert.equal((await cancel(db, cancellation.reservation_id, uuid())).allowed, true);
      assert.deepEqual(await reconcile(db, new Date(Date.now() + 2 * 60_000).toISOString()), {
        reclaimed_count: 1,
        reconciliation_required_count: 0,
      });
    } finally {
      await db.exec("reset role");
    }

    const after = (await db.query(`
      select pool_id, remaining_units from public.nh_allowance_pools
      where pool_id in ('epoch-cancel', 'epoch-settle', 'epoch-reclaim')
      order by pool_id
    `)).rows;
    assert.deepEqual(after, [
      { pool_id: "epoch-cancel", remaining_units: 10 },
      { pool_id: "epoch-reclaim", remaining_units: 10 },
      { pool_id: "epoch-settle", remaining_units: 9 },
    ]);
  });

  await t.test("reconciliation releases only undispatched work and settlement needs evidence", async () => {
    await insertPool(db, { id: "lifecycle", limit: 10, remaining: 10 });
    await db.exec("set role service_role");
    let reserved;
    let dispatched;
    try {
      reserved = await reserve(db, "lifecycle", "expires-undispatched", { expiresAt: future(1) });
      dispatched = await reserve(db, "lifecycle", "expires-dispatched", { expiresAt: future(1) });
      assert.equal((await dispatch(db, dispatched.reservation_id, uuid())).code, "DISPATCH_RECORDED");
    } finally {
      await db.exec("reset role");
    }

    const afterExpiry = new Date(Date.now() + 2 * 60_000).toISOString();
    await db.exec("set role service_role");
    let reconciliation;
    try {
      reconciliation = await reconcile(db, afterExpiry);
    } finally {
      await db.exec("reset role");
    }
    assert.deepEqual(reconciliation, {
      reclaimed_count: 1,
      reconciliation_required_count: 1,
    });

    const states = (await db.query(`
      select distinct r.reservation_id, r.state, r.reconciliation_reason
      from public.nh_allowance_reservations as r
      join public.nh_allowance_reservation_items as i using (reservation_id)
      where i.pool_id = 'lifecycle'
    `)).rows;
    assert.equal(states.find((row) => row.reservation_id === reserved.reservation_id).state, "reclaimed");
    assert.deepEqual(
      states.find((row) => row.reservation_id === dispatched.reservation_id),
      {
        reservation_id: dispatched.reservation_id,
        state: "reconciliation_required",
        reconciliation_reason: "lease_expired",
      }
    );
    assert.equal((await db.query(`
      select remaining_units from public.nh_allowance_pools where pool_id = 'lifecycle'
    `)).rows[0].remaining_units, 8, "The dispatched reservation remains held");

    await db.exec("set role service_role");
    try {
      const settlement = await settle(
        db,
        dispatched.reservation_id,
        uuid(),
        "completed",
        [{ pool: "lifecycle", units: 1 }]
      );
      assert.equal(settlement.code, "SETTLEMENT_RECORDED");
      assert.equal((await db.query(`
        select remaining_units from public.nh_allowance_pools where pool_id = 'lifecycle'
      `)).rows[0].remaining_units, 9);

      const cancellation = await reserve(db, "lifecycle", "cancel-before-dispatch");
      const cancelled = await cancel(db, cancellation.reservation_id, uuid());
      assert.equal(cancelled.code, "CANCELLED_BEFORE_DISPATCH");
      assert.equal((await db.query(`
        select remaining_units from public.nh_allowance_pools where pool_id = 'lifecycle'
      `)).rows[0].remaining_units, 9);

      const transport = await reserve(db, "lifecycle", "transport-uncertain");
      assert.equal((await dispatch(db, transport.reservation_id, uuid())).allowed, true);
      const marked = await uncertain(db, transport.reservation_id, uuid());
      assert.deepEqual(
        [marked.code, marked.state],
        ["TRANSPORT_UNCERTAIN", "reconciliation_required"]
      );
      assert.equal((await db.query(`
        select remaining_units from public.nh_allowance_pools where pool_id = 'lifecycle'
      `)).rows[0].remaining_units, 7, "Uncertain dispatched work is not refunded");
      const failed = await settle(
        db,
        transport.reservation_id,
        uuid(),
        "failed_after_dispatch",
        [{ pool: "lifecycle", units: 0 }]
      );
      assert.equal(failed.code, "SETTLEMENT_RECORDED");
      assert.equal((await db.query(`
        select remaining_units from public.nh_allowance_pools where pool_id = 'lifecycle'
      `)).rows[0].remaining_units, 9);

      assert.deepEqual(await reconcile(db, afterExpiry), {
        reclaimed_count: 0,
        reconciliation_required_count: 0,
      });
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("service role can use transition RPCs but cannot write ledger tables directly", async () => {
    await insertPool(db, { id: "rpc-only-boundary", limit: 4, remaining: 4 });
    await db.exec("set role service_role");
    try {
      await assert.rejects(db.query(`
        insert into public.nh_allowance_pools (
          pool_id, unit_name, allowance_status, verified_limit_units, remaining_units
        ) values ('forged-pool', 'request_unit', 'verified_available', 5, 5)
      `), { code: "42501" });
      await assert.rejects(db.query(`
        update public.nh_allowance_pools set remaining_units = 4
        where pool_id = 'rpc-only-boundary'
      `), { code: "42501" });
      await assert.rejects(db.query(`
        insert into public.nh_admission_audit (
          event_type, decision_code, actor_id
        ) values ('reservation_denied', 'FORGED_EVENT', 'forged-actor')
      `), { code: "42501" });
      await assert.rejects(db.query(`
        select public.nh_audit_reservation_event(
          gen_random_uuid(), 'reservation_denied', 'FORGED_EVENT', 'forged-actor'
        )
      `), { code: "42501" });

      const allowed = await reserve(db, "rpc-only-boundary", "rpc-boundary-reservation");
      assert.equal(allowed.allowed, true);
      assert.equal(allowed.code, "ALLOWED");
    } finally {
      await db.exec("reset role");
    }
  });

  await t.test("browser roles cannot see tables or invoke admission transitions", async () => {
    await db.exec("set role service_role");
    try {
      assert.equal((await db.query(`
        select public.nh_allowance_store_ready() as ready
      `)).rows[0].ready, true);
    } finally {
      await db.exec("reset role");
    }

    const rowSecurity = (await db.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'nh_allowance_pools',
          'nh_allowance_reservations',
          'nh_allowance_reservation_items',
          'nh_admission_audit'
        )
      order by c.relname
    `)).rows;
    assert.equal(rowSecurity.length, 4);
    assert.equal(rowSecurity.every((row) => row.relrowsecurity && row.relforcerowsecurity), true);

    const tablePrivileges = (await db.query(`
      select role_name, table_name,
        has_table_privilege(role_name, 'public.' || table_name, 'select') as can_select,
        has_table_privilege(role_name, 'public.' || table_name, 'insert') as can_insert
      from (values ('anon'), ('authenticated')) as roles(role_name)
      cross join (values
        ('nh_allowance_pools'),
        ('nh_allowance_reservations'),
        ('nh_allowance_reservation_items'),
        ('nh_admission_audit')
      ) as tables(table_name)
    `)).rows;
    assert.equal(tablePrivileges.every((row) => !row.can_select && !row.can_insert), true);

    const functionPrivileges = (await db.query(`
      select role_name, function_name,
        has_function_privilege(role_name, function_name, 'execute') as can_execute
      from (values ('anon'), ('authenticated')) as roles(role_name)
      cross join (values
        ('public.nh_allowance_requirements_valid(jsonb,boolean)'),
        ('public.nh_merge_allowance_requirements(jsonb,jsonb)'),
        ('public.nh_guard_allowance_epoch_refresh()'),
        ('public.nh_reject_admission_audit_mutation()'),
        ('public.nh_audit_reservation_event(uuid,text,text,text)'),
        ('public.nh_reserve_allowance_bundle(text,text,text,text,text,jsonb,jsonb,timestamp with time zone)'),
        ('public.nh_mark_allowance_dispatched(uuid,uuid,text)'),
        ('public.nh_cancel_allowance_reservation(uuid,uuid,text)'),
        ('public.nh_mark_allowance_reconciliation_required(uuid,uuid,text)'),
        ('public.nh_settle_allowance_reservation(uuid,uuid,text,jsonb,text)'),
        ('public.nh_reconcile_allowance_reservations(timestamp with time zone,text)'),
        ('public.nh_allowance_store_ready()')
      ) as functions(function_name)
    `)).rows;
    assert.equal(functionPrivileges.length, 24);
    assert.equal(functionPrivileges.every((row) => !row.can_execute), true);

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(
          db.query("select * from public.nh_allowance_pools"),
          { code: "42501" }
        );
        await assert.rejects(
          reserve(db, "unknown-pool", `${role}-attempt`, { actor: role }),
          { code: "42501" }
        );
        await assert.rejects(
          reconcile(db, future(), role),
          { code: "42501" }
        );
        await assert.rejects(
          db.query("select public.nh_allowance_store_ready()"),
          { code: "42501" }
        );
      } finally {
        await db.exec("reset role");
      }
    }

    const auditId = (await db.query(`
      select audit_id from public.nh_admission_audit order by audit_id limit 1
    `)).rows[0].audit_id;
    await assert.rejects(
      db.query("update public.nh_admission_audit set actor_id = 'changed' where audit_id = $1", [auditId]),
      { code: "42501" }
    );

    await db.exec("set role service_role");
    try {
      await assert.rejects(
        db.query("delete from public.nh_admission_audit where audit_id = $1", [auditId]),
        { code: "42501" }
      );
    } finally {
      await db.exec("reset role");
    }
  });
});
