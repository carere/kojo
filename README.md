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

## Using it

Kojo is two things in one package: `kojo init` stamps a factory into a repository, and the rest of
the commands drive it. Everything below is what a person actually types.

### 1. Stamp a factory

```bash
kojo init --agent claude --model sonnet --sandbox docker --template review
```

It writes `.kojo/` — a roster, a workflow, the envelopes an agent's answers are decoded against, the
checks those answers are graded by, the command blocks a code phase runs, and a Dockerfile — plus
two entries in the repository's `package.json` and a skill under `.claude/skills/kojo/`. Nothing it
writes is a copy of the engine: the engine is a versioned dependency, so upgrading is a version bump
and never a re-stamp. Running `init` again keeps every file you have edited.

`--sandbox none` runs the agent on this machine instead of in a container. It is a real answer, not
an opt-out — the run still cuts a branch and still merges — but it is the one mode with no boundary
around the agent at all.

### 2. Finish the factory, then ask whether it can run

```bash
npm install                # or bun / pnpm / yarn — init prints the one for your lockfile
kojo doctor
```

**A freshly stamped factory fails `doctor` on purpose.** Three of the four entries in
`.kojo/commands.ts` are placeholders that exit 78, because a scaffolder cannot know how your
repository runs its own suite and a plausible-but-wrong command that exits 0 is worse than one that
says it is fake. `doctor` loads every file, builds a payload against the engine's own schemas, and
exits non-zero with a remedy per fault — so it is what a CI job gates on, not a summary.

### 3. Run it

```bash
kojo run review "the change this run is about"
kojo gate list                                    # what waits on a human, and for how long
kojo gate answer <token> --choice approve
```

`kojo run` **does not block on a gate**. It prints where the run stopped and exits 0 — a suspended
run is a success. Close the terminal; answer days later from anywhere, and the run continues from
where it stopped rather than from the top. Every run works on a branch of its own, and an approved
run merges that branch onto your trunk.

```bash
kojo ui                    # the Console: one factory's trace, and gates answered from a browser
kojo watch factory         # unattended: drive the trigger, apply what is answered
```

`kojo ui` and `kojo watch` are daemons and never exit on their own. `kojo run` is the one that
returns.

### Spending, which is a switch rather than a habit

An agent call costs money, and the process that makes it is often one nobody is watching. So the
**invoker** asks one question before it starts a process, every time — `KOJO_AGENT_SPEND`:

- **unset, with a terminal attached** — the call is made. This is you, at a keyboard.
- **unset, with no terminal** — refused before a process exists. Nothing is spawned and nothing is
  spent. That is CI, a cron, and an agent driving your shell.
- **`allow`** — the call is made, wherever it runs. A factory that runs unattended needs this set
  once, in the environment of whatever runs it.
- **`stand-in:<absolute path>`** — a process may run only if the agent's binary really resolves to
  that file. For rehearsing a workflow against a script.

`stand-in:` is checked rather than believed: Kojo resolves the binary itself and refuses anything
else. Putting a script in front of the real one on `PATH` is **not** the same claim — that is how
this repository's own build spent two agent calls nobody had authorised. `kojo doctor` prints which
of the four you are in.

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

## Developing Kojo itself

Everything above is Kojo in use. What follows is this repository.

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
