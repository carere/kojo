# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Delivery workstream operations

Used by `/to-spec`, `/to-tickets`, and the configured delivery orchestrator.

- **Workstream root**: the open, unassigned spec issue published by `/to-spec`. It is not executable and must not have any state-role label.
- **Routing metadata**: exactly one visible section in the root body:

  ```markdown
  ## Delivery

  - Target branch: `feat/example`
  - Destination branch: `main`
  - Source revision: `<full-commit-object-id>`
  ```

  The branch names must be valid and distinct. The source revision must be a full commit object ID reachable from the target. The target is where child work integrates; the destination is where the completed workstream will eventually merge.
- **Implementation ticket**: an open native sub-issue of the workstream root. Its body contains an immutable `delivery-ticket-key` marker formatted `<root-identifier>::<zero-padded-approved-ordinal>`, references the parent, and states its acceptance criteria. `ready-for-agent` is the only execution label.
- **Standalone ticket**: an issue without a parent may be executable only when its own body contains valid Delivery metadata. This gives a bug, chore, or documentation change an independent target branch.
- **Blocking**: use GitHub's native issue dependencies. A ticket is in the ready frontier only when all of its blockers are closed.
- **Source readiness**: before publishing children, verify that the target branch exists and is checked out, its recorded source revision is an ancestor, and the relevant grilling, ADR, and context paths are clean. Stop when relevant changes are uncommitted; never commit or stash them automatically.
- **Activation**: `/to-tickets` creates every child and blocking edge without execution labels. It verifies the exact approved child-key set, parent links, blocker edges, open states, absence of execution labels, and an acyclic graph before applying `ready-for-agent` to the executable children. Do not use an executor-specific label. Stop if native relationships are unavailable.
- **Partial publication**: leave created issues open and unlabelled, report their numbers, and resume by immutable publication key. Never reconcile by title or duplicate, delete, or close partial children automatically.
- **Execution**: a worker may claim only a labelled child whose native blockers are closed. A label-only executor is incompatible with delivery workstreams.

Sandcastle loads and validates the complete native graph before execution. Run
`moon run sandcastle:delivery -- --root <root-number>` for one workstream, `--target <branch>` to select by
delivery target, or omit both selectors to process every discovered workstream sequentially. It
pushes each verified target merge before closing that child as completed. It never closes the root
or merges the target into the destination branch.

GitHub commands:

- Read the root graph and execution state: `gh issue view <root> --json state,body,assignees,labels,subIssues,subIssuesSummary`.
- Create a child: `gh issue create --parent <root> --title "..." --body-file <file>`.
- Add a blocker: `gh issue edit <child> --add-blocked-by <blocker>`.
- Verify a child and its key: `gh issue view <child> --json state,parent,blockedBy,labels,body`.
- Activate a verified child: `gh issue edit <child> --add-label ready-for-agent`.
