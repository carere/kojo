# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` author associations.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit`, and `gh pr close`.

GitHub shares one number space across issues and PRs. Resolve an ambiguous `#42` with `gh pr view 42`, falling back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Delivery workstream operations

Used by `/to-spec`, `/to-tickets`, and the configured delivery orchestrator.

- **Workstream root**: the open, unassigned spec issue published by `/to-spec`. It is not executable and must not have a state-role label.
- **Routing metadata**: exactly one visible section in the root body:

  ```markdown
  ## Delivery

  - Target branch: `feat/example`
  - Destination branch: `main`
  - Source revision: `<full-commit-object-id>`
  ```

  Branch names must be valid and distinct. The source revision must be a full commit object ID reachable from the target.
- **Implementation ticket**: an open native sub-issue of the workstream root. Its body contains an immutable `delivery-ticket-key` marker formatted `<root-identifier>::<zero-padded-approved-ordinal>`, references the parent, and states its acceptance criteria. `ready-for-agent` is the only execution label.
- **Standalone ticket**: an issue without a parent may be executable only when its own body contains valid Delivery metadata.
- **Blocking**: use GitHub’s native issue dependencies. A ticket is in the ready frontier only when all its blockers are closed.
- **Source readiness**: before publishing children, verify that the target branch exists and is checked out, its recorded source revision is an ancestor, and the relevant grilling, ADR, and context paths are clean. Stop when relevant changes are uncommitted; never commit or stash them automatically.
- **Activation**: `/to-tickets` creates every child and blocking edge without execution labels. It verifies the approved child-key set, parent links, blocker edges, open states, absence of execution labels, and an acyclic graph before applying `ready-for-agent` to executable children.
- **Partial publication**: leave created issues open and unlabelled, report their numbers, and resume by immutable publication key. Never reconcile by title or automatically duplicate, delete, or close partial children.
- **Execution**: a worker may claim only a labelled child whose native blockers are closed.

Kojo’s delivery command is currently exposed as `moon run cli:delivery -- .`, but its workflow implementation is still pending. Do not claim automated workstream execution until that implementation exists.

GitHub commands:

- Read the root graph: `gh issue view <root> --json state,body,assignees,labels,subIssues,subIssuesSummary`.
- Create a child: `gh issue create --parent <root> --title "..." --body-file <file>`.
- Add a blocker: `gh issue edit <child> --add-blocked-by <blocker>`.
- Verify a child: `gh issue view <child> --json state,parent,blockedBy,labels,body`.
- Activate a verified child: `gh issue edit <child> --add-label ready-for-agent`.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue with child issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog sections.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use GitHub’s native issue dependencies. Where dependencies are unavailable, use a `Blocked by: #<n>` line at the top of the child body.
- **Frontier query**: list the map’s open children, dropping assigned tickets and tickets with open blockers. The first remaining ticket in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment with the answer, close the child, and append a context pointer to the map’s Decisions-so-far section.
