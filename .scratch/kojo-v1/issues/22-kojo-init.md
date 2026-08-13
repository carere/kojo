# 22 — Stamping a factory into a repo

**What to build:** A fresh repository gets a factory it owns — roster, workflows, envelopes, checks, commands, prompts, and a sandbox definition — plus a built image. The runtime stays a versioned dependency; everything opinionated is the user's file, not a vendored copy of an engine.

**Blocked by:** 20

**Status:** done

- [x] Initialisation asks for the agent, model, sandbox provider, and template, and can be driven non-interactively
- [x] What is stamped is the user's to edit; no engine source is copied into the target repo
- [x] Run data, the trace, and worktrees land in an ignored directory
- [x] The detected package manager is wired into both the image and the first command block together, so the toolchain the phases need exists where they run
- [x] Stamped commands are obvious placeholders, never plausible-but-wrong commands that exit successfully
- [x] Running initialisation twice does not clobber edits the user has made

## Comments

**What landed.** A new bounded context, `scaffold`, plus `kojo init`.

- `models/` — `PackageManager.ts` (the `Toolchain` record that renders *both* the Dockerfile block
  and the install command, so edge 7 has nowhere to drift), `Placeholder.ts` (marker, exit 78,
  `isPlaceholder`), `FactoryChoices.ts`, `FactoryPlan.ts`, `ScaffoldError.ts`.
- `ports/ImageBuilder.ts` with `DockerImageBuilder` (real, `docker`/`podman`) and
  `InMemoryImageBuilder` (records requests, plus a `BuiltImages` reader).
- `services/` — `detectPackageManager.ts` (pure decision + the effect that looks),
  `plan.ts` (**pure**: choices → files), `stamp.ts` (writes, never overwrites), `initialise.ts`.
- `templates/` — `starter.ts`, `review.ts`, `hotfix.ts`, `config.ts`, `commands.ts`,
  `dockerfile.ts`, `support.ts` (README, `.gitignore`, `.env`).
- `src/cli/init.ts`, added to the root subcommand list in `src/cli/kojo.ts`.

**Where the template lives.** typescript-effect.md §2 names `src/template/` for what `kojo init`
stamps. It is `src/contexts/scaffold/templates/` instead, and the reason is mechanical rather than
stylistic: the stamped files are parameterised by the answers (the provider expression, the image
name, the package-manager block, the agent's install lines), so they are functions and not literals;
and a directory of literal `.ts` files under `src/` would be compiled by `bun tsc`, linted by Biome
and analysed by `bun knip` — three checks graded against source that is not this project's.

**Two starters, both real programs.** `review` (agent → suite → gate → acceptance) and `hotfix`
(scout → fix → `reviewed` loop → suite → acceptance). Both are stamped as a `sandboxed` scope so the
chosen provider — including `none` — reaches the workflow as code, which is the only honest place it
can live: a provider is built per run because `CreateSandboxOptions` carries no `env`.

**The placeholders have teeth.** Both starters combine the mechanical judgement (running
`commands.test`) and the human one into one `Acceptance` and pass it to `requireAcceptance`. A fresh
factory therefore *cannot be accepted* until somebody writes the real commands: the placeholder exits
78 and the run fails with `NotAccepted`. Mechanically detectable for ticket 23 two ways — the string
`KOJO-PLACEHOLDER` is in the command itself, and the stamped `commands.ts` exports
`survivingPlaceholders()` built on Kojo's own `isPlaceholder`.

**`kojo.config.yaml` carries only the roster.** Every key in it is one `YamlRoster` decodes. The
sandbox and image defaults are deliberately *not* written there: nothing reads them yet, and an
unread key in a config file is the same lie as a placeholder that exits 0.

**Proved by test.** `bun tsc` over the stamped tree in a temp repository, against the real engine,
under `strict` + `exactOptionalPropertyTypes` (mutation-checked: a deliberate type error is
reported); `import()` of the stamped workflow under Bun; the real `YamlRoster` loading the stamped
config and both prompts; real `git status` proving `.kojo/data/`, `.env` and `*.db` are ignored while
the roster and workflows are tracked; the placeholders executed through `sh` and observed to exit 78
on stderr; a second `initialise` over an edited tree reporting every file `kept` and changing no byte.

**Measured, not tested.** The stamped Dockerfile (`--agent pi`, bun toolchain) was built by hand:
`docker build` exit 0 in ~40s, and a container from it reports `uid=503(agent)`, `bun 1.3.14`,
`pi 0.73.1`, `git 2.39.5`, `HOME=/home/agent` writable. That is not in the suite — it pulls
`node:22-bookworm` and installs an agent CLI over the network, which is minutes and a different
answer on a machine with no route out. The `DockerImageBuilder` adapter itself *is* covered by
integration tests, against `FROM scratch`.

**Not built here.** `kojo doctor` (ticket 23). There is no `--force`: what it would overwrite is the
workflow, which is the product.
