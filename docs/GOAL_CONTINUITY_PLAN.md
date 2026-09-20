# Neurohands goal continuity plan and completion estimate

**Goal revision:** `NH-GOAL-2026-09-20.1`  
**Plan revision:** `NH-PLAN-2026-09-20.1`  
**Status:** estimate approved for review; implementation has not started  
**Prepared:** 20 September 2026, Asia/Bangkok

## Main goal

Build Neurohands as a human-led, secure, permissioned AI workforce that delivers verified business outcomes under founder control.

This goal is unchanged. A new instruction revises the plan unless the founder explicitly replaces the main goal. Every replaced decision keeps its history and reason.

## Current milestone

Prove correct KNC company/service answers, role routing, tenant isolation, and real LINE customer outcomes before wider agent, team, department, or organization expansion.

## Current assignment

Qualify a read-only architect and add a goal-continuity layer that preserves valid work while safely revising the affected plan.

## New requirement

Every task start, resumed session, material instruction, and specialist handoff must reconcile:

- goal and plan versions;
- completed work and evidence;
- the current task and owner;
- unresolved problems and dependencies;
- new changes and their impact;
- affected tests;
- permissions and budget; and
- the next bounded action.

Existing work must be classified as **keep**, **modify**, **add**, **revalidate**, **defer**, or **supersede**. Historical evidence remains attached to the version and conditions tested.

## Preserved progress

- The production LINE, Railway, Supabase, and Gemini pilot remains separate from the local LangGraph/Ollama laboratory.
- Existing commits, tests, benchmark artifacts, release controls, and the consolidated project history remain valid evidence within their recorded scope.
- The formal release state remains 4 pass / 8 partial, with release acceptance false.
- Phase 2 remains disabled until the Phase 1 customer workflow is accepted.
- No paid use, provider switch, permission expansion, production deployment, or secret change is authorized by this plan.

## Deliverables

1. A versioned project-checkpoint schema and current checkpoint.
2. An append-only change log that cannot silently rewrite earlier entries.
3. A change-impact record covering preserved work, modified work, tests, permissions, budget, and next owner.
4. A deterministic reconciliation/checker that reports missing, stale, conflicting, or incomplete state.
5. A read-only architect handoff contract; only an authorized operator may persist approved changes.
6. Twelve behavioral scenarios covering the supplied continuity cases, including missing state, stale handoffs, changed facts, conflicting instructions, and interrupted work.
7. A compact change report with: main goal, new requirement, preserved progress, adjusted plan, pending evidence, next action, and actually changed work.
8. Updated project documentation and exact test evidence.

## Acceptance criteria

The assignment is complete only when:

- a new instruction updates the plan without erasing the main goal or valid evidence;
- an explicit main-goal replacement creates a new version while retaining the prior version;
- concurrent or stale writers cannot overwrite a newer checkpoint;
- read-only roles can propose but cannot persist, deploy, widen access, or approve themselves;
- all twelve continuity scenarios pass deterministically;
- failures are recorded as unknown, stale, conflicting, or interrupted rather than reconstructed through guesswork;
- the existing repository checks still pass; and
- the result remains local and undeployed until founder review.

## Completion estimate

The referenced starter-kit ZIP is not present in the Neurohands workspace. The current estimate therefore assumes reconstruction from the written specification.

| Work | Likely effort |
| --- | ---: |
| Inspect and map current state into the new schemas | 1–1.5 hours |
| Build checkpoint, append-only log, and impact templates | 1.5–2 hours |
| Build deterministic reconciliation and stale-write protection | 2–3 hours |
| Add the read-only architect and specialist handoff contract | 1–1.5 hours |
| Implement and run the twelve continuity scenarios | 3–5 hours |
| Repair failures, rerun checks, and finalize documentation | 1.5–2.5 hours |
| **Repository continuity layer** | **12–16 focused engineering hours** |
| Integrate and accept the contract across every Codex specialist/session | **4–8 additional hours** |
| **Estimated full stated assignment** | **16–24 focused engineering hours** |

Expected calendar time for the full stated assignment is **two to three focused working days**. A meaningful reviewable checkpoint should be available after approximately **3–4 hours**; it will include the versioned schema/current snapshot, append-only record format, stale-writer rejection, change-impact template, read-only reconciler, and three core tests.

If the exact starter-kit ZIP and all twelve scenario definitions are supplied and structurally sound, the full estimate falls to approximately **10–16 hours** because reconstruction and scenario interpretation are reduced.

This estimate covers the goal-continuity layer only. It does not include the separate live KNC/LINE acceptance, private-account verification, production deployment, or the full multi-agent organization product.

## Estimate assumptions and stop conditions

- Work stays inside the development branch and uses synthetic/local tests.
- No paid model or external service is required.
- No production credential, private customer content, or deployment is needed.
- The current Node.js test environment remains usable.
- A newly discovered conflict with the existing project state is reported at the two-hour checkpoint before the remaining estimate is revised.
- The work stops before production or any consequential external action and waits for founder approval.

**Confidence:** medium for the 16–24 hour full-assignment estimate. The repository already has reusable append-only workflow, locking, recovery, and deterministic test patterns, but the exact starter kit and full scenario definitions are missing and actual cross-session Codex integration needs interactive acceptance.

## Next action

Wait for founder approval of this scope and estimate. After approval, begin only the first 3–4 hour checkpoint described above and report its evidence before continuing.
