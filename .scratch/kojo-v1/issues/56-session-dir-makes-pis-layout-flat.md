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

**Status:** ready-for-agent

- [ ] Whichever root `kojoPi` passes, `existsOnHost`, `findByIdOnHost`, `captureToHost` and
      `resumeIntoSandbox` agree with pi's **actual** layout under that root — graded by writing a
      file the way pi writes it and asking Kojo to find it, with no pi process involved
- [ ] The choice is stated: either stop passing `--session-dir` and use pi's default root with its
      encoding, or keep the flag and drop the encoding. Not both, and the docstring says which and
      why
- [ ] Every path compared is resolved the same way, so `/var/folders` and `/private/var/folders`
      cannot be two strings for one directory. `realpath` at the boundary, once, named
- [ ] A test proves a resume does **not** fall back to a cold start, without a model: a fabricated
      transcript in the place pi would write it, and an assertion that Kojo finds exactly that file
- [ ] Ticket 52's paid criterion is attempted only after this lands, and the ledger records that
      order
- [ ] `tests/unit/contexts/agent/services/piSession.test.ts` is extended rather than replaced — it
      already grades the encoding, and what is wrong is when the encoding applies

## Comments

*(none yet)*
