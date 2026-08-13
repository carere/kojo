# 38 — `kojo run` must run the factory's workflows, not Kojo's demos

**What to build:** In a repository with a stamped factory, `kojo run <workflow>` runs the workflow
from `.kojo/workflows/`. Today it cannot: there is no loader, and `kojo run --help` lists Kojo's own
two demos identically inside and outside a stamped repo.

Found by wave 7's integrator while checking whether ticket 15 could proceed against a freshly
stamped factory. It cannot, and the failure mode is the worst kind — **a silent false pass.**

The collision is exact:

| | built-in `src/cli/review.ts` | stamped `.kojo/workflows/review.ts` |
|---|---|---|
| name | `review` | `review` |
| idempotency key | `review/${subject}` | `review/${subject}` |
| what it does | **code phases only — no agent, no sandbox** | agent + sandbox + gate |

So `kojo run review "the change"` in a stamped repo runs **the demo**, succeeds quickly, and never
invokes an agent — and the stamped README instructs exactly that command. Ticket 15 has a budget of
five real agent calls; without this, the likely outcome is a confident green that proves nothing.

**Blocked by:** 22

**Status:** done

- [x] `kojo run` in a stamped repository lists and runs the workflows in `.kojo/workflows/`, and
      `--help` reflects what that factory actually has rather than a hard-coded array
- [x] Kojo's built-in demos do not collide with anything a factory may stamp — rename them, scope
      them, or stop shipping them as runnable names; a factory's own workflow always wins
- [x] A run started in a stamped repo is proven by test to have executed **the stamped workflow**,
      not a same-named built-in — assert on something only the stamped one does
- [x] Loading a malformed or missing workflow fails with a path-precise message at load, before
      anything spawns, the way the roster already does
- [x] The stamped README's instructions are true when followed literally in a fresh factory
- [x] The README no longer references `kojo doctor` while that command does not exist, or ticket 23
      lands first

## Comments

Two adjacent facts wave 7 established, worth having here:

- **A freshly stamped factory cannot produce an accepted run**, by design: `commands.test` is a
  placeholder that exits 78, the `verify` phase records `accepted: false`, and `requireAcceptance`
  then fails with `NotAccepted` even after a human approves. Editing `.kojo/commands.ts` is a
  mandatory first step for ticket 15, not an optional one.
- **`kojo doctor` does not exist** (ticket 23), but the stamped README already cites it.

### What was built

**The loader** — `src/contexts/workflow/services/factoryWorkflows.ts`. One file under
`.kojo/workflows/` is one `kojo run` name, and the loader proves the module agrees: a workflow whose
`_tag` is not its file name is refused rather than run under the wrong name. That rule is what makes
`--help` truthful for one `readdir` and no imports at all — the listing is file names, and a name
that would lie about itself cannot be run.

Five faults, every one of them naming an absolute path: `no-factory`, `missing`, `unloadable`,
`malformed`, `misnamed` (`models/WorkflowLoadError.ts`). All are raised before the layers are built.

**The collision, removed by rename.** `hello` and `review` are now `demo-hello` and `demo-review`,
names no `kojo init` template can stamp. `resolve` still prefers the factory — a factory may
legitimately name one `demo-review` — but the precedence now settles a deliberate clash instead of
covering one this build shipped. **There is no fallback:** a factory's own `review.ts` that fails to
load refuses the command; it never reaches a built-in.

**What a loaded workflow is given** — `factory()` now provides `SandcastleSandboxSource` and
`AbsentAgentInvoker` as well, because a factory's own workflow enters a sandbox and calls an agent,
and it does so on `kojo gate answer` too (resuming replays the body and re-enters the scope).

### Proved, and by which test

All in `tests/integration/cli/stampedRun.test.ts`, driving the real CLI as a spawned process from
inside a real stamped repository (`--sandbox none`, `node_modules/kojo` linked as `bun install`
leaves it):

- *"runs the workflow from .kojo/workflows/, which the built-in demos cannot impersonate"* — runs
  literally `kojo run review "the change"` with no flags, and asserts an **`agent` phase** in the
  table and the branch **`kojo/review/the-change`**. The demo has no agent phase and no sandbox, so
  neither record is one it can produce.
- *"suspends at its own gate, and a later process loads the same file to resume it"* — a workflow of
  the factory's own with a gate named `sign-off`; three processes; `kojo gate answer` resumes it and
  runs `file-it`. Nothing Kojo ships has either name.
- *"says what this factory has when asked for help"*, *"refuses a name this factory does not have"*,
  *"refuses at load, by path, before anything spawns"* (and asserts **no branch was cut**),
  *"refuses a workflow whose name is not the name of its file"*, *"does not fall back to a built-in
  when the factory's own file is broken"*.

`tests/unit/cli/workflows.test.ts` grades the help sentence and that no demo can carry a stampable
name.

### Correction from the wave-8 integration (a proof that did not prove what it claimed)

The report for this ticket attributed *"No workflow Kojo ships can carry a name a `kojo init`
template stamps"* to `tests/unit/cli/workflows.test.ts` — *"cannot take a name a factory would
stamp"*. **That attribution was wrong.** The test read `Runnable.name` in `cli/workflows.ts`, which
is the word the CLI matches on and *not* the name that collides. The names that collide are the
workflow definition's own `_tag` — what the engine registers under — and its `idempotencyKey`, which
is what makes two starts one run.

Measured during the merge: putting `src/cli/review.ts`'s definition back to `name: "review"` and
``idempotencyKey: `review/${subject}` `` while leaving the `Runnable` as `demo-review` restored the
exact collision this ticket removes, and **the named test stayed green — so did the whole unit tier
(57 files, 403 tests)**. The mutation was caught only incidentally, by `watch.test.ts` and
`gateAndResume.test.ts`, which happen to spell `demo-review` on a command line.

The code was right; the record was not. A second case in that same `describe` now asserts the prefix
on `hello.definition._tag`, `review.definition._tag` and on both idempotency keys, and it was
verified to go red under the mutation above.

### Two things a reader should not take for more than they are

- **`kojo run review` in a fresh factory fails at `draft`, on purpose.** There is no agent provider
  in this build (ticket 15 owns it), so `AbsentAgentInvoker` refuses every call and says why. The
  run is the factory's own, the sandbox is built and the branch is cut — only the invocation is
  missing. Nothing here proves an agent phase can *succeed*.
- **`kojo run` reports `run failed` without saying why.** Pre-existing and not introduced here:
  `kojo run demo-hello --fail` has always done the same. The failure's `reason` reaches no surface a
  person reads — the phase table carries an outcome, not an error. Worth a ticket before 15 spends
  agent calls debugging blind.
