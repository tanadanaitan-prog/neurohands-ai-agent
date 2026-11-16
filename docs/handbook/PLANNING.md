# Neurohands planning

This file holds the plan of each Neurohands task. Every task starts with four sections: Purpose, Objectives, Process, and Workflow. Then it has its steps, its checks, and its evidence.

## How to use this file

1. When a task is assigned, add it to the task index and add a new section for it under "Tasks", above the older tasks.
2. Fill the four sections before any change.
3. Give every step its files and its check. Mark a step "Done" only when its check has passed, and write the result under "Evidence".
4. A new request that arrives during a step goes under "Waiting requests". Extra work that the task finds goes under "Follow-ups found". Neither one is started inside the task.
5. When the task ends, set its status in the task index: Done, Stopped, or Replaced.

The security rules are in [SECURITY.md](SECURITY.md). The limits for AI tools are in [GUARDRAILS.md](GUARDRAILS.md).

## Task index

| Date | Task | Type | Size | Status |
| --- | --- | --- | --- | --- |
| 2026-11-16 | Create the Neurohands handbook | Build | Large | Done on a local branch. Not pushed, not reviewed. |

## Tasks

### 2026-11-16: Create the Neurohands handbook

#### Purpose

The owner works on Neurohands with several AI tools. Each tool kept its own notes, so the purpose, the objectives, the process, and the workflow were spread over many files and two folders. This task gives every tool one short entry point, and it states the security rules and the guardrails in one place.

#### Objectives

1. A handbook README with separate Purpose, Objectives, Process, and Workflow sections, each with its source.
2. This planning file, with the same four sections for each task.
3. A security file and a guardrail file.
4. A rule that makes Claude read the handbook before every Neurohands task and update both files for every new task.

Done when the files exist on the branch `claude/handbook-20261116`, each file has its required sections, every status statement names its source, a scan finds no secret and no customer data, the repository's structure check passes, and the owner's original folder still shows the same 7 uncommitted entries.

Non-goals: code changes, a merge, a deployment, a database change, a LINE message, and any change to the second workspace outside this repository.

#### Process

- The work follows the [Process README](../PROCESS_README.md): record the revision, preserve existing changes, and record each command with its result.
- The branch starts from `main` at revision `3fd2c89`. It lives in its own checkout, `outputs/handbook-20261116/checkout`.
- Each step has one check. A step is finished when its check has passed.
- Local commits are made on this branch only. Nothing is pushed, and no pull request is opened, until the owner says so.

#### Workflow

1. Create the branch and its checkout.
2. Read the source documents on `main`.
3. Write the four handbook files.
4. Add the guide for Claude and the index entry.
5. Run all checks again.
6. Report to the owner. The owner decides about the push and the pull request.

#### Steps

| # | Step | Files | Check | Status |
| --- | --- | --- | --- | --- |
| 1 | Create the branch in its own checkout | None | The branch name is correct, and the original folder is unchanged | Done |
| 2 | Read the source documents | None | The sources are listed under "Evidence" | Done |
| 3 | Write the security file | `docs/handbook/SECURITY.md` | The sections exist, each rule names its source, and the secret scan finds nothing | Done |
| 4 | Write the guardrail file | `docs/handbook/GUARDRAILS.md` | The three parts exist, and each guardrail names its source | Done |
| 5 | Write this planning file | `docs/handbook/PLANNING.md` | The four sections and the steps table exist | Done |
| 6 | Write the handbook README | `docs/handbook/README.md` | The four sections exist, and each one names its source | Done |
| 7 | Add the guide for Claude, the index entry, and the catalog entry | `CLAUDE.md`, `docs/README.md`, `config/project-structure.v1.json` | `python scripts/check_project_structure.py` reports `ok: true` | Done |
| 8 | Add a pointer rule in the owner's Claude settings | Outside this repository | The rule names this repository and the handbook | Done |
| 9 | Run all checks again | None | Every check above passes, and the original folder is unchanged | Done |

Steps 3 and 4 were written before steps 5 and 6, so that every link points to a file that exists.

#### Proof

- **Checks that must keep passing:** `python scripts/check_project_structure.py`. The application tests are not run, because this task changes no code.
- **Targets to reach:** the heading checks and the secret scan for each new file.

#### Waiting requests

None.

#### Follow-ups found

- The repository has no guide file for the other AI tools that points to this handbook.
- The local copy of `main` was not refreshed from GitHub before the branch was created.
- A second workspace outside this repository holds a newer copy of the platform. The two are not reconciled.

#### State

- **Commits:** local commits on `claude/handbook-20261116`. No push.
- **Plan:** this section.
- **Record of this task:** the "Evidence" list below and the change record in the handbook README.

#### Evidence

- Step 1: `git worktree add` reported "Preparing worktree (new branch 'claude/handbook-20261116')" and "HEAD is now at 3fd2c89". The original folder showed the same 7 uncommitted entries before and after.
- Step 2: read `README.md`, `docs/README.md`, `docs/PROCESS_README.md`, `docs/GOAL_ACCEPTANCE.md` (the first 34 lines and its 12 headings), and `docs/UNTRUSTED_EXECUTION_BOUNDARY.md` (the first 40 lines).
- Steps 3 and 4: "SECURITY sections: 8, sources named: 10", "GUARDRAILS parts: 3, guardrail rows: 20", "secret-like strings: 0".
- Steps 5 and 6: "README four sections: 4, sources named: 5", "PLANNING four sections: 4, step rows: 9".
- Step 7, first run: the structure check failed with `UNCLASSIFIED_FILE` for `CLAUDE.md`. The cause: the catalog lists root files by name. The fix: one new line in `config/project-structure.v1.json`. This file was added to step 7 before the change.
- Step 7, second run: "structure check exit: 0", "ok: True", "errors: 0", "local links checked: 346".
- Step 9: the final results are in the commit message of the last commit on this branch.
