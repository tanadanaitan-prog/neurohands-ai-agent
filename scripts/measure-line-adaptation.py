"""Read-only planning/receipt scorecard. It neither runs agents nor grants tools."""
import argparse
import hashlib
import json
import math
from pathlib import Path

STATUSES = {'pass', 'fail', 'blocked', 'not_run'}
REQUIRED_GATES = {'G_PRIVACY', 'G_AUTHORITY', 'G_TENANT_ISOLATION', 'G_NO_DUPLICATE_EFFECTS'}
TASK_STATES = {'proposed', 'planned', 'ready', 'in_progress', 'in_review', 'verified_local',
               'awaiting_adoption', 'accepted', 'blocked', 'failed', 'cancelled', 'superseded'}


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def campaign_digest(plan):
    frozen = {'campaign': {k: plan['campaign'][k] for k in ('id', 'source_revision', 'cases', 'contract_versions')},
              'actors': plan['actors'], 'hard_gates': sorted(plan['hard_gates']),
              'targets': plan['targets'], 'features': plan['features']}
    return hashlib.sha256(json.dumps(frozen, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def check_evidence(artifacts, evidence_root):
    if evidence_root is None or not artifacts:
        raise ValueError('Executed result needs inspectable evidence')
    root = Path(evidence_root).resolve()
    for artifact in artifacts:
        path = (root / artifact['path']).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Evidence path missing or outside approved root')
        if hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
            raise ValueError('Evidence hash mismatch')


def validate_plan(plan, evidence_root=None):
    roles = {r['id'] for r in plan['roles']}
    actors = {a['id']: a for a in plan['actors']}
    features = {f['id'] for f in plan['features']}
    tasks = {t['id']: t for t in plan['tasks']}
    cases = {c['id']: c for c in plan['campaign']['cases']}
    if len(roles) != len(plan['roles']) or len(actors) != len(plan['actors']) or not actors:
        raise ValueError('Missing or duplicate role/actor registration')
    if set(plan['hard_gates']) != REQUIRED_GATES or len(plan['hard_gates']) != 4:
        raise ValueError('All four critical hard gates are required')
    if len(features) != len(plan['features']):
        raise ValueError('Duplicate feature ID')
    pilot = plan['targets']['pilot_fraction']
    if not finite_number(pilot) or not .95 <= pilot <= .99:
        raise ValueError('Pilot target must retain the declared 95-99 percent range')
    if not plan['campaign']['contract_versions']:
        raise ValueError('Frozen contract versions required')
    for actor in actors.values():
        if not actor['roles'] or not set(actor['roles']) <= roles:
            raise ValueError('Unregistered actor role')
    if len(tasks) != len(plan['tasks']) or len(cases) != len(plan['campaign']['cases']):
        raise ValueError('Duplicate work-item or case ID')
    for task in tasks.values():
        if task['owner'] not in roles or task['reviewer'] not in roles or task['owner'] == task['reviewer']:
            raise ValueError('Missing or non-independent work-item reviewer')
        if any(d not in tasks for d in task['dependencies']):
            raise ValueError('Unknown dependency')
        if task['attempt_limit'] != 2:
            raise ValueError('Unreviewed attempt limit')
        used = task['attempts_used']
        if isinstance(used, bool) or not isinstance(used, int) or not 0 <= used <= task['attempt_limit']:
            raise ValueError('Work-item attempt limit exceeded or invalid')
        if task['state'] not in TASK_STATES:
            raise ValueError('Unknown work-item state')
        if task['state'] in {'verified_local', 'accepted'} and not task.get('evidence'):
            raise ValueError('Verified/accepted work item lacks evidence references')
        if task['state'] == 'accepted':
            scope = task.get('acceptance_scope')
            approval = task.get('approval') or {}
            if scope not in {'local_only', 'sandbox', 'live'}:
                raise ValueError('Accepted work item needs explicit acceptance scope')
            if not approval.get('actor') or approval['actor'] not in actors or approval.get('scope') != scope:
                raise ValueError('Accepted work item lacks matching approval')
            producer, reviewer = task.get('implemented_by'), task.get('reviewed_by')
            if producer not in actors or reviewer not in actors or producer == reviewer or 'qa' not in actors[reviewer]['roles']:
                raise ValueError('Accepted work item needs independent registered QA')
            if approval.get('source_revision') != task.get('source_revision') or not task.get('source_revision'):
                raise ValueError('Accepted work item approval needs matching source revision')
            check_evidence(task['evidence'], evidence_root)
            if scope != 'local_only' and ('operator' not in actors[approval['actor']]['roles'] or not task.get('runtime_evidence')):
                raise ValueError('Sandbox/live work acceptance needs operator and runtime evidence')
            if scope != 'local_only':
                check_evidence(task['runtime_evidence'], evidence_root)
        if any(f not in features for f in task['features']):
            raise ValueError('Unknown feature reference')
    visiting, visited = set(), set()
    def visit(item):
        if item in visiting:
            raise ValueError('Dependency cycle')
        if item in visited:
            return
        visiting.add(item)
        for dep in tasks[item]['dependencies']:
            visit(dep)
        visiting.remove(item)
        visited.add(item)
    for item in tasks:
        visit(item)
    for feature in plan['features']:
        if feature['support'] in {'consumer_only', 'manual_oa', 'unverified'} and feature['runtime_access'] == 'enabled':
            raise ValueError('Unsupported/manual capability cannot be declared enabled')
    if any(c['metric'] not in {'contract', 'workflow', 'critical'} for c in cases.values()):
        raise ValueError('Unknown measurement type')
    for gate in REQUIRED_GATES:
        if not any(c['metric'] == 'critical' and c.get('gate') == gate for c in cases.values()):
            raise ValueError('Each hard gate needs frozen critical cases')
    if any(c.get('gate') not in REQUIRED_GATES for c in cases.values() if c['metric'] == 'critical'):
        raise ValueError('Unregistered critical gate')
    return cases


def score(plan, receipt=None, evidence_root=None):
    cases = validate_plan(plan, evidence_root)
    entries, resources = {}, None
    if receipt is not None:
        if receipt['campaign_id'] != plan['campaign']['id']:
            raise ValueError('Campaign mismatch')
        if receipt['source_revision'] != plan['campaign']['source_revision']:
            raise ValueError('Stale/different source revision; freeze a new campaign')
        if receipt.get('campaign_sha256') != campaign_digest(plan):
            raise ValueError('Frozen campaign/oracle digest mismatch')
        if receipt.get('contract_versions') != plan['campaign']['contract_versions']:
            raise ValueError('Receipt contract versions mismatch')
        if receipt['environment'] not in {'offline_fixture', 'sandbox', 'live'}:
            raise ValueError('Unknown evidence environment')
        actors = {a['id']: a for a in plan['actors']}
        if receipt['environment'] != 'offline_fixture':
            approval = receipt.get('approval') or {}
            if approval.get('actor') not in actors or 'operator' not in actors[approval['actor']]['roles']:
                raise ValueError('Sandbox/live receipt needs registered operator approval')
            if approval.get('scope') != receipt['environment'] or approval.get('campaign_sha256') != campaign_digest(plan):
                raise ValueError('Runtime approval scope/digest mismatch')
            check_evidence(receipt.get('runtime_evidence'), evidence_root)
        for row in receipt['results']:
            key = row['case_id']
            if key not in cases or key in entries or row['status'] not in STATUSES:
                raise ValueError('Unknown, duplicated or invalid case result')
            if row['status'] in {'pass', 'fail'}:
                if row.get('producer') not in actors or row.get('reviewer') not in actors or row['producer'] == row['reviewer']:
                    raise ValueError('Case result needs independent review')
                if 'qa' not in actors[row['reviewer']]['roles']:
                    raise ValueError('Case reviewer is not registered for QA')
                check_evidence(row.get('evidence'), evidence_root)
            entries[key] = row
        resources = receipt.get('resources')
        if resources is not None:
            if resources.get('includes_failed_attempts_retries_review') is not True:
                raise ValueError('Resource totals must include failed attempts, retries and review')
            for key in ('model_tokens', 'tool_calls', 'elapsed_seconds', 'billed_cost'):
                if resources.get(key) is not None and not finite_number(resources[key]):
                    raise ValueError('Invalid resource total')
    results = {}
    for metric in ('contract', 'workflow', 'critical'):
        selected = [key for key, c in cases.items() if c['metric'] == metric]
        counts = {s: 0 for s in STATUSES}
        for key in selected:
            counts[entries.get(key, {}).get('status', 'not_run')] += 1
        executed = counts['pass'] + counts['fail']
        results[metric] = {'planned': len(selected), 'executed': executed, **counts,
                           'execution_coverage': executed / len(selected) if selected else None,
                           'pass_fraction_all_planned': counts['pass'] / len(selected) if executed and selected else None,
                           'conditional_pass_fraction_executed': counts['pass'] / executed if executed else None}
    gate_results = {}
    for gate in plan['hard_gates']:
        ids = [key for key, c in cases.items() if c.get('gate') == gate]
        gate_results[gate] = bool(ids) and all(entries.get(key, {}).get('status') == 'pass' for key in ids)
    all_executed = all(entries.get(key, {}).get('status') in {'pass', 'fail'} for key in cases)
    all_gates = all(gate_results.values())
    fractions = [results[m]['pass_fraction_all_planned'] for m in ('contract', 'workflow')]
    local_target = all_executed and all_gates and all(v is not None and v >= plan['targets']['pilot_fraction'] for v in fractions)
    accepted = results['workflow']['pass']
    efficiency = {key: resources.get(key) / accepted if resources and resources.get(key) is not None and accepted else None
                  for key in ('model_tokens', 'tool_calls', 'elapsed_seconds', 'billed_cost')}
    return {'scope': 'receipt-backed scorecard; not independent proof of the receipt assertions',
            'campaign_sha256': campaign_digest(plan),
            'environment': receipt['environment'] if receipt else 'not_run',
            'metrics': results, 'hard_gates': gate_results,
            'pilot_fraction_target_met_in_this_campaign': local_target,
            'live_reliability_target_established': False,
            'efficiency_per_accepted_workflow': efficiency,
            'efficiency_improvement_claim': None,
            'note': 'No population reliability claim or savings is inferred; use representative qualification and paired baseline evidence.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', default='docs/line-adaptation/TRACKER.json')
    parser.add_argument('--results')
    parser.add_argument('--evidence-root')
    parser.add_argument('--output')
    args = parser.parse_args()
    report = score(load(args.plan), load(args.results) if args.results else None, args.evidence_root)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        output = Path(args.output).resolve()
        allowed = (Path(__file__).resolve().parents[1] / 'outputs').resolve()
        if not output.is_relative_to(allowed):
            raise ValueError('Output must stay in this checkout outputs directory')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text + '\n', encoding='utf-8')
    print(text)


if __name__ == '__main__':
    main()
