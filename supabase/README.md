# Supabase readiness

Read-only inspection on 2026-09-07 found the connected project `Neurohands` (`darxiaearohhnxiwhcbs`) running an older schema. Its public tables are `clients`, `glass_types`, `edging_services`, `orders`, `production_queue`, `messages`, `scores`, and `settings`. Row Level Security is enabled on those tables. No database writes, migrations, Auth configuration changes, or Storage changes were performed.

The recovered server directly references 22 tables. These 16 were absent:

```text
activation_codes       agent_memory          agent_registry
agent_runs             agent_tasks           bot_feedback
client_accounts        client_agent_bindings client_documents
escalations            jarvis_audit_log      jarvis_checklist
jarvis_notes           staff_activations     support_cases
tool_calls
```

Existing tables also lack columns used by this version. Confirmed examples are `clients.client_account_id` and `orders.client_account_id`, `orders.lead_time_days`, and `orders.urgent_flag`. Other columns, constraints, relationships, default values, seed records, grants, and indexes still need a full schema comparison.

`check-readiness.sql` checks the directly referenced table names, the confirmed missing columns above, and the document bucket. It is a read-only diagnostic, not a migration or a complete readiness certificate. No returned rows from its first query would only mean those listed checks pass.

The v3.10 MASTER SQL mentioned in the original README has not been recovered. The Downloads folder contains a v2.2 SQL file and a v2.4 deployment document; neither establishes the complete v3.10 schema. They were not applied or substituted for the missing migration.

Before deployment, recover or create a reviewed migration that preserves existing product and message data, defines account ownership and binding rules, enables RLS on exposed tables, and installs the required agent/configuration records. Set up a private `neurohands-docs` Storage bucket and validate ownership checks for upload links and document reads. The recovered upload-token implementation assumes positive integer client account IDs; schema decisions must account for that or update the code.

The bot uses a privileged server key that bypasses RLS, so authorization in the gateway still matters even when RLS is enabled. Keep the secret key on Railway/the server. Supabase Auth user login remains a separate feature requiring its intended user flow and access rules to be defined.

Reference: [Supabase API key roles and security](https://supabase.com/docs/guides/getting-started/api-keys).
