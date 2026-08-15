# 59 — A fixture inherits its trunk from whoever's machine it runs on

**What to build:** A test repository that names the branch it is on, rather than taking whatever
`git init` happens to produce.

## What was measured

The first CI run of the container tier on a Linux runner, 2026-08-15. Four suites failed, all with
one sentence:

    merge  code  FAIL   reason: the workspace is on master, and the merge targets main

`git init` still produces `master` on a stock runner. It produces `main` on the machine this
repository was built on, because that machine's git is configured that way. Every fixture below runs
a bare `git init` and then stamps a factory whose `trunk` is `main`:

    grep -rl '\["init"' packages/kojo/tests   →  26 call sites across 10+ files

**That count was wrong: there are 22, and eleven of them already stated a branch.** The `grep`
behind it matched the scripted agent's `{"type":"system","subtype":"init"}` lines and `kojo init`'s
own argv as well as `git init`. Counted properly while closing this — see the comment.

So the suites were passing on a global git setting nobody wrote down, and no test said so. That is
the same shape as the toolchain being `latest`: **green on the machine that ran it**.

CI declared `git config --global init.defaultBranch main` for a day, which unblocked it and was
honest about being an environment declaration. It was not the fix — it moved the assumption from one
machine's configuration to another's — and it has been removed now that the fixtures state their
own.

## Why it is worth fixing properly

A fixture that inherits its branch cannot say what it is testing. Two consequences, and the second
is the one that bites:

- a contributor whose git defaults to `master` sees four red suites and no clue why;
- and the *merge* tests are precisely the ones about which branch a run lands on, so the one thing
  they must control is the one thing they borrow.

## Shape

`git init -b main` at every site, or one shared helper the fixtures call. A helper is better —
26 call sites are 26 chances to forget — but the helpers are currently per-file (`throwawayRepo.ts`,
`doctor.test.ts`, `landsOnTrunk.test.ts` and others each have their own `git`), so this is partly a
consolidation.

Whatever lands, the branch a fixture starts on should appear in the fixture, once, as a constant
beside the `trunk` the stamped factory targets — so the two cannot disagree.

**Blocked by:** none.

**Status:** done

- [x] No fixture depends on `init.defaultBranch`. Proven by running **every** tier with the global
      default set to `master` — unit 682, container 275, browser 96, all green
- [x] The branch a fixture starts on and the `trunk` its factory targets are one constant:
      `defaultTrunk` in `FactoryLayout.ts`, which the `review` and `hotfix` templates now stamp
- [x] CI's `init.defaultBranch` line is removed, and the comment where it stood says why it must
      not come back
- [x] The call sites are counted again: **22**, not 26. The ticket's number was wrong — corrected
      below

## Comments

### 2026-08-15 — one constant, and the proof is running it the wrong way round

**`defaultTrunk` in `contexts/shared/models/FactoryLayout.ts`.** It sits beside `factoryDirectory`
for the same reason that one does: two halves of the build write it from opposite ends. `kojo init`
stamps `const trunk = "${defaultTrunk}"` into the workflow it generates, and every fixture passes
`--initial-branch=${defaultTrunk}` to `git init`. They cannot disagree, because there is nothing to
disagree with.

**The count in this ticket was wrong.** 22 `git init` call sites, not 26 — the original `grep` also
matched the scripted agent's `{"type":"system","subtype":"init"}` stream lines and `kojo init`'s own
argv. Eleven already passed `--initial-branch`; eleven did not, and those are the ones that were
inheriting. All 22 state it now, checked by counting both numbers rather than one.

**The proof is the run nobody had done.** Global `init.defaultBranch=master` — the runner's
condition, reproduced here — then every tier:

    unit         682 passed
    container    275 passed, 3 named skips
    browser       96 passed

Before this, the same setting turned four suites red on this very machine. That is the criterion,
and it is measured rather than argued: the assumption is gone, not relocated.

**And CI's declaration is removed, which is what keeps it gone.** The line that made CI green for a
day was an environment declaration, not a fix — it moved the assumption from a developer's machine
to a runner's. The comment where it stood now says so, and says that its return would mean the
fixtures have quietly started inheriting again.
