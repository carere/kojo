# 44 — `kojo init` produces a factory that cannot run

**What to build:** A factory `kojo init` stamps runs, on the machine it was stamped on, without the
person having to work out what is missing.

Found by walking the loop after ticket 30. `kojo init` stamps 11 files and exits 0. **Every stamped
file imports `kojo` and `effect`, and `init` writes no `package.json` and adds no dependency** — so
nothing resolves. The stamped README asserts *"the engine is a versioned dependency in your
`package.json`"*: a file `init` never created and never mentions.

Worse, and the reason this is not merely cosmetic: **`init` declares no version for the one
dependency that must match exactly.** With two copies of `effect` resolved, a run dies with a raw
framework error and no Kojo diagnosis:

```
TypeError: Cannot convert a symbol to a string
    at idempotencyKey (.kojo/workflows/review.ts:122:44)
```

Two `Schema` module instances, so the payload struct's fields do not line up. **`kojo doctor`
reported the factory ready** — it loads a workflow but never builds a payload, so the one check that
exists to refuse an unready factory passed it.

**Blocked by:** 22, 23

**Status:** done

- [x] A freshly stamped factory can run its own starter without a person adding anything by hand
- [x] The engine dependency is declared with a version, and `effect` is pinned to the single version
      the engine was built against — a second copy is the failure this ticket exists to prevent
- [x] `kojo doctor` refuses a factory whose engine or `effect` does not match, **before** a run
      fails — it must build a payload, not merely load a workflow
- [x] A mismatched engine fails with a Kojo diagnosis naming the two versions, never a raw
      framework `TypeError`
- [x] The stamped README describes only files that exist, and its walk-through works followed
      literally
- [x] `--agent claude` is accepted, or the prompt-free path documents `claude-code` before offering it

## Comments

**What was added.** `kojo init` now writes the repository's own `package.json` before it stamps
anything: created when there is none, **merged** when there is one, and never changing a value
already there — a scaffolder that silently re-pinned somebody's `effect` would be the same class of
defect as one that silently replaced their workflow. Both specifiers are derived from the packages
this process actually loaded (`contexts/shared/services/resolvePackage.ts`), so the `effect` pin has
exactly one home and no second place to drift from.

**Two reaches, not one.** An installed engine declares versions. An engine run from a checkout has
no published version to name, so both entries become `file:` paths to the copies *this machine*
holds. Pointing `kojo` at a checkout and `effect` at a version was tried first and is exactly the
bug: the target resolves a second `effect` at the same version and the run dies in the framework.

**The check that was missing** is `dependencies`, and its identity is the realpath of a package's
**manifest**, not of its directory. That distinction was found by using it: `bun install` does not
link a `file:` dependency's directory, it fills a real directory with a link per file — so a
directory comparison called a working factory two copies. `kojo doctor` also builds a payload now
(`payload`), which is what loading a workflow is not: a module holding a second `effect` imports
perfectly well, and `Workflow.execute` is the first thing to touch both schemas.

**`loadWorkflow` refuses before the import**, so `kojo run`, `kojo watch` and `kojo gate answer` all
report the same sentence instead of a `TypeError` — proven by mutation: with the guard removed the
integration test reproduces `Cannot convert a symbol to a string at idempotencyKey
(.kojo/workflows/review.ts:122:44)` verbatim.

**One real agent call was spent**, unintentionally: `kojo run review` in a throwaway repository while
proving that the `file:` pair resolves end to end, before the loader guard existed. The run reached
its gate. Nothing after that point invoked an agent.
