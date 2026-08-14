# 56 — `--session-dir` makes pi's layout flat, and Kojo reads an encoded directory

**What to build:** The two faults that stand between ticket 52 and a green paid test. Both are in
`kojoPi` and `piSessionStorage`, not in the test, and both were measured against pi 0.80.10 without
spending anything.

## Fault 1 — the flag added to prevent a cold start causes one

pi encodes the working directory into a directory name **only for its default root**:

    SessionManager.create → sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)

and `listSessionsFromDir` is a single non-recursive `readdir`. `kojoPi` passes `--session-dir`
whenever `sessions` is given, so pi's layout goes flat. Probed:

    with --session-dir S   → S/2026-08-14T15-48-44-573Z_<id>.jsonl
    Kojo looks under       → S/--encoded--cwd--/<id>.jsonl

Two consequences, and the second is worse than a red test:

- `existsOnHost` asks a directory pi never wrote, so it answers *no* about a transcript that is
  there;
- `resumeIntoSandbox` **lands a captured transcript under `<sandbox root>/<encoded cwd>/`, where pi
  will not look.** A resumed turn then silently falls back to a cold start — carrying none of the
  context that earned it, and costing a full prompt rather than one message. That is precisely the
  fault the whole capture half exists to prevent, arriving through the flag added to prevent it.

Ticket 18's own criterion 4 names this: *"The captured transcript lands where the binary will look
for it, so resuming does not fall back to an interactive prompt."* It was graded against Kojo's own
encoding rather than against pi's behaviour under the flag Kojo passes.

## Fault 2 — a macOS temp path is not the path pi records

`mkdtemp(tmpdir())` returns `/var/folders/…`. A child started there reports
`/private/var/folders/…`, which is what pi writes into the session line and what it encodes. So the
`cwd` handed to `existsOnHost` and the one pi used are two strings for one directory — and
`rewritePiSessionCwd` would not match the line it exists to rewrite.

The build already knows this shape: `lane.test.ts` anchors its fixture at `/private/tmp` after
measuring 3 failures in 4 under `TMPDIR` against 0 in 16 under `/private/tmp`.

## Why this is its own ticket rather than part of 52

Ticket 52 is the gate and the credential. This is the thing under test. Buying 52's paid criterion
before these land purchases a red test and teaches nothing about resume — which is the one claim
`kojoPi` exists for.

**Blocked by:** 52 — the code half is done.

**Status:** done

- [x] Whichever root `kojoPi` passes, `existsOnHost`, `findByIdOnHost`, `captureToHost` and
      `resumeIntoSandbox` agree with pi's **actual** layout under that root — graded by writing a
      file the way pi writes it and asking Kojo to find it, with no pi process involved
- [x] The choice is stated: the flag stays, and the encoding applies **exactly when the flag is
      absent**. `piSessionSubdirectory` is the one place that says so
- [x] Every path compared is resolved the same way. `onHost` is the one named place, and it resolves
      **host** paths only — a sandbox path names a filesystem this process cannot see
- [x] A test proves a resume does not fall back to a cold start, without a model: three of them, in
      *finding a transcript pi wrote, without pi*
- [x] Ticket 52's paid criterion is attempted only after this lands, and the ledger records that
      order — it is still unattempted
- [x] `tests/unit/contexts/agent/services/piSession.test.ts` is extended rather than replaced

## Comments

### 2026-08-14 — both faults fixed, and both were read out of pi rather than run against it

**Neither fault needed a pi call to confirm.** pi's own source settles the first and a two-line shell
probe settles the second, which is the answer to why ticket 52's paid half should not have been
bought first: it would have failed, and the failure would have looked like a credential problem.

**1. One flag decides the layout, and it is `--session-dir`.** From pi 0.80.10's
`SessionManager.create`:

    const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)

So a named root is flat and only pi's own default carries `--<encoded cwd>--`. Kojo passed the flag
*and* read an encoded subdirectory under it. The rule now lives in one pure function,
`piSessionSubdirectory`, as a function of the one thing that decides it, and `piSessionStorage`
derives that one flag from `roots?.sandbox === undefined` — the same condition `kojoPi` uses to
decide whether to pass `--session-dir`, so the two cannot drift.

`anywhereOnHost` also had to change: it walked only one level down, so it could not find a transcript
written flat. It now searches the root **and** the directories under it, because a resume is exactly
the case that does not know which layout wrote the file.

**2. Host paths are resolved once, in `onHost`.** Measured rather than reasoned:

    mktemp gave:       /var/folders/z2/…/tmp.dHiXKVNe6E
    process.cwd() is:  /private/var/folders/z2/…/tmp.dHiXKVNe6E   ← what pi encodes
    path.resolve:      /var/folders/z2/…/tmp.dHiXKVNe6E           ← what Kojo encoded

pi's `resolvePath` is `path.resolve`, which follows no symlink, so pi encodes whatever its own
`process.cwd()` reports — already resolved by the OS. Sandbox paths are deliberately **not** resolved:
they name a filesystem this process cannot see, and resolving one here would answer about the host's
tree instead.

**A third fault, found by the tests written for the first two.** `resumeIntoSandbox` rewrote the
session line *from* the unresolved host cwd, while `captureToHost` had written the resolved one. A
`rewritePiSessionCwd` whose `from` does not match returns the line untouched and reports nothing — so
the transcript would have gone into the sandbox still naming a directory that is not there. Caught by
*puts it back under the rebuilt sandbox's own cwd*, which went red the first time the suite ran.

**The tests that were already there agreed with the bug.** `capturing a pi transcript to the host and
putting it back` passed throughout, because both sides of every assertion were Kojo's own encoding —
the fixture wrote where Kojo would look. That is §4's shape exactly: a check that succeeds while
doing no work. Those tests now grade pi's behaviour, and the new suite writes the file the way pi's
source says pi writes it and then asks Kojo the question a resume asks.

**Proven, and by which mutation.**

| mutation | what went red |
|---|---|
| `piSessionSubdirectory` always encodes — the old behaviour restored | 5 unit tests: *puts it straight in the root it was given*, and all four rows of *answers on the flag alone* |
| `onHost` returns its argument unresolved | 4 integration tests, including *finds it when asked with the unresolved twin* and both capture assertions |

**Checks.** `bun tsc --build --force`, `bun biome check .`, `bun knip` clean. Unit **634**,
integration **268 passed with 3 named skips**. No agent call and no pi call was made: the pi binary
was read, not run.

**What this does not close.** The paid criteria of tickets 18 and 52 are still unbought. What changed
is that buying them is now worth doing — before this, the money would have bought a red test and a
misleading reason for it.
