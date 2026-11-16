# Neurohands handbook

This handbook is the short entry point for any person or AI tool that starts a Neurohands task. It has four sections: Purpose, Objectives, Process, and Workflow. Each section is short, and it points to the document that holds the detail.

Written 16 November 2026 from the documents at revision `3fd2c89`. A statement with a date was true on that date. Check the current state before you act on it.

## How to use this handbook

1. Read this file and [PLANNING.md](PLANNING.md) before every Neurohands task.
2. Read [SECURITY.md](SECURITY.md) and [GUARDRAILS.md](GUARDRAILS.md) before the first change.
3. When a new task is assigned (create, build, learn, or add), add it to [PLANNING.md](PLANNING.md). Update the four sections of this file when the task changes them.
4. When the task is finished, add one line to the change record at the end of this file.

## Purpose

Neurohands gives a business an AI workforce. The agents answer questions, use approved business tools, work with company documents, and report what they did. The owner decides the responsibilities and the access of each agent.

The current product is a pilot for one glass business, KNC Glass. It has three roles:

| Role | Who uses it | What it does |
| --- | --- | --- |
| Jarvis | The founder and authorized staff | Business summaries, agent runs and errors, activation codes, upload links, and approved tool actions |
| Aria | An activated customer | Looks up products, orders, and lead times. Reads that customer's documents. Records facts, support cases, and follow-up tasks. |
| Concierge | A visitor without customer access | Explains the business and guides the visitor to a demo or to activation. It has no private customer tools. |

These are three application roles that use AI models. They are not three trained models.

Source: [application README](../../README.md), the paragraph that begins "Neurohands aims to give a business an AI workforce" and the section "Who does what?".

## Objectives

The owner's goal has 12 parts:

1. Understand and preserve existing work
2. Consolidate ownership safely
3. Complete Phase 1 first
4. Build a configurable AI workforce
5. Develop a capable engineering team
6. Connect each agent to authorized knowledge and tools
7. Make message handling a verifiable workflow
8. Apply mathematics and optimize performance purposefully
9. Support one-time and recurring work
10. Benchmark and improve continuously
11. Provide a concise daily progress and improvement report
12. Maintain accountability, budget and delivery discipline

The [Goal acceptance](../GOAL_ACCEPTANCE.md) record, prepared on 9 September 2026, states that the full goal has no reliable completion percentage, and that none of the 12 parts was fully accepted on that date.

The next product milestone is a complete customer conversation about a real uploaded document. Source: [application README](../../README.md).

The objectives of the work in progress are in [PLANNING.md](PLANNING.md).

## Process

Process is how work on Neurohands is done. The full guide is the [Process README](../PROCESS_README.md).

**Start**

1. Read the continuation snapshot and the knowledge register.
2. Run `git status --short` and `git rev-parse HEAD`. Preserve existing changes.
3. Record the objective, the owner, the expected result, and the permitted actions.

**Work**

- Work on the permitted branch, in its own checkout.
- A command is a starting point. It is not evidence that it passed.
- Record the exact command, the revision, the exit status, the output location, and the scope.
- Report a failure as a failure or as an unknown.

**Finish**

- Update the continuation record: the completed work, the unresolved issue, the next owner, the next action, and the approvals that are needed.
- Add a dated record when the owner asks for one, and read it back to confirm that it saved.

**Approvals**

Creating documentation does not grant access, and it does not approve a release. A merge, a deployment, a database change, and a LINE change each need the owner's approval.

Source: [Process README](../PROCESS_README.md), sections "Start a work session", "Cloud and business processes", and "Finish, hand off and continue".

## Workflow

Workflow is the path that a request follows. Neurohands has two paths.

### A message from a person

1. A person sends a LINE message.
2. The application on Railway receives and verifies the message.
3. The application identifies the person and their access.
4. The founder or staff reach Jarvis. An activated customer reaches Aria. A visitor reaches Concierge.
5. The application checks the allowed tools and the client and department scope.
6. The agent reads or records authorized business data.
7. The agent uses the tool results to prepare the answer, and the reply goes out through LINE.
8. The application records the agent run, the tool results, and the reported usage.

| Part of the system | Its job |
| --- | --- |
| LINE Official Account | The conversation that customers and the owner see |
| LINE Developers console | Connects the Messaging API channel to the application's webhook and credentials |
| GitHub | Stores the source code, the documentation, and the change history |
| Railway | Runs the application, receives LINE events, and calls the connected services |
| Supabase | Stores business records, customer access, private documents, saved facts, and execution records |
| AI provider | Supplies AI responses and tool requests. The application enforces access. |

Source: [application README](../../README.md), section "How a request moves through the system".

### A change to Neurohands

1. A task is assigned, and it is added to [PLANNING.md](PLANNING.md).
2. A new branch is created in its own checkout.
3. The change is made in small steps. Each step has a check.
4. The checks run: `python scripts/check_project_structure.py` after a documentation change, and `npm run check` and `npm test` after a code change.
5. The branch goes to review.
6. The owner approves the merge. A deployment, a database change, and a LINE change each need a separate approval.

Source: [Process README](../PROCESS_README.md), section "Cloud and business processes", row "GitHub review / continuation".

## Where to find more

The [documentation index](../README.md) lists every guide: current status and history, delivery plans, operating guides, laboratory guides, and recovery records.

## Change record

| Date | Task | What changed in this file |
| --- | --- | --- |
| 2026-11-16 | Create the Neurohands handbook | First version |
