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

So the suites were passing on a global git setting nobody wrote down, and no test said so. That is
the same shape as the toolchain being `latest`: **green on the machine that ran it**.

CI now declares `git config --global init.defaultBranch main`, which unblocks it and is honest about
being an environment declaration. It is not the fix — it moves the assumption from one machine's
configuration to another's.

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

**Status:** ready-for-agent

- [ ] No fixture depends on `init.defaultBranch`. Proven by running the container tier with
      `git -c init.defaultBranch=master`, which must be green
- [ ] The branch a fixture starts on and the `trunk` its factory targets are one constant, or are
      asserted equal where they are two
- [ ] CI's `init.defaultBranch` line is removed, and its removal is what proves the first criterion
- [ ] The 26 `git init` call sites are counted again afterwards, so the number in this ticket is
      either right or corrected

## Comments

*(none yet)*
