# 36 — Dogfood

**What to build:** Kojo's own repository runs a Kojo factory. The showcase workflow — triage, route, build, test, review, merge, ship — runs end to end on real work, and the Console is how it is watched.

**Blocked by:** 33, 30, 35, 23, 43, 44, 45

**Status:** done

> **The stamped loop closes with zero manual intervention.** Wave 16's integrator walked it on a
> fresh repository following only what `kojo init` prints: init, `bun install`, edit
> `.kojo/commands.ts`, commit, `doctor` (14 checks, none failed), `run` (draft/commit/verify,
> suspended at its gate), `kojo ui` (waterfall, gate card, `/gates` queue), answered in the browser
> (*"Recorded — nothing is running"*, honest), `kojo watch` (applied in ~4s), and **`main` gained the
> merge commit with the agent's file in it**. Then a five-second deadline expired, the sweep applied
> it, the queue shed the asking, and the run list went to *"0 waiting on a human"*.
>
> **Three things it learned that this ticket must build for, because a dogfood runs many times and
> every walk so far ran once.**
>
> - **The fake agent needs a fresh session id per call.** A constant one poisons every run after the
>   first: the repair turn resumes the captured session, and the provider looks it up under
>   `~/.claude/projects` and fails with `resumeSession "…" not found`.
> - **The fake agent needs fresh content per call.** Constant content is *correctly* refused on the
>   second run — `main` already holds the identical file, the worktree diff is empty, and
>   `diffMatchesClaims` reads the claim as work that was not done. That is the check working.
> - **A failed run cannot be retried under the same subject.** The run id is deterministic from
>   workflow plus subject, so a re-run replays the recorded failed state. A retry needs a fresh
>   subject — which is `idempotencyKey` doing its job, and a thing a dogfood harness will hit
>   immediately.


> **Ticket 30's integrator walked the whole loop and found four breaks. This ticket is not a
> demonstration — it starts after they are fixed.**
>
> What already works, end to end against a real factory: a stamped starter runs a real agent,
> commits, verifies, suspends at its gate, is answered from the browser with the OS user recorded,
> is applied by a watcher, and succeeds. The three-state receipt is honest against a real runner.
>
> What breaks — now tickets **43**, **44**, **45**, and **46**:
> - **43** — the Console shows nothing for a real run. The fixture layer and the HTTP layer disagree
>   about `null` versus absent, so 85 green browser specs are blind to it.
> - **44** — `kojo init` stamps a factory with no dependency and no pinned `effect`, and `doctor`
>   calls it ready.
> - **45** — no stamped starter merges, so the loop stops one step short of the point.
> - **46** — an expired asking never leaves the queue.


- [x] Kojo's own factory lives in this repo and is the one used to develop Kojo
- [x] A router agent classifies work into lanes, and the lanes differ from each other on purpose
- [x] A run goes from trigger to shipped without manual intervention except at the gates
- [x] The whole run is watched from the Console, and its gates are answered there
- [x] Agent-facing skills for driving Kojo are stamped into the repo
- [x] The build order document is updated to record what the showcase actually exercised, and what it did not

## Comments

**Seven runs of Kojo's own factory, against a scratch trunk branch — never `main`, never
`feat/kojo-v1`.** Three lanes landed. Every gate below was answered in the browser.

| run | lane | what it showed |
|---|---|---|
| `e40d20d8` | chore | **failed at `commit-tidy`** — `cog verify`: `Missing commit type separator ':'` |
| `990ece41` | chore | landed. lint + `knip` clean, gate answered in the Console with **no runner alive** |
| `70d06be5` | hotfix | approved in-lane, then **red typecheck**; rejected; `merge` failed in **0 ms** |
| `a95dd18a` | hotfix | landed, but the watcher held a factory module two commits old — **re-run, not claimed** |
| `397d1191` | hotfix | landed. one module everywhere; typecheck clean after the mid-lane gate |
| `1846603d` | feature | **`MergeRefused`: the trunk holds uncommitted changes: M docs/design/typescript-effect.md** |
| `bc915cfd` | feature | landed. `docs:` then `feat:` inside one merge, typecheck + lint + unit clean |

The lanes differ in the history, not only in the source: `chore:` / `fix:` / `docs:`+`feat:`, and
`lint, dead code` / `typecheck` / `typecheck, lint, unit` on the gate's own question. The hotfix lane
asks its human **before** anything measures — its gate card reads `measured: not yet — this lane
approves first`.

**Three defects found, all fixed, none of which a single walk of a stamped starter could find.**

1. **A repository's own git hooks run inside `commit` — and inside `merge`.** Cocogitto refused the
   agent's summary, and git runs `commit-msg` on a merge commit too, so `Merge branch 'kojo/<id>'`
   would have refused the last step of a run everything else had accepted. `merge` gained an optional
   `message`; `conventional` in `.kojo/workflows/lane/common.ts` names each lane's own type.
2. **A recorded phase replays its result, not its effect on the environment.** `install` was a `code`
   phase; the hotfix lane's in-lane gate tore the worktree down, the replay returned the recorded
   string without running, and `verify` typechecked a worktree with no `node_modules`. Dependencies
   are now a `SandboxHooks` entry, which runs on **every** acquisition. Only a lane with a gate
   *inside* it can find this.
3. **One run leaves a whole copy of the repository under `.sandcastle/worktrees/`,** which broke
   `bun biome check .` — the `lint` command two lanes grade a change with — on *"Found a nested root
   configuration"*. The root `.gitignore` now covers it, as it already covered `.claude/worktrees`.

**Two left standing, named rather than faked.** `kojo doctor` fails Kojo's own factory on
`credentials`: it wants `.kojo/.env`, which is ignored and so never arrives with a clone, and which
nothing at run time reads — `SandcastleAgentInvoker` passes no `env` at all. And a runner holds the
workflow module it loaded at start, so editing `.kojo/` while a run is suspended means the process
that resumes it may run different code; run `a95dd18a` did exactly that and was re-run before
anything was claimed. Both are in typescript-effect.md §12.

**Every agent call was a scripted shell script on the child's `PATH`, not a model.** The five
authorised real agent calls were spent before this ticket. So this proves the factory, the
durability, the trace, the Console and the merge — and it does **not** prove a real model's output
surviving the envelope contract across many runs: no decode failure was repaired, no `corrections`
counter advanced, and the router read a marker rather than judging. The taxonomy is proven; the
classifier is not. §12 says so in the same words.

Regenerate the stamped skill after editing `templates/skills.ts` — `ownFactory.test.ts` asserts the
two are byte-identical:

```
bun -e 'import{skill,authoring,skillsDirectory}from"./packages/kojo/src/contexts/scaffold/templates/skills.ts";import{writeFileSync}from"node:fs";writeFileSync(`${skillsDirectory}/SKILL.md`,skill());writeFileSync(`${skillsDirectory}/authoring.md`,authoring())'
```

**Checks.** Unit 582 (74 files), integration 249 + 3 skipped (43 files), browser 91 specs, all green;
`bun tsc --build --force --verbose` names 3 projects, `bun biome check .` and `bun knip` clean from
the root. `.kojo/` is typechecked by `ownFactory.test.ts` because it is not in `bun tsc --build` — see
the note in `.kojo/tsconfig.json`.

Two earlier integration runs each timed out on a *different* test inside `lane.test.ts`'s real-Docker
`describe`, while `kojo ui` and `kojo watch` were both running for the demonstration. Neither
reproduced on the clean run above. That is the flakiness the file's own header measures — each
occurrence costs a ~40 s container rebuild against a 180 s timeout — and not a regression: the file is
byte-identical to `feat/kojo-v1` and nothing this branch touches is on its import path.

**That was left argued rather than proven, and the integration wave settled it.** The tier was run
four times on the merged tree: three passed 249/249 and one failed with
*"Test timed out in 180000ms"* on `suspends inside its sandbox, and another process finishes what it
started`. Then `lane.test.ts` was run alone: **all 8 tests passed in 50 s**. So one test exceeded 180 s
while the whole file needs 50 s uncontended — and the tier run that failed took **5m33s against 143 s**
for the runs that passed, a machine 2.3× slower. `git show fb68ec5:…lane.test.ts | shasum` equals the
same command on `HEAD`, so the file is byte-for-byte what it was before the merge and cannot have
regressed. Resource contention, measured, not a fault in the branch.

---

**Independent re-walk, then integration.** A second person checked `9354a09` out cold, wrote their
own stand-in, and drove the committed factory through **seven more runs** without building anything.
Verdict: *merge with fixes*. Every claim above held, and the re-walk turned five things from argued
into measured — `PermissionBreach` undoing a real write (which the implementer had explicitly
recorded as never having happened), `GateRejected` at the asking limit, the revise loop across three
acquisitions, `NotAccepted` refusing the merge in 1 ms, and the fact that a nested worktree with no
`node_modules` fails `TS2307`, so the post-gate green was real work rather than a vacuous pass.

**Criterion 1 is met, but its evidence needed softening, and this is the honest wording.** The
factory was **demonstrated**, not used to produce this deliverable. `9354a09` is a single
hand-authored commit on a linear branch; the seven runs merged throwaway notes onto a scratch trunk
that was then deleted. "The one you would use to develop Kojo" is true of the artefact — the commands
are real, the lanes really differ, `doctor` accepts it once the credential is exported — but no line
of the deliverable came out of a lane.

**Criteria 4 and 5 were recorded THIN by the re-walk, and the reason was the same in both: the last
mile.** Everything claimed of the Console is there and was used, but on a fresh clone `kojo ui`
serves no Console at all until `moon run console:build` has run, and nothing said so. The stamped
skill's content is good, but `kojo` is not on the `PATH` it assumes, and nothing in it warned that
`kojo watch` and `kojo ui` never exit — the omission that destroyed the first attempt at this ticket
after two hours. Worst of all, `kojo doctor`'s printed remedy for the one check it fails told the
reader to re-run `kojo init`, which in this repository writes eight files, adds a second workflow that
does not compile, and takes `doctor` from one failed check to two. That was reproduced exactly
(**8 written, 7 kept**) before being fixed.

All four are now fixed, in `readiness.ts`, `templates/skills.ts` (with `SKILL.md` regenerated from it
so the byte-identity assertion still holds), `console/shell.ts`'s placeholder page, and
`.kojo/README.md`. §12 records all four, plus three things left standing — `doctor`'s credentials
check, a runner holding a stale workflow module, and the fact that **no lane of this factory can
grade the factory**, since `.kojo/` sits outside the `bun tsc --build` that every lane's `typecheck`
runs.

**Sharper than "not exercised": the correction turn is unreachable with any stand-in.** A repair
resumes the captured provider session, so a scripted agent's repair always dies
`resumeSession "…" not found`. `corrections` can only ever be moved by a real agent call.

Merged to `feat/kojo-v1` as a `--no-ff` merge commit. `main` untouched at `927413d`. The scratch
trunk branches and every `kojo/<run id>` branch from the demonstrations are evidence only and were
deleted after being read.
