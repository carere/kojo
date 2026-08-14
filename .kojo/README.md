# Kojo's own factory

This is the factory used to develop Kojo, running in Kojo's own repository. It is not a demo copy of
a stamped starter: `kojo init` cannot produce a router and three lanes, and the point of this
directory is that the taxonomy belongs to the author (architecture.md **D1**). So it was written
here, by hand, against the same public API a stamped factory imports — every reference to the engine
is `from "kojo/..."`, resolved through `node_modules/kojo`, and nothing under `.kojo/` is a copy of
engine source.

Read [`workflows/factory.ts`](workflows/factory.ts) first. It is the product.

## What is where

| File | What it decides |
|---|---|
| `kojo.config.yaml` | The roster: five agents, what each is for, and which model each gets. |
| `workflows/factory.ts` | The workflow — the router, the routing `Match`, the one review gate, the merge and the ship. **This is the product.** |
| `workflows/lane/hotfix.ts` | The lane for something already broken. Approves before it measures. |
| `workflows/lane/feature.ts` | The lane for new behaviour. Plans in a file first, then runs the whole fast tier. |
| `workflows/lane/chore.ts` | The lane for a change of shape and not of behaviour. Runs no tests, on purpose. |
| `workflows/lane/common.ts` | What every lane shares: the actor, the invoker, the permission policies, the install phase, and how a set of commands becomes half of an acceptance. |
| `envelopes.ts` | The shape of every answer an agent may give — and `lanes`, which **is** the taxonomy. |
| `checks.ts` | What an answer has to survive: the plan really exists, the claimed diff is the real diff. |
| `commands.ts` | The real invocations a code phase makes. None of them is a placeholder. |
| `prompts/<agent>/system.md` | Who that agent is. |
| `prompts/<agent>/user.md` | What that agent is asked, every call. |
| `tsconfig.json` | How this directory is typechecked, and why it is not part of `bun tsc --build`. |
| `biome.json` | Nested Biome root, so `bun biome check .` reaches these files. |

Two files the design record names and this factory deliberately does **not** have:

- **`.gitignore`.** The repository root already ignores `.kojo/data`, the database and its sidecars.
  A second ignore file inside this directory would be a second place for the two to disagree.
- **`sandbox/Dockerfile`.** This factory runs `noSandbox()` — see below — so a Dockerfile here would
  be a file nothing reads, which is the same lie as a placeholder command that exits 0.

**`.env` is not committed, and it cannot be** — the repository root ignores `.env*`, which is the
point of it. So a fresh clone of Kojo reports `kojo doctor`'s `credentials` check as failed until a
maintainer writes one. Write the two lines by hand, or export `CLAUDE_CODE_OAUTH_TOKEN` in the
environment.

**Do not run `kojo init` to get that file here.** `init` keeps every file you edited, but it also
writes the ones it thinks are missing: doing it in this repository stamps the two files named just
above that this factory deliberately does not have, a second workflow `workflows/hotfix.ts` that
imports an envelope `envelopes.ts` does not export, and prompts for two agents the roster does not
carry. `doctor` then fails `workflows` as well, so following that advice takes this factory from one
failed check to two and leaves seven files to delete. This is measured, not feared — see
typescript-effect.md §12.

And know what that file is for, because it is not what it looks like: **Kojo passes no credentials.**
`SandcastleAgentInvoker` hands the provider no `env` at all, and the agent binary authenticates with
the operator's own ambient session — so no secret enters a Kojo value and none can reach a trace row.
`doctor` asks for the file because a *containerised* factory has no ambient session to inherit;
nothing at run time reads it. The check is therefore right in general and wrong for this factory, and
it is written down here rather than worked around — see typescript-effect.md §12.

## The lanes, and how they differ

A router agent reads the request and answers with one of three words. The envelope's `lane` does not
only carry context forward — it **selects the next subgraph**.

| | planning | grades the change with | human asked inside the lane |
|---|---|---|---|
| `hotfix` | none | typecheck | **yes — before it is measured** |
| `feature` | a plan file, committed before the builder starts | typecheck, lint, unit tier | no |
| `chore` | none | lint, dead-code — **no tests at all** | no |

Each difference is one a maintainer would want on a Monday:

- **`hotfix` inverts the order of judgement.** The person who was woken up can say *"yes, that is the
  fix"* in seconds, and the machine can then take as long as it takes. It buys minutes and pays for
  them in coverage, which is why it is the lane for things that are already broken and nothing else.
- **`feature` plans in a file, and the planner may write nowhere but `.scratch/`.** That is enforced
  by the permission guard, not requested by a prompt: the change-set is fingerprinted around the
  call, and a write outside is undone and the run fails. The plan is committed before the builder
  runs, which keeps each agent graded on its own diff.
- **`chore` runs no tests, and that is the opposite of a corner cut.** A chore is by definition the
  change a suite would not notice either way, so a green suite would be evidence of nothing. What
  grades a tidy-up is the linter and `bun knip` — and `knip` can go red *because* the work succeeded,
  which is the signal wanted.

Every lane then returns to one common tail: **one human review, one acceptance, one merge, one ship.**
Judgement happens once; everything after it is consequence.

## Where the work runs

`noSandbox()`. The scope still cuts the run's own branch, still hands every phase a `Workspace` over
that worktree, and still tears the whole thing down at a suspension — it just does it on this machine
instead of in a container. For this repository that is the correct call rather than the cheap one:

- **Kojo's integration tier drives Docker itself.** A phase that ran it inside a container would need
  docker-in-docker. A factory whose reference sandbox cannot host its own test suite should say so
  rather than pretend, which is also why the integration tier is not in `commands.ts` at all — it is
  CI's, and that is written down there rather than left as an absence.
- **The toolchain is pinned by `.prototools` and restored by `bun install`.** An image reproducing it
  would be a second copy of both to keep in step by hand, and the first thing to drift would be the
  thing the checks run on.

**And there is no boundary around the agent under `noSandbox()`.** The agent is a host process
running as you. Its working directory is the run's own worktree, under `.sandcastle/worktrees/`, so
this repository — the factory it is being graded by, the trace database, every other run's worktree —
is three directories up and readable. Kojo's default is to take `factoryOwnPaths` out of the tree the
agent works in, and **this factory switches that off**: see `keepsItsOwnFactory` in
`workflows/lane/common.ts` for the two measurements behind it, the first of which is that `bun knip`
— `commands.dead`, run by every lane — exits 1 in a worktree whose `.kojo/` is hidden. So what
protects this factory's own grader is the second line of defence and only that: `withPermissions`
fingerprints the working tree around every agent call, and a write under `barred` is rolled back and
the run failed. A factory that runs `docker()` should delete `keepsItsOwnFactory` and take the
default.

Turning this into a containerised factory is one expression in `workflows/factory.ts`: import `docker`
beside `noSandbox` and return `docker({ imageName: "kojo-factory:latest" })` — **and one move in
`workflows/lane/common.ts`**, because `restore` uses the `host.onWorktreeReady` hook and Sandcastle
runs only that slot for a no-sandbox provider. A container installs its dependencies through
`sandbox.onSandboxReady`. Changing the provider without moving the hook gives you a container with no
`node_modules`, and every command in `commands.ts` then reports a repository that cannot compile.

## Dependencies, and why they are a hook and not a phase

`restore` in `workflows/lane/common.ts` is a `SandboxHooks` entry on every lane's scope. It was a
`code` phase, and the first run of the hotfix lane proved it could not be:

> The lane suspended at its in-lane `approve` gate. The scope tore the worktree down, because a run
> waiting for a human holds nothing. The answer arrived, the body replayed — and the `install` phase
> **returned its recorded result instead of running**, which is exactly what a phase is for. `verify`
> then typechecked a worktree with no `node_modules` and reported a red typecheck about a change that
> was perfectly good.

**Durability replays results, not effects on the environment.** A hook runs on every acquisition,
which is the property wanted. The price is that a hook leaves no phase row, so the install is no
longer a bar in the waterfall — what is left is inside the acquisition's own row, whose
`acquiredAt`/`releasedAt` bracket it.

## Commit messages, and why the lane names the type

Kojo enforces Conventional Commits on `commit-msg` (`lefthook.yml` → `cog verify`). The `commit`
phase puts the **agent's own summary** on the commit, because agents propose and code disposes — so
the first run of this factory refused at `commit-tidy` with `Missing commit type separator ':'`.

`conventional` in `workflows/lane/common.ts` is the fix, and it is in code rather than in a prompt
on purpose: a convention a repository enforces mechanically must be satisfied mechanically. Each lane
names its own type — `fix:` for hotfix, `docs:` then `feat:` for feature, `chore:` for chore — and
the agent still owns every word of what it says it did. Git runs `commit-msg` on a **merge** commit
too, so the merge carries `feat(kojo): merge the <lane> that ran as <run id>` rather than git's
default.

## Where an accepted run lands

**The branch this repository was on when the run started** — recorded in the `target` phase, not a
`trunk` constant. Kojo's trunk moves (`main`, then a long-lived `feat/*` branch), the run's own branch
is forked from wherever HEAD was, and merging back anywhere else would put work on a branch it was
never based on.

`main` is **refused by name**. Kojo's history reaches `main` through a reviewed feature branch, so a
run that merged straight there would be work that skipped the process this repository exists to run.
A run started on a detached HEAD is refused too — there is nowhere for it to land.

The merge happens in the repository the run was started from, so that repository has to be on that
branch with nothing uncommitted in it when the run lands. If it is not, the merge refuses and says
which branch it found; it does not put the work somewhere else.

## Running it

```bash
bun install                                  # once, and again after any dependency change
moon run console:build                       # once — kojo ui serves build output, see below
node_modules/.bin/kojo doctor                # says whether this factory can run, and refuses it if not
node_modules/.bin/kojo run factory "what needs doing"
node_modules/.bin/kojo gate list             # what is waiting on a human, and for how long
node_modules/.bin/kojo gate answer <token> --choice approve
node_modules/.bin/kojo ui                    # watch it: http://localhost:4321 — DOES NOT EXIT
node_modules/.bin/kojo watch                 # applies answers recorded elsewhere — DOES NOT EXIT
```

**`kojo` is not on the PATH in this repository.** It is a workspace dependency, so the binary is
`node_modules/.bin/kojo`. The rest of this file writes `kojo` for brevity; type the long form.

**`kojo ui` and `kojo watch` do not return.** One is an HTTP server, the other polls the inbox for
ever. Background both, and never make one the foreground command you wait on. `--sweep <n>` is the
number of seconds between sweeps — it does not bound `watch` and does not make it exit.

**`kojo ui` needs the Console built, and this repository does not commit it.** `packages/kojo/console`
is `console:build`'s output and is ignored by git, so on a fresh clone the page reports *the front end
is not built yet* and serves the API alone. Run `moon run console:build` once. If `kojo ui` was
already running, **restart it** — the server resolves that directory at startup.

`kojo run` does not block on the gate. It prints where the run stopped and exits 0 — **a suspended
run is a success.** Close the terminal; answer later, from anywhere, and the run continues from where
it stopped rather than from the top.

A run is deduplicated by `factory/<request>`, so **re-running the same request replays the recorded
run, failure included.** To retry after a failure, change the request. That is the idempotency key
doing its job.

`--timeout` is how long `kojo run` *watches*, not how long the run gets. The feature lane restores
dependencies and then runs the typecheck, the linter and the unit tier, so give it a generous number
or the command will stop describing a run that is still going.
