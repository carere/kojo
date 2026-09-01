---
name: kojo
description: >-
  Use the Kojo Factory in this repository. Inspect Projects and Workflows, start a Run, inspect its
  status, and answer a Gate through the per-user Daemon.
---

# Use the Kojo Factory

Read `.kojo/README.md` before you change or run the Factory. The CLI is
`node_modules/.bin/kojo` when a global `kojo` command is not available.

## Check the Factory and Daemon

```bash
kojo doctor
kojo daemon status
kojo project list
```

Install the Daemon if this OS user does not have one:

```bash
kojo daemon install
```

Register the repository once:

```bash
kojo project register --path .
```

## Start a Run

```bash
kojo workflow list --project <project-id>
kojo workflow start <project-id> factory --payload '{"request":"what needs doing"}'
kojo run status <run-id>
```

The Daemon owns execution and all correctness storage. The CLI is a short-lived client. Use
`kojo run list --project <project-id>` to find a Run.

## Answer a Gate

```bash
kojo gate list
kojo gate answer <token> --choice approve
```

The Daemon records and applies the answer. Confirm progress with `kojo run status <run-id>`.

## Open the Console

```bash
kojo ui
```

This asks the Daemon to launch the Console and returns.

## Authoring rules

- Import authoring symbols by deep path from `@carere/kojo-runtime`.
- Do not import authoring symbols from the CLI package.
- Keep irreversible effects inside recorded phases.
- Put a sandbox scope around phases, not inside a phase.
- Keep the Project clean before a Workflow can merge accepted work.
- Do not merge, push, or release by hand to complete a Run.
- Run `kojo doctor` after a Factory change.
