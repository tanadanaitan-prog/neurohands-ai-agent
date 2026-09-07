// Restore the captured legacy public schema into isolated PostgreSQL, never a live URL.
// The snapshot and generated restore SQL contain private business data: keep outside Git.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const identifier = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

function schemaSql(snapshot) {
  for (const feature of ['enums', 'functions', 'triggers', 'policies']) {
    if (snapshot[feature]?.length) throw new Error(`This legacy recovery verifier does not implement ${feature}`);
  }
  const statements = ['set standard_conforming_strings = on;', "set timezone = 'UTC';"];
  for (const table of snapshot.tables) {
    const columns = snapshot.columns.filter(c => c.table === table.name).sort((a,b) => a.position - b.position);
    statements.push(`create table public.${identifier(table.name)} (\n${columns.map(c => {
      if (c.generated) throw new Error('Generated column recovery needs review');
      return '  ' + identifier(c.name) + ' ' + c.type
        + (c.identity ? ` generated ${c.identity === 'a' ? 'always' : 'by default'} as identity` : c.default ? ' default ' + c.default : '')
        + (c.not_null ? ' not null' : '');
    }).join(',\n')}\n);`);
  }
  for (const constraint of [...snapshot.constraints].sort((a,b) => (a.kind === 'f') - (b.kind === 'f'))) {
    statements.push(`alter table public.${identifier(constraint.table)} add constraint ${identifier(constraint.name)} ${constraint.definition};`);
  }
  const constraintNames = new Set(snapshot.constraints.map(c => c.name));
  for (const index of snapshot.indexes || []) if (!constraintNames.has(index.indexname)) statements.push(index.indexdef + ';');
  for (const table of snapshot.tables) {
    if (table.rls) statements.push(`alter table public.${identifier(table.name)} enable row level security;`);
    if (table.force_rls) statements.push(`alter table public.${identifier(table.name)} force row level security;`);
  }
  for (const grant of snapshot.grants || []) {
    statements.push(`grant ${grant.privilege_type} on table public.${identifier(grant.table_name)} to ${identifier(grant.grantee)}${grant.is_grantable === 'YES' ? ' with grant option' : ''};`);
  }
  return statements.join('\n\n') + '\n';
}

async function verifyBackup(snapshotPath, sequencePath, outputDirectory) {
  const snapshotBytes = fs.readFileSync(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes);
  const sequences = JSON.parse(fs.readFileSync(sequencePath, 'utf8'));
  const database = new PGlite();
  const schema = schemaSql(snapshot);
  const restore = [schema];
  const results = [];
  try {
    await database.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
    await database.exec(schema);
    // Topological insert order follows the verified legacy foreign keys.
    const order = ['clients','glass_types','edging_services','orders','production_queue','messages','scores','settings'];
    if (Object.keys(snapshot.data_json).some(table => !order.includes(table))) throw new Error('Unexpected table: review restore order');
    for (const table of order) {
      const raw = snapshot.data_json[table];
      const sql = `insert into public.${identifier(table)} overriding system value select * from jsonb_populate_recordset(null::public.${identifier(table)}, $1::jsonb)`;
      await database.query(sql, [raw]);
      restore.push(sql.replace('$1', literal(raw)) + ';');
      const proof = (await database.query(`select
        (select coalesce(jsonb_agg(v order by v::text), '[]'::jsonb) from jsonb_array_elements($1::jsonb) v)
        = (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) from public.${identifier(table)} t) as exact,
        (select count(*) from public.${identifier(table)})::int as rows`, [raw])).rows[0];
      if (!proof.exact) throw new Error(`Restored values differ: ${table}`);
      results.push({table, ...proof});
    }
    for (const sequence of snapshot.sequences) {
      const state = sequences[sequence.sequencename];
      if (!state) throw new Error('Missing exact sequence state');
      const qualified = `public.${identifier(sequence.sequencename)}`;
      const sql = `select pg_catalog.setval(${literal(qualified)}::regclass, ${literal(state.last_value)}::bigint, ${state.is_called ? 'true' : 'false'});`;
      await database.exec(sql);
      const actual = (await database.query(`select last_value::text as last_value, is_called from ${qualified}`)).rows[0];
      if (actual.last_value !== state.last_value || actual.is_called !== state.is_called) throw new Error('Sequence restore mismatch');
      restore.push(sql);
    }
    const proof = { project: snapshot.project, capturedAt: snapshot.captured_at, verifiedAt: new Date().toISOString(), snapshotSha256: crypto.createHash('sha256').update(snapshotBytes).digest('hex'), tables: results, sequencesVerified: snapshot.sequences.length,
      scope: 'Public legacy table definitions, constraints, indexes, table grants, RLS flags and rows; sequence state separately captured. This is not a complete Supabase project backup. Platform Auth, roles, project settings, deployment configuration and Storage bytes are not restored.' };
    fs.mkdirSync(outputDirectory, {recursive:true});
    fs.writeFileSync(path.join(outputDirectory,'public-restore.sql'), restore.join('\n\n'));
    fs.writeFileSync(path.join(outputDirectory,'restore-proof.json'), JSON.stringify(proof,null,2));
    return proof;
  } finally { await database.close(); }
}

if (require.main === module) {
  const [snapshot, sequences, destination] = process.argv.slice(2);
  if (!snapshot || !sequences || !destination) throw new Error('Usage: node scripts/verify-public-backup.js <private-snapshot.json> <sequence-state.json> <private-output-folder>');
  verifyBackup(snapshot, sequences, destination).then(result => console.log(JSON.stringify(result,null,2))).catch(error => { console.error(error.message); process.exitCode=1; });
}
module.exports = {schemaSql, verifyBackup};
