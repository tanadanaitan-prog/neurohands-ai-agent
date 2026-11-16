# Neurohands: guide for Claude

Read these files before every Neurohands task, in this order:

1. [docs/handbook/README.md](docs/handbook/README.md): purpose, objectives, process, and workflow.
2. [docs/handbook/PLANNING.md](docs/handbook/PLANNING.md): the plan of each task.
3. [docs/handbook/SECURITY.md](docs/handbook/SECURITY.md) and [docs/handbook/GUARDRAILS.md](docs/handbook/GUARDRAILS.md): before the first change.

## When a new task is assigned

A new task is a request to create, build, learn, or add something for Neurohands.

1. Add the task to `docs/handbook/PLANNING.md`, with its own Purpose, Objectives, Process, and Workflow sections.
2. Update the same four sections of `docs/handbook/README.md` when the task changes what Neurohands is for, what it must reach, how work is done, or how a request moves.
3. When the task is finished, add one line to the change record of `docs/handbook/README.md`.

## Rules

- Work on a new branch in its own checkout under `outputs/<name>/checkout`. Preserve the uncommitted files in every other checkout.
- Never open a `.env` file. Never write a key, a token, a password, or customer data into any file or message.
- Never merge, deploy, change the database, or send a LINE message without the owner's approval for that exact action.
- Run `python scripts/check_project_structure.py` after a documentation change. Run `npm run check` and `npm test` after a code change.
- The existing guides hold the detail: the [documentation index](docs/README.md) and the [Process README](docs/PROCESS_README.md).
