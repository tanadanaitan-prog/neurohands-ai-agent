# Assigned work and next owners

Recorded 2026-11-10. This readable view accompanies [TRACKER.json](TRACKER.json).
`verified_local` means the named research/structural artifact was reviewed; it
does not mean a customer workflow was accepted or deployed.

| Work item | Owner / reviewer | State and next action |
| --- | --- | --- |
| LA-01: reconcile source and versions | Researcher / QA | Verified locally; preserve source hash, contradictions and unknowns. |
| LA-02: map LINE, code and assets | Architect / QA | Verified locally; 27 features mapped; mobile appearance still untested. |
| LA-03: initial scorecard prototype | Implementer / QA | Superseded after two bounded attempts; preserve failed probes. |
| LA-03B: freeze targets and feature scope | Implementer / QA | Verified locally by targeted recheck; 17 safeguard tests pass. |
| LA-04: reproduce P0 behavior | Implementer / QA | Next: synthetic provider-after-tool/slow-answer, ownership and extraction reproductions. Freeze exact source and oracles first. |
| LA-05: outbound messages and controls | Implementer / QA | Proposed after LA-04; typed builders, permitted actions and mobile review. |
| LA-06: inbound media and private gallery | Implementer / QA | Proposed after LA-04; owner, format, quota, retention and real storage receipt. |
| LA-07: calendar/booking backend | Architect / operator | Blocked on a service/account and approved scopes/cost boundary; no native LINE Calendar CRUD established. |
| LA-08: published definition to runtime | Implementer / QA | Proposed after LA-04; reviewed registry, schemas and actual binding proof. |
| LA-09: frozen discovery and paired baseline | QA / efficiency reviewer | Planned after LA-05 to LA-08; all 60 behavioral cases currently NOT_RUN. |
| LA-10: pilot and any release decision | Operator / QA | Proposed after LA-09; specific independent acceptance and adoption approval required. |

## Current iteration and measurement

1. Source review corrected the 13-versus-14 frontline-tool count and separated
   official LINE support from manual or external-service features.
2. Ten initial tests passed, but independent adversarial review found five
   false-pass paths. The next attempt rejected all five; QA then found that
   changing the target could reuse an old receipt.
3. LA-03 stopped at its attempt limit. Bounded follow-on LA-03B bound acceptance
   targets and feature scope into the campaign digest. Its independent recheck
   rejects both changes; the local unit suite now passes 17 tests.
4. Contract success, real task quality and resources per accepted task remain
   unmeasured until the frozen behavioral campaign executes. No percentage or
   token savings is claimed. Inspect [the measurement rules](MEASUREMENT.md).

## Resume without repeating exploration

Use the [roles and return packet](ROLES.md), then assign only LA-04 with the
exact allowed files, deterministic fixtures, expected failure, budget and
independent reviewer. Avoid a multi-feature implementation until the P0 evidence
is reviewed. Update the tracker with real receipts, preserve failed attempts and
replan only the affected unit. Existing PR21/main/production and Sineid holds
remain in force. This plan does not authorize a live test, new account or spend.
