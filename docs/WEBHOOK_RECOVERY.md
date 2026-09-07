# LINE intake and recovery

## Verified behavior

The signed raw request is validated, each event payload is encrypted with AES-256-GCM, and a database transaction saves the batch before HTTP 200 is returned. A database outage returns a non-2xx response. LINE webhook verification with an empty event array needs no queue write.

`webhookEventId` is the deduplication key. Redelivery cannot overwrite the first encrypted payload or run completed, failed or uncertain work again. New events remain `received` until a worker claims them; they can be claimed after a process restart. One worker processes each source at a time. Worker leases renew every 25 seconds and expire after 90 seconds. These intervals are operating defaults, not measured capacity guarantees.

On success the queue clears the encrypted payload. Failed work retains encrypted input for review. If a worker disappears after claiming work, the expired event becomes `uncertain`; external effects might already have occurred. Neither failed nor uncertain events replay automatically. This avoids blindly repeating a reply, task, activation or approved operation. It does not guarantee exactly-once effects across external services.

The worker's event ID is attached to `agent_runs.webhook_event_id`; tool calls link through the run ID. A returned error message can be successfully delivered while its agent run and queue event are still marked failed. Jarvis's `events` command lists recent failed/uncertain events for an authorized operator. The queue reports handler completion; inspect run and delivery evidence for the business outcome.

## Configuration and readiness

- Set `WEBHOOK_ENCRYPTION_KEY` privately in Railway to a cryptographically random 32-byte value encoded as base64. Keep it stable across deployments and include it in a private operational backup. Losing it prevents decryption of outstanding events. Do not put its value in GitHub or reports.
- Apply only the reviewed Phase 1 migrations. The queue migration is `20260907130303_phase1_webhook_inbox.sql`, recorded remotely as `phase1_webhook_inbox`.
- Railway uses `/ready`. It verifies required configuration, access to KNC/Aria/queue tables and a private document bucket. It does not call the model or LINE, so a real messaging test is still required.
- `/version` returns the application version and Railway's deployed Git commit when provided. `/` confirms only that the HTTP process responds.
- Verify the intended LINE channel and enable webhook redelivery in its developer console after deployment. LINE redelivery is disabled by default, can arrive out of order, and is not guaranteed. Database acknowledgment prevents loss after successful acceptance; it cannot guarantee delivery of events that never reached the app.

## Incident procedure

1. Inspect the event ID, status and lease, linked agent runs, tool calls, document records and LINE delivery evidence. Keep payloads and identifiers in authorized private systems.
2. For `received`, restore the worker configuration and connectivity. It can claim the saved event normally.
3. For `failed` or `uncertain`, determine what already happened. Do not reset its status, delete the deduplication row or send the same command automatically. Resolve incomplete operations individually after checking receipts. Request a fresh client message only once duplicate business effects are ruled out.
4. Preserve the encryption key during rollback. Keep the additive queue table and run-link column. Stop workers before any planned data restoration; never restore over an active database merely to roll back source code.

SIGTERM stops further claims and allows up to 20 seconds to finish current work and requests. Work interrupted after that window becomes uncertain when its lease expires. There is no automatic failed-event purge or replay endpoint in this milestone; retention and operator-approved recovery remain operational responsibilities.

## Evidence and limits

Local HTTP tests prove acknowledgment waits for the database receipt and rejects missing receipts or database failures. Isolated PostgreSQL tests cover atomic batches, deduplication, restart before claim, encryption binding, wrong keys, worker/source exclusion, failed/uncertain recovery and browser-role denial. PGlite serializes database connections; multi-instance load testing is not claimed. Live Supabase permissions and a rolled-back service-role queue transaction were also checked. This is not a live LINE delivery or deployment proof.

Source: [LINE receiving messages and redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/).
