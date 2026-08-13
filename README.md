# Kojo

> A software factory builder. `kojo init` stamps a factory into any repo; you then define workflows
> that run AI developer workflows inside sandboxes.

Kojo combines two ideas that each name the other as their own missing half:

- **[super-simple-software-factory](https://github.com/disler/super-simple-software-factory)** —
  the control plane: phases, typed envelopes, validation, permission boundaries, a SQLite trace.
  Its README lists what it deliberately leaves out: *"a branch per run, a sandbox around the agent,
  and a merge step at the end."*
- **[sandcastle](https://github.com/mattpocock/sandcastle)** — the execution plane: sandbox
  providers, worktrees and branch strategies, agent providers, `exec`, session capture and resume.
  Its own workflows are hand-written loops with no trace, no checks, and no typed handoff.

Kojo is the control plane of the first driving the execution plane of the second, written in
TypeScript with [Effect](https://effect.website) v4 — plus the two seams neither project has:
**how a run starts**, and **how a human answers it mid-run** without holding a container open while
they think.

A workflow is an Effect program you write. Kojo supplies the four primitives such a program is made
of — **actor**, **code**, **agent**, **sandbox** — the ports they plug into, and the durability that
lets a run wait days for a human and then continue where it stopped.

## Design

Read these in order:

1. [docs/design/architecture.md](docs/design/architecture.md) — the model: the four primitives, why
   a sandbox is a scope rather than a wrapper, why the branch is the durable state, the ports and
   their reference adapters, and the edges to design around.
2. [docs/design/typescript-effect.md](docs/design/typescript-effect.md) — the project as built:
   packages, ports as services, `effect/unstable/workflow` for suspend and resume, `Schema` as the single
   output contract, the typed error channel, the Sandcastle boundary, and the build order.
3. [docs/design/console.md](docs/design/console.md) — the Console: how a human drills into one run,
   why the run view is a waterfall over the scope tree, and how a gate is answered from a browser.

The ubiquitous language lives in [docs/context/](docs/context/map.md), and the decisions that needed
a record live in [docs/adr/](docs/adr). Findings gathered against primary sources live in
[docs/research/](docs/research) — start with the
[Effect v4 API audit](docs/research/effect-v4-api-audit.md), which is what the design record above
was corrected against.

[docs/build-record.md](docs/build-record.md) is what happened when the design above was built: the
waves in order, what the design record got wrong and how each error was found out, the catalogue of
checks that passed while doing no work, and the real-agent spend. Read it before picking the work up.

## Tooling

| Tool | Role |
|---|---|
| [proto](https://moonrepo.dev/proto) | installs and updates the project tooling |
| [moon](https://moonrepo.dev/moon) | task runner and project graph — owns the per-project tasks (dev, test, build) |
| [bun](https://bun.sh) | package manager and runtime |
| [@effect/tsgo](https://github.com/Effect-TS/tsgo) | TypeScript 7 (tsgo) with the Effect language service — Effect diagnostics in the editor and in `bun tsc` |
| [Biome](https://biomejs.dev) | lint and format |
| [Cocogitto](https://docs.cocogitto.io) | Conventional Commits, enforced on `commit-msg` |
| [lefthook](https://lefthook.dev) | git hooks |
| [knip](https://knip.dev) | dead-code analysis |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | headless browser CLI — agents use it to explore the app |

## Getting started

```bash    # installs bun, node, and moon from .prototools
bun install
lefthook install
bun add -g agent-browser    # browser automation CLI — agents use it to explore the app
```

Then:

Repo-wide checks call the tool directly — one process covers the whole monorepo, and CI runs the
same commands:

```bash
bun tsc --build            # typecheck across every project reference
bun biome check .          # lint + format
bun biome check --write .  # lint + format, writing fixes
bun knip                   # dead-code analysis
```

Per-project tasks (dev, test, build) go through moon. `package.json` has no task scripts on
purpose — the only script is the `prepare` lifecycle hook, which patches the TypeScript install
with the Effect language service (`effect-tsgo patch`) on every `bun install`.

## Layout

```
apps/console/    # the Console — SolidJS, TanStack Start in SPA mode
packages/kojo/   # the engine and the CLI, published as one package
.kojo/           # the factory this repository develops itself with
docs/design/     # the design record
```

`console:build` writes its shell into `packages/kojo/console`, where `kojo ui` looks for it, and
`kojo:build` refuses a package with no front end.

The build order and where it stopped are in
[typescript-effect.md §12](docs/design/typescript-effect.md);
[docs/build-record.md](docs/build-record.md) is the account of doing it.
