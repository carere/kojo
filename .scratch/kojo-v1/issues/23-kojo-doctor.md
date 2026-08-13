# 23 — Refusing to call an unfinished factory ready

**What to build:** A command that checks whether this factory can actually run, and says no when it cannot. A scaffolded factory that has not been finished should fail loudly rather than run and produce nonsense.

**Blocked by:** 22

**Status:** done

- [x] It checks the runtime, the container tooling, the image, and credentials
- [x] It refuses to call the factory ready while any placeholder command survives
- [x] Each failure names what is wrong and what to do about it, not just that something is wrong
- [x] It exits non-zero when the factory is not ready, so it can gate a CI job
- [x] A dry run assembles every layer, decodes the config, validates the roster, and stops before the first spawn

## Comments

**What landed.** `kojo doctor`, and the stamped README stops lying.

- `contexts/scaffold/models/Finding.ts` — `Finding`, its three standings, and `ok` / `failed` /
  `skipped`. `failed` **takes the remedy as an argument**, so a failure with nothing to do about it
  is unrepresentable rather than discouraged; `everyFaultSaysWhatToDo` grades the criterion over a
  whole diagnosis.
- `contexts/scaffold/services/readiness.ts` — every decision, pure. The split is
  `detectPackageManager`'s: the looking needs a spawner, a filesystem and a daemon; the deciding
  needs a record.
- `contexts/scaffold/services/diagnose.ts` — the one effect that goes and looks. It **never fails**:
  every fault is a finding, because a doctor that gives up at the first problem makes a person run
  it four times.
- `cli/doctorReport.ts` (pure rendering, folded to a terminal) and `cli/doctor.ts` (the command and
  the dry run). One entry added to the subcommand list in `cli/kojo.ts`, and nothing else there.

**Twelve checks, in the order a person reads them:** `runtime`, `repository`, `factory`,
`commands`, `credentials`, `roster`, `workflows`, `sandbox`, `container`, `image`, `toolchain`,
`layers`.

**Three standings, not two, and the third is what keeps the other two honest.** A container check on
a `--sandbox none` factory has no answer, so it is `skipped` and says why. A doctor that reported it
`ok` would be edge 6 one level up — a plausible reassurance nobody measured. Nothing here guesses:
a check that cannot be aimed names the flag that would aim it.

**Where it runs is read off the workflow, not off a config key.** `sandboxesNamed` matches the
provider import line, and the symbols come from `providerSource` — the same function `kojo init`
stamps the import with, so there is no second table to drift. The image tag comes from the
`imageName:` the workflow hands its provider. A YAML key naming a provider would be a second
statement of a fact that already lives in code, and `templates/config.ts` refuses those on purpose.
`--sandbox` and `--image` override both.

**One predicate for placeholders, as the ticket asked.** `.kojo/commands.ts` is **imported** and
asked for `survivingPlaceholders()`; a file whose owner deleted that export falls back to walking
`commands` with Kojo's own `isPlaceholder`. Reading the file as text is not merely weaker, it is
wrong — the stamped file *names* `KOJO-PLACEHOLDER` in its own doc comment, so a text scan would
report a finished factory as unfinished for ever. There is an integration test whose finished
`commands.ts` keeps that comment and is called ready anyway, and another whose `test` command kept
the marker with different words and is refused.

**Edge 7 is measured, not assumed.** The toolchain check runs
`docker run --rm --entrypoint sh <image> -c "command -v <manager>"`, where the manager is the first
word of the `install` command the factory actually declares. `--entrypoint` is not optional: the
stamped Dockerfile ends in `ENTRYPOINT ["sleep", "infinity"]`, so a bare `run` would sleep instead
of answering. Verified by hand against a mis-built image: `alpine` tagged as the factory's image
reports *carries no `npm`, and .kojo/commands.ts runs it*.

**The dry run assembles every layer over a scratch database.** Building the engine over the
factory's own file would register this process as a runner, and a runner applies every verdict
written since the last one ran — so a doctor pointed at it would silently resume suspended runs.
Looking must never be an act of execution (adr/gate/0001), and this is the one command whose whole
purpose is looking. The scratch file proves the same thing: measured by hand, it migrates
`cluster_locks`, `cluster_messages`, `cluster_migrations`, `cluster_replies`, `cluster_runners` and
`kojo_asked_gates`. An integration test asserts the other half — after `kojo doctor` there is no
`kojo/` branch and no `.kojo/kojo.db`.

**Proved by test.** 43 unit tests in `tests/unit/contexts/scaffold/services/readiness.test.ts` and
`tests/unit/cli/doctorReport.test.ts`; 6 in `tests/integration/cli/doctor.test.ts`, each launching a
real `kojo` process in a real stamped repository. The exit code is asserted, not only the words —
`expect(ran.status).toBeGreaterThan(0)` on an unfinished factory and `toBe(0)` on a finished one.
The sandbox scan is graded against the **real output of the real template**, for all five providers
crossed with both starters, so a rename inside `providerSource` that this scan stopped recognising
fails the suite rather than passing a test written over a literal.

**Not built here.** `--dry-run` on `kojo run`; the ticket named this command as the natural home for
the same idea and that is where it is. No check of the trace schema's standing against this build —
`kojo ui` already reports it, and reading it needs the factory's own database open, which this
command deliberately never does.
