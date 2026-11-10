# Independent offline harness review

Reviewed `checkout/scripts/measure-line-adaptation.py` and its tests against the
evaluation design. **Changes required before relying on acceptance output.**

- **P1 — critical bypass:** `hard_gates=[]` plus a critical failure returns
  `pilot_fraction_target_met_in_this_campaign=true`. Require exactly the four
  known gates, nonempty critical inventories and valid case/gate membership.
- **P1 — stale oracle:** changing a case's expected outcome while retaining
  campaign ID/source revision accepts the original receipt. Bind receipts to a
  canonical campaign digest covering cases, oracles, targets and versions.
- **P2 — reviewer evidence:** an unregistered reviewer alias passes. Require
  approved actor identities, assigned independent reviewer and review receipt;
  distinct role strings alone cannot establish independent actors.
- **P2 — environment claim:** `environment=live` is accepted without versions,
  approval or runtime proof. Require stage-specific evidence or label it asserted.
- **P2 — tracker validation:** `state=accepted`, `scope=live`,
  `attempts_used=999`, `evidence=[]` is accepted. Validate states, limits, scope
  and stage-specific acceptance evidence.

Verification: `python -B -m unittest discover -s scripts/tests -p
test_line_adaptation.py -v` passed 10/10; five synthetic adversarial probes
reproduced the findings. Existing missing/duplicate-result and hash checks work.
Savings correctly remain null. These checks establish offline harness behavior,
not task quality, live reliability or 95-99% achievement.

## Second review — corrected candidate

Sixteen offline unit tests passed. Against the actual tracker and upgraded
synthetic receipts, all five original bypasses now reject: missing gates,
unregistered reviewer, changed oracle, unsupported live label and invalid
accepted task/attempt count.

**Residual P1 — acceptance policy is not frozen.** `campaign_digest()` excludes
`targets`. With one failed workflow case, a receipt scores false at a frozen
`pilot_fraction=0.99`. Changing only that target to `0.95` makes the same receipt
score true; both values pass validation. Include acceptance targets in the digest
and require re-freezing/reapproval after changes. Until resolved, treat the
receipt-acceptance prototype as blocked; planning artifacts remain unmeasured.

README, role cards and scoped skill retain appropriate privacy, authority,
engineering/runtime and bounded-retry limits. Their seven roles do not claim
seven deployed agents. Registered actor strings and hashed files validate
declarations and file integrity; they do not authenticate people, prove approval
authority or verify evidence semantics. The README states this limit.

No app/model tests, inference or production actions ran. These results establish
offline validator behavior only, not live quality, efficiency or 95-99% attainment.

## LA-03B — targeted policy-digest recheck

**Pass for structural validation only.** Using the current actual tracker and a
synthetic receipt, changing the frozen pilot target from `0.99` to `0.95` now
rejects the old receipt with a digest mismatch. Changing feature runtime scope
also rejects the old receipt. The actual plan still reports null workflow
performance without execution receipts. The five earlier corrected-probe
outcomes remain recorded above; they were not rerun in this targeted check.

The previously reported policy-digest finding is resolved in this reviewed
candidate. LA-03B may close as `verified_local` for this structural correction.
Historical findings and LA-03's bounded attempts remain preserved.

Actor registration, approvals and evidence semantics still require independent
human verification; file hashes do not authenticate them. All 60 behavioral
cases remain **NOT_RUN**. No runtime quality, integration, live authority,
efficiency improvement or 95-99% achievement is established.
