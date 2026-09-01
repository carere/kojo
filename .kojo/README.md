# Kojo's Factory

This directory is the authored Factory for the Kojo repository. It imports the authoring runtime
from `@carere/kojo-runtime`. The per-user Daemon captures a Workflow Revision, owns the Runner,
and stores all Run and Gate state outside the Project.

## Factory files

| File | Purpose |
|---|---|
| `kojo.config.yaml` | Defines the agent roster. |
| `workflows/factory.ts` | Routes one request to the hotfix, feature, or chore lane. |
| `workflows/lane/*.ts` | Defines the lane-specific program. |
| `envelopes.ts` | Defines agent answer schemas and lane names. |
| `checks.ts` | Defines answer checks. |
| `commands.ts` | Defines the Project commands that phases can run. |
| `prompts/` | Defines agent system and user prompts. |

The Factory uses `noSandbox()`. Each Run still uses its own worktree and branch. Permission checks
protect Factory files from an agent call. Do not run `kojo init` over this hand-authored Factory.

## Run the Factory

```bash
bun install
node_modules/.bin/kojo doctor
node_modules/.bin/kojo daemon install
node_modules/.bin/kojo project register --path .
node_modules/.bin/kojo workflow list --project <project-id>
node_modules/.bin/kojo workflow start <project-id> factory --payload '{"request":"what needs doing"}'
node_modules/.bin/kojo run status <run-id>
```

The Workflow routes the request to one lane. Every lane joins one common tail: human review,
acceptance, merge, and ship. The target branch is the clean branch that the Project used when the
Run started. The Workflow refuses `main`.

## Gates and Console

```bash
node_modules/.bin/kojo gate list
node_modules/.bin/kojo gate answer <token> --choice approve
node_modules/.bin/kojo ui
```

The CLI sends each request to the Daemon. The Daemon Runner applies a Gate answer and continues the
Run. `kojo ui` launches the Daemon-hosted Console and returns.

## Change the Factory

Import each authoring symbol by deep path from `@carere/kojo-runtime`. Keep sandbox scopes around
phases. Keep irreversible effects inside recorded phases. Run these checks after a Factory change:

```bash
node_modules/.bin/kojo doctor
bun tsc --build
bun biome check .
bun knip
```
