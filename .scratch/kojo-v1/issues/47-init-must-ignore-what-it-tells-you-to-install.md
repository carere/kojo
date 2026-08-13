# 47 — `kojo init` tells you to install, then the first merge refuses

**What to build:** A factory stamped, installed and run exactly as `kojo init` instructs reaches its
merge. Today the first one refuses.

Walked after wave 15, on a fresh repository, following the printed next-steps literally:

```
kojo init …            → created package.json, 11 files, "next: install → edit commands → doctor"
npm install            → added 2 packages, and now: ?? node_modules/  ?? package-lock.json
…run, suspend, approve in the browser, kojo watch…
                       → run failed — MergeRefused
                          branch: kojo/2ad4bd2f…  into: main
                          reason: main holds uncommitted changes
```

The untracked `node_modules/` is what the merge refuses over. **`kojo init` writes a manifest and
instructs an install, and never arranges for the install to be ignored.**

Adding a `.gitignore` naming `node_modules` and committing it made the same loop merge cleanly, with
`main` gaining the commit and `git show main:LICENCE-HEADER.md` returning the agent's work.

**This is a collision of tickets 44 and 45 that neither implementer could have seen** — 44's tests
never merge, and 45's tests write their own fixture repositories rather than following `init`'s
instructions. It took walking the loop as a person to find it, which is the third time in this build
that has been true.

Refusing a dirty trunk is **correct** and must stay: merging over uncommitted work is how a person
loses it. The defect is that `init` creates the condition it will later refuse.

**Blocked by:** 44, 45

**Status:** done

- [x] A factory stamped and installed exactly as `init` instructs reaches its merge without a person
      adding anything
- [x] `init` arranges for whatever its own instructions create to be ignored — without clobbering a
      `.gitignore` the repository already has
- [x] `MergeRefused` on a dirty trunk stays, and still names what is uncommitted
- [x] The acceptance test **follows `init`'s printed instructions** rather than building a fixture
      repository by hand. That difference is the entire reason this was missed

## Comments

**Implemented** on `kojo-v1/47-init-ignores-what-it-installs`.

**The mechanism** is `contexts/scaffold/services/ignoreInstall.ts`, shaped like `manifest.ts` and
deliberately not like `stamp.ts`: the repository's `.gitignore` is merged, never planned, because a
planned file is written whole or kept whole and that rule would mangle a person's own file the
second time it ran (`plan.test.ts` still asserts nothing outside `.kojo/` is planned). The pure
decision (`ignoreFor`) creates the file when there is none, appends one commented block naming
`kojo init` when entries are missing — the same shape this repository's own root `.gitignore` grew
by — and appends nothing when an existing line already covers the entry under any of the usual
spellings (`node_modules`, `/node_modules`, `node_modules/`, a leading `**` segment). Existing
content is kept byte for byte, always as the prefix.

**The lockfile is committed, not ignored — decided, and here is why.** The stamped
`commands.install` restores dependencies *frozen against the lockfile* (`bun install
--frozen-lockfile`, `npm ci`); a worktree cut from a branch that never committed one is a sandbox
whose install fails. It is also the evidence `detectPackageManager` reads on a re-stamp, and the
record of the resolution the checks graded. So `node_modules/` is the whole of `installArtifacts`,
and the lockfile travels the other road: **init's printed next-steps now carry a commit step**
(`git add --all && git commit --message 'add a kojo factory'`, executable exactly as printed — a
bare `git commit` would open an editor), and the stamped README's walk-through gained the same
line. Without a commit step the criterion "reaches its merge as instructed" was unreachable
anyway: `.kojo/`, `package.json` and the lockfile are untracked on a fresh repository, and the
merge rightly refuses all of them. The commit step sits before `kojo doctor`, whose repository
check wants a HEAD to fork from.

**`MergeRefused` stays, and now names what it saw**: the reason is
`main holds uncommitted changes: ?? node_modules/, …` — first five porcelain entries, then a count
— instead of sending the person off to run `git status` themselves.

**Tests, and what each one actually grades:**

- `tests/integration/cli/initInstructions.test.ts` — the acceptance test, and the criterion-4 one.
  A fresh `git init` repository and *no fixture*: it spawns `kojo init` as a child process, parses
  the numbered steps out of init's own stdout, and executes them verbatim — the real
  `bun install` (file-linked engine, ~2s warm), the one human edit to `commands.ts`, the printed
  commit, `kojo doctor` (exit 0 required), then run → suspend → `gate answer` → merge. It asserts
  `main` moved, holds the agent's file, that the commit carried `bun.lock`/`package.json`/`.kojo`
  and **not** `node_modules` or `.kojo/.env`, and that the trunk's `git status --porcelain` is
  empty after the whole loop — the line that was red before this ticket.
- `tests/unit/contexts/scaffold/services/ignoreInstall.test.ts` — the pure decision: create,
  append-with-prefix-kept, the covered spellings, comment/negation not mistaken for covers,
  idempotence, missing trailing newline mended, and the lockfile deliberately absent.
- `tests/unit/contexts/scaffold/services/initialise.test.ts` — initialise writes/appends/keeps the
  repository `.gitignore` over the in-memory filesystem, and reports it (`Initialised.ignore`).
- `tests/unit/contexts/workflow/services/phase/merge.test.ts` — the refusal names the porcelain
  entries, and caps at five with a count.

Verified red under mutation: stubbing `ignoreInstall` out of `initialise` fails the acceptance test
(the printed `git add --all` then commits `node_modules` itself, which the `ls-files` assertion
refuses; with print assertions also disabled it still fails). Walked by hand as well, healthy and
mutated, in a scratch repository.

One incidental: the acceptance test's real `bun install` chmods the target of the stamped `bin`
entry through the link — `packages/kojo/src/main.ts` is now committed `755`, which a `bin` script
should be anyway; otherwise every test run would leave the repo dirty by one mode bit.
