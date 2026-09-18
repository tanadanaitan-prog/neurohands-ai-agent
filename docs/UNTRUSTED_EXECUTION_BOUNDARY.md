# Local untrusted-execution boundary

This repository contains a bounded local C10 probe in
`src/lib/untrusted-execution-boundary.js`. It starts a separate Node process
without a shell, supplies no project credentials or customer data, enables
Node's permission mode, denies filesystem and child-process permissions, and
runs a fixed adversarial script inside a VM context with a null-prototype global
and no application-supplied functions or objects.

The adversarial script tries to enumerate environment variables, load modules,
read `.env`, contact the cloud-metadata address, create a socket, inspect
network interfaces, call a production deployment tool, and escape through
global, object, fetch, and tool constructors. No host-realm function or object
is injected into the VM. The parent accepts the run only when every attempt is
blocked, the tested artifact write is denied, the child emits a bounded
fixed-schema report, and no configured secret/customer sentinel appears in
output. The test also confirms the temporary work directory gained no file.

Any requested extra child environment variable is rejected before spawn. This
deliberately strict rule makes an injected credential a visible pre-execution
failure instead of relying on redaction after untrusted code runs.

## What this proves

- The fixed local adversarial probe receives no application capabilities.
- Node permission enforcement denied its file reads, file writes and child
  process launch on the tested host.
- Common JavaScript environment, module, network and production-tool paths were
  absent from the probe context. Two outbound transport paths and one local
  network-metadata path were attempted; no transport function or module loader
  was available to the probe.
- The test did not expose its synthetic secret or customer-data sentinels in
  output or artifacts.

## What this does not prove

Node's VM documentation does not define a VM context as an operating-system
security boundary, and Node's permission model does not provide a network
permission. The outer worker still has operating-system network access even
though the fixed probe receives no transport capability. The result explicitly
reports `osNetworkIsolated: false`. The fixed probe therefore is
**application-layer local evidence**, not proof that arbitrary hostile
pull-request code is safe to execute.

Before enabling untrusted pull-request automation, GitHub-hosted workflow
permissions, secret availability, artifact handling, filesystem isolation and
outbound network isolation still require review in the actual CI environment.
Use an ephemeral container or runner with network denied outside the process;
do not place production credentials in that job. C10 remains incomplete until
that environment is tested with the same sentinels and its result is bound to
the release gate.

## Pull-request workflow staged for hosted proof

`.github/workflows/untrusted-pr.yml` stages that missing hosted proof without
granting release authority. It runs only for `pull_request`, grants the job token
`contents: read`, disables checkout credential persistence, and references the
checkout Action by a full commit SHA. A checker from the trusted base commit
validates the candidate workflow before candidate code runs.

Dependency installation runs in a disposable container without lifecycle
scripts and without host secrets. The fixed adversarial test then runs as an
unprivileged user in a separate read-only container with all capabilities
dropped, a process/memory/CPU bound, and Docker `--network none`. The repository
and installed dependency volume are read-only during the probe. The workflow has
a ten-minute hard timeout and no deployment, artifact-upload, production secret,
or caller-supplied shell-command path.

`scripts/check-untrusted-pr-workflow.js` pins the complete reviewed workflow
fingerprint and fails on secret references, write permission, unpinned or
unreviewed Actions, caller-controlled shell expressions, credential persistence,
missing timeout, mutable container image, lifecycle scripts, or removal of the
network-denied probe. Run it locally with `npm run untrusted-pr:check`.

This is staged configuration, not evidence that GitHub executed it. C10 remains
partial until a real pull-request run shows the hosted runner used the expected
base workflow, exposed no unnecessary credential, denied outbound access in the
probe container, and produced the expected adversarial result. Docker
`--network none` isolates the probe container; it does not prove isolation of
the dependency-install container, the checkout Action, or the runner host.
The workflow also cannot approve itself: a pull request can propose edits to
this file, so a repository rule or human review must require the unchanged,
default-branch-owned workflow result before it can count as release evidence.
