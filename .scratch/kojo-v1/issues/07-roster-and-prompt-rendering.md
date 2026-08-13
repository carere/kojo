# 07 — The roster and prompt rendering

**What to build:** Agents are defined in a config file the factory owns — one agent, one prompt, one purpose — and an agent's prompt carries the exact JSON Schema of the envelope it must return. A bad roster fails at load with a path-precise message, before anything spawns.

**Blocked by:** 04, 05

**Status:** done

- [x] The roster is decoded through a schema, and a malformed entry reports the path that is wrong
- [x] A roster referencing an agent with no prompt files fails at load, not at first call
- [x] The rendered prompt inlines the envelope's schema definition rather than emitting a bare reference, so the agent never receives a dangling pointer
- [x] The output tag in the prompt is derived from the envelope, so the example cannot drift from the contract
- [x] An in-memory roster adapter backed by a plain object exists for tests

## Comments

### What landed

- `src/contexts/agent/ports/Roster.ts` — `names` is a plain value and `definition(name)` is the only
  effect. A roster is read once at load, so the only failure left at a call site is a workflow
  naming an agent the roster does not define.
- `src/contexts/agent/models/AgentDefinition.ts` — name, purpose, model, tools, `system`, `user`.
- `src/contexts/agent/models/RosterEntry.ts` — `rosterEntryFields`, the half both spellings of a
  roster share, so a fixture roster and a real one cannot drift into two contracts.
- `src/contexts/agent/models/RosterError.ts` — one `Schema.TaggedError` over four faults
  (`unreadable`, `malformed`, `no-prompt`, `unknown-agent`), carrying `DecodeIssue[]`.
- `src/contexts/agent/services/rosterFrom.ts` — the tail both adapters share.
- `src/contexts/agent/adapters/YamlRoster.ts` — `kojo.config.yaml` plus `prompts/<name>/{system,user}.md`.
- `src/contexts/agent/adapters/InMemoryRoster.ts` — the object roster, decoded by the same helper.
- `src/contexts/agent/services/renderPrompt.ts` — `renderPrompt` and `outputTag`.

### Deviations and calls made

- **`user.md` is required as well as `system.md`.** The design record names both files, so "half a
  prompt" is not a state the loader admits. There is a test for it.
- **The prompt directory is a convention with an override.** Absent, an agent's prompts are read
  from `prompts/<name>` relative to the config file; a `prompts:` key on the entry overrides it.
  A per-key default could not be expressed as a decoding default, because `withDecodingDefaultKey`
  takes a constant Effect and cannot see the record key.
- **The loader ignores every key that is not `agents`.** `kojo.config.yaml` also carries the sandbox
  and agent defaults, and a struct that refused an unknown key would make the roster loader the
  gatekeeper of a file it does not own. `Schema.Struct` ignores excess properties by default, which
  is what this relies on — verified by running it.
- **`renderPrompt` emits the user prompt only.** `system` is the agent's identity and belongs to the
  provider that spawns it (§7, `kojoPi`), not to the text of one turn. Ticket 18's territory.
- **Prompts are read serially** (`{ concurrency: 1 }`), so which agent gets named in a `no-prompt`
  fault does not depend on disk timing.
- No change to `PhaseRecord.ts`. No new Moon task and no new Vitest project — the existing `test`
  and `test-integration` tasks glob the new files.

### API findings

- **`Schema.toJsonSchemaDocument` returns `{ dialect, schema, definitions }`, and
  `JsonSchema.resolveTopLevel$ref` is the supported way to dereference the root.** It leaves the
  root definition in `definitions`, so emitting `definitions` verbatim prints the envelope twice.
  The renderer therefore resolves the root and then attaches, as `$defs`, only the definitions the
  resolved schema can still reach, followed transitively. For a flat envelope that set is empty and
  the prompt shows one self-contained object; for an envelope with a nested `Schema.Class` field the
  document keeps `{ "$ref": "#/$defs/FindingEncoded" }` and exactly that definition travels with it.
  `JsonPointer.unescapeToken` is exported from `effect` and is what turns a pointer into a name.
  This mirrors what `AnthropicStructuredOutput.toCodecAnthropic` does upstream, minus the pruning.
- **A nested `Schema.Class` field is emitted under its *encoded* name** — `Finding` appears as
  `FindingEncoded` in `$defs`. Nothing to do about it, but a test that hard-codes the name has to
  know.
- **`effect/unstable/encoding/Yaml` exposes `parse` only** — a synchronous function that **throws**
  `SyntaxError` naming the line. There is no YAML `Schema` codec, so the adapter wraps it in
  `Effect.try`. It is a focused YAML 1.2 subset: block and flow collections, quoted and block
  scalars, anchors and aliases, one document per file. Tabs in indentation are a hard error, which
  is what the "not yaml" test uses.
- **`Schema.tag` shows up in JSON Schema as `{ "type": "string", "enum": ["Name"] }`**, which is
  where `outputTag` reads it from — the same object the prompt prints, so the prose and the contract
  cannot disagree.
- **`DecodeIssue.fromSchemaError` already gives the path-precise report** the roster needed
  (`agents.scout.model`), and `decodeUnknown`'s `errors: "all"` is what makes it report every bad
  key in one load rather than one per load.

### Environmental blocker — moon cannot run in a worktree

`proto` refuses every command from this worktree:

```
proto::config::lockfile_already_exists
  × Unable to lock the directory ~/Projects/kojo as a lock file already exists in the child
  │ directory ~/Projects/kojo/.claude/worktrees/wf_e3a1e321-aa9-2. Nested lock files are not
  │ supported. Instead, lock the parent directory.
```

The worktrees sit **inside** the repository, so proto walks up from a worktree and finds two
`.prototools` files on the chain — the worktree's own and the repository's — both carrying
`unstable-lockfile = true`. It reads that as nested lock files and stops. Every proto shim is
affected (`bun`, `node`, `moon`), so `bun install`, `moon query tasks`, and `moon run` all fail.
`PROTO_CONFIG_MODE=local` and `PROTO_UNSTABLE_LOCKFILE=false` do not help.

The workaround used here — and, from the leftovers in the shared scratchpad, in waves 1 and 2 as
well — is to put the raw proto-installed binaries on `PATH` ahead of the shims and run each moon
task's command directly. **This wants fixing once, by the integrator**, since it belongs to root
config this ticket must not touch. Either move `.claude/worktrees/` outside the repository, or drop
`unstable-lockfile` from the root `.prototools`.
