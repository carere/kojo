# Editable issue Factory

This is ordinary Factory code for local Zaidan trials. The Kojo engine does not own its scheduling,
repair limit, checks, agent choices, or delivery policy. Copy `.kojo` into a target Project and edit
`workflows/issues.ts` and the prompt files. Preserve any existing Factory files when installing it.
Use the [local development path](../../docs/local-development.md) to link unpublished Runtime code.

The request is:

```json
{
  "repository": "carere/zaidan",
  "issue": 123,
  "branch": "codex/issue-123",
  "base": "main"
}
```

Start it with `kojo workflow start <project-id> issues --payload <json>`. Use a new PR branch for
each new Run. The base is a local branch. The Project's origin must match the selected repository.

An issue with no sub-issues takes the single-issue path. A parent takes the graph path. GitHub
[sub-issues](https://docs.github.com/en/rest/issues/sub-issues) and
[blocked-by relationships](https://docs.github.com/en/rest/issues/issue-dependencies) determine the
input graph. Cycles, cross-repository children, and unresolved external blockers stop progression.
Issue closure does not establish that blocker code is integrated.

Each issue gets a distinct worktree and Docker sandbox. The default capacity is two. Ready issues
run in bounded batches; accepted children integrate in issue-number order. Dependents start from
the resulting integrated commit. All selected branches must be new. A child also verifies its
starting commit before installation or implementation.

The implementer uses the included implement skill. The Workflow runs checks and a separate agent
reviews the running UI in the same sandbox through Chromium. Failed checks or UI findings return
to the implementer, with two repair attempts. The Workflow commits after acceptance. A rejected
Run keeps its worktree and branch for inspection. A single issue has no integration merge.

After combined checks pass, the Workflow verifies a clean worktree at the accepted commit, pushes
that exact commit, and opens a PR. Push and PR creation are separate recorded Phases with unresolved
recovery policy. An uncertain external result must be inspected before retry; it is not safe to
start another Run to repeat delivery. The Workflow does not merge the PR or close issues.

## Prerequisites

- Docker must be running on the Host.
- `gh auth status` must succeed on the Host with access to the Project repository.
- `codex login` must have created the Host's `~/.codex/auth.json`. The sandbox mounts that file
  read-only at the agent's auth path. It is not captured as a Factory asset.
- The Project must install with `bun install --frozen-lockfile`.
- Edit the check commands, UI command, and URL for the Project. The current defaults use Zaidan's
  `zaidan:build` and `zaidan:dev` Moon tasks. Edit provider and model at each agent call as needed.

The Dockerfile installs pinned Bun, Codex, agent-browser, and Moon, plus system Chromium for
ARM64 and x64 Hosts. It includes the implement skill and its TDD and code-review references.
The Workflow builds its image from captured Docker and skill assets. Prompt files are read from
the captured Revision at each agent call.

The UI process helper owns a process group, refuses an occupied review port, and checks that the
listener has stopped between reviews. Container shutdown stops it if the Run is interrupted.
Accepted diffs are retained as Run Artifacts. Check and review reports, repair attempts, commit
records, invocation activity, and the PR result remain in the Run. Screenshot files under `/tmp`
are temporary; the retained review report must describe the observed behavior.

## Verification

From the Kojo source checkout:

```bash
moon run issue:test issue:typecheck
bun packages/kojo/src/main.ts doctor --root examples/issue --image <built-image>
```

Unit tests exercise scheduling, source revisions, capacity, blocker refusal, repair limits, and
acceptance through in-memory delivery and Workspace operations. The image has also been checked
manually with a local test application and Chromium. Authenticated single-issue and graph trials
on Zaidan remain required; this example is not yet a publication acceptance result.
