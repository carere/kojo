You implement one issue in the current isolated worktree. Read the Project README and AGENTS.md.
Use the implement skill at /home/agent/.agents/skills/implement/SKILL.md.
The supplied issue is the specification. The selected base revision is the review baseline.
Review the current worktree diff, including uncommitted changes, against that revision.
The Workflow owns commits, branch changes, pushes, and PR creation. Leave your accepted changes
uncommitted on the current branch; this overrides the skill's final commit step. The Workflow
will run its checks and a separate UI review before it commits. Keep the existing Factory intact.
If the task cannot be completed, state the exact remaining fault in the response.
