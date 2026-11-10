import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scorecard', Path(__file__).parents[1] / 'measure-line-adaptation.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MeasurementRules(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'proof.txt').write_text('synthetic observed outcome', encoding='utf-8')
        self.evidence = [{'path': 'proof.txt', 'sha256': hashlib.sha256((self.root/'proof.txt').read_bytes()).hexdigest()}]
        self.plan = {'roles': [{'id': 'writer'}, {'id': 'qa'}, {'id': 'operator'}],
                     'actors': [{'id':'writer','roles':['writer']}, {'id':'qa','roles':['qa']}, {'id':'operator','roles':['operator']}],
                     'features': [{'id': 'F', 'support': 'supported_api', 'runtime_access': 'planned'}],
                     'tasks': [{'id': 'T', 'owner': 'writer', 'reviewer': 'qa', 'dependencies': [], 'attempt_limit': 2, 'attempts_used':0,'state':'planned','features': ['F']}],
                     'campaign': {'id': 'C', 'source_revision': 'frozen', 'contract_versions':{'schema':1},'cases': [
                         {'id': 'C1', 'metric': 'contract'}, {'id': 'W1', 'metric': 'workflow'}]+[
                         {'id':f'S{i}','metric':'critical','gate':gate} for i,gate in enumerate(sorted(module.REQUIRED_GATES),1)]},
                     'hard_gates': sorted(module.REQUIRED_GATES), 'targets': {'pilot_fraction': .95}}
        self.receipt = {'campaign_id': 'C', 'source_revision': 'frozen', 'environment': 'offline_fixture',
                        'campaign_sha256':module.campaign_digest(self.plan),'contract_versions':{'schema':1},
                        'results': [self.result(c['id']) for c in self.plan['campaign']['cases']]}

    def result(self, key, status='pass'):
        return {'case_id': key, 'status': status, 'producer': 'writer', 'reviewer': 'qa', 'evidence': copy.deepcopy(self.evidence)}

    def test_empty_evidence_has_no_percentage_or_savings(self):
        r = module.score(self.plan)
        self.assertIsNone(r['metrics']['workflow']['pass_fraction_all_planned'])
        self.assertFalse(r['pilot_fraction_target_met_in_this_campaign'])
        self.assertIsNone(r['efficiency_per_accepted_workflow']['model_tokens'])

    def test_local_pass_is_not_live_reliability(self):
        r = module.score(self.plan, self.receipt, self.root)
        self.assertTrue(r['pilot_fraction_target_met_in_this_campaign'])
        self.assertFalse(r['live_reliability_target_established'])

    def test_critical_failure_blocks_high_average(self):
        self.receipt['results'][-1]['status'] = 'fail'
        self.assertFalse(module.score(self.plan, self.receipt, self.root)['pilot_fraction_target_met_in_this_campaign'])

    def test_missing_case_is_not_removed_from_denominator(self):
        self.receipt['results'] = self.receipt['results'][:1]
        r = module.score(self.plan, self.receipt, self.root)
        self.assertEqual(r['metrics']['workflow']['not_run'], 1)
        self.assertFalse(r['pilot_fraction_target_met_in_this_campaign'])

    def test_duplicate_result_rejected(self):
        self.receipt['results'].append(self.result('C1'))
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            module.score(self.plan, self.receipt, self.root)

    def test_self_review_and_fabricated_hash_rejected(self):
        self.receipt['results'][0]['reviewer'] = 'writer'
        with self.assertRaisesRegex(ValueError, 'independent'):
            module.score(self.plan, self.receipt, self.root)
        self.receipt['results'][0]['reviewer'] = 'qa'
        self.receipt['results'][0]['evidence'][0]['sha256'] = 'bad'
        with self.assertRaisesRegex(ValueError, 'hash'):
            module.score(self.plan, self.receipt, self.root)

    def test_stale_campaign_rejected(self):
        self.receipt['source_revision'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'Stale'):
            module.score(self.plan, self.receipt, self.root)

    def test_consumer_feature_cannot_be_declared_enabled(self):
        self.plan['features'][0].update(support='consumer_only', runtime_access='enabled')
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            module.score(self.plan)

    def test_costs_include_failed_rework_and_remain_unclaimed(self):
        self.receipt['resources'] = {'includes_failed_attempts_retries_review': True, 'model_tokens': 120, 'tool_calls': 6}
        r = module.score(self.plan, self.receipt, self.root)
        self.assertEqual(r['efficiency_per_accepted_workflow']['model_tokens'], 120)
        self.assertIsNone(r['efficiency_improvement_claim'])
        self.receipt['resources']['includes_failed_attempts_retries_review'] = False
        with self.assertRaisesRegex(ValueError, 'include'):
            module.score(self.plan, self.receipt, self.root)

    def test_cyclic_handoff_dependency_rejected(self):
        self.plan['tasks'][0]['dependencies'] = ['T']
        with self.assertRaisesRegex(ValueError, 'cycle'):
            module.score(self.plan)

    def test_removing_hard_gates_cannot_create_vacuous_pass(self):
        self.plan['hard_gates'] = []
        with self.assertRaisesRegex(ValueError, 'hard gates'):
            module.score(self.plan, self.receipt, self.root)

    def test_changed_oracle_rejects_previous_receipt(self):
        self.plan['campaign']['cases'][0]['expected'] = 'changed after results'
        with self.assertRaisesRegex(ValueError, 'digest'):
            module.score(self.plan, self.receipt, self.root)

    def test_changed_target_or_feature_scope_requires_new_campaign_digest(self):
        self.plan['targets']['pilot_fraction'] = .99
        with self.assertRaisesRegex(ValueError, 'digest'):
            module.score(self.plan, self.receipt, self.root)
        self.plan['targets']['pilot_fraction'] = .95
        self.plan['features'][0]['runtime_access'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'digest'):
            module.score(self.plan, self.receipt, self.root)

    def test_unregistered_reviewer_alias_is_not_independence(self):
        self.receipt['results'][0]['reviewer'] = 'writer-other-name'
        with self.assertRaisesRegex(ValueError, 'independent'):
            module.score(self.plan, self.receipt, self.root)

    def test_live_label_without_operator_and_receipts_rejected(self):
        self.receipt['environment'] = 'live'
        with self.assertRaisesRegex(ValueError, 'operator'):
            module.score(self.plan, self.receipt, self.root)

    def test_accepted_task_without_evidence_and_excess_attempts_rejected(self):
        task = self.plan['tasks'][0]
        task.update(state='accepted', acceptance_scope='live', evidence=[], attempts_used=999)
        with self.assertRaisesRegex(ValueError, 'attempt'):
            module.score(self.plan)
        task['attempts_used'] = 1
        with self.assertRaisesRegex(ValueError, 'evidence'):
            module.score(self.plan)

    def test_changed_contract_versions_and_weakened_target_rejected(self):
        self.receipt['contract_versions'] = {'schema':2}
        with self.assertRaisesRegex(ValueError, 'versions'):
            module.score(self.plan, self.receipt, self.root)
        self.plan['targets']['pilot_fraction'] = .1
        with self.assertRaisesRegex(ValueError, '95-99'):
            module.score(self.plan)


if __name__ == '__main__':
    unittest.main()
