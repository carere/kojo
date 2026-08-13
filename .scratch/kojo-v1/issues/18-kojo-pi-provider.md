# 18 — The Kojo agent provider

**What to build:** An agent's identity — its system prompt, its tool allowlist, its harness extensions — survives the call. The stock provider drops all three silently, and the roster depends on all three.

**Blocked by:** 16, 07

**Status:** done

- [x] The system prompt, tool allowlist, and extensions reach the agent binary
- [x] The stream parser is reused rather than reimplemented, with its unexported return type inferred
- [x] The session is captured back to the host with the paths rewritten, and a later call resumes it
- [x] The captured transcript lands where the binary will look for it, so resuming does not fall back to an interactive prompt
- [x] Providers whose session helpers are already public are used unmodified rather than wrapped
- [ ] An integration test resumes a real session and proves the second call costs one message

## Comments

### What landed

- `src/contexts/agent/adapters/kojoPi.ts` — `kojoPi(options)`, an `AgentProvider` Kojo owns.
  `buildPrintCommand` emits `--system-prompt`, `--tools`, one `--extension` per source, `--model`,
  `--thinking`, `--session-dir`, and either `--session` or `--fork`, with the prompt still on
  stdin. `buildInteractiveArgs` carries the same identity as an argv, so an interactive session is
  not a second place the identity vanishes. `parseStreamLine` delegates to a `pi()` instance.
- `src/contexts/agent/services/piSession.ts` — the pure half Sandcastle keeps private:
  `encodePiSessionDirectory`, `isPiSessionFile`, `rewritePiSessionCwd`, and the two roots.
- `src/contexts/sandbox/adapters/boundary.ts` — `piSessionStorage(roots)`, the promise-shaped half,
  plus `AgentSessionStorage` (read back off `AgentProvider`, which is the only way to name it) and
  `PiSessionRoots`. It lands in the boundary module because that is the one place Kojo holds a
  promise, exactly as ticket 16's own comments predicted for the invocation half.
- `tests/support/localBindMountHandle.ts` — a real `BindMountSandboxHandle` over a temp directory,
  the sibling of `localIsolatedProvider.ts`. Capture and resume take their real sequence of calls —
  `find`, `copyFileOut`, rewrite, `mkdir -p`, `copyFileIn` — with no container runtime.

### Deviations

- **Nothing re-exports `claudeCode` / `codex`.** Criterion 5 says use them unmodified; a passthrough
  module would be a barrel, which AGENTS.md forbids repo-wide. Instead the asymmetry is pinned by a
  test: the seven Claude/Codex helpers are asserted public, and pi's five asserted absent. When
  upstream publishes pi's, that test fails and `piSessionStorage` can be deleted rather than kept
  forever out of habit.
- **`existsOnHost` is narrower than Sandcastle's.** Sandcastle ignores its `cwd` argument and scans
  every encoded directory. Kojo's asks the question that matters — is the transcript under the
  directory `pi --session <id>` will consult from *this* cwd — because answering "captured" about a
  file pi cannot see is the exact failure criterion 4 names. `findByIdOnHost` keeps the broad scan,
  which is what it is for.
- **The capture side locates broadly and lands precisely.** The sandbox search covers the whole
  sessions root; the host write goes under the encoded host cwd and nowhere else.

### API findings

- **pi's real flags, from the package's own published README** (`@mariozechner/pi-coding-agent`,
  0.73.1 — the package Sandcastle's own pi Dockerfile installs):
  `--system-prompt <text>`, `--tools <list>` (comma-separated: `pi --tools read,grep,find,ls`),
  `-e, --extension <source>` (repeatable), `--session <path|id>`, `--fork <path|id>`,
  `--session-dir <dir>`, `--thinking <level>`, `-p`, `--mode json`.
- **Fork is `--fork <id>`, a replacement for `--session <id>` and not a companion flag.** The design
  record calls it "the flag" as though it were `--fork-session`; it is not. Emitting both would
  name the session twice.
- **`--session` accepts a path as well as an id.** Not used: the id is what a trace row carries and
  what the audit's quirk is about, so the transcript is placed where the id resolves instead.
- **`encodePiSessionDir` hyphenates the colon *and* the separator**, so `C:\Users` encodes as
  `C--Users`, not `C-Users`. Measured against the implementation, after asserting the opposite and
  being proved wrong by the test.
- **Sandcastle quotes `--session` too**, so the stock command reads `--session '<id>'`. The
  difference between the two providers is the absent flags, not the quoting.

### Not done, and why

- **The real-session criterion is written but was not executed.** `pi` is not on PATH in this
  environment and `ANTHROPIC_API_KEY` is unset, so
  `tests/integration/contexts/agent/adapters/kojoPiRealSession.test.ts` skips. The file always
  loads and always runs one test — the gate's own consistency — so the skip is visible as a skip in
  the Vitest summary and the suite prints `NOT PROVEN: kojoPi resuming a real pi session` with the
  reasons on stderr. The criterion above is left unticked on purpose: a skipped suite is not a
  pass, and this one is the only thing that can falsify `--session-dir`, the encoding, and the
  claim that a second call re-enters rather than reopens.
