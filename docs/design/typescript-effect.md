# TypeScript and Effect design

## Process model

Kojo has one per-user Daemon. The lifecycle manager installs, starts, stops, and reports that
Daemon. CLI commands use the versioned HTTP API. The Console uses the same API.

The Daemon constructs the SQLite layer once. Repository-local clients never construct storage,
Sharding, or Workflow execution layers.

## Runtime model

Factory source imports deep paths from `@carere/kojo-runtime`. A Workflow bundle provides a
definition and its Effect Layer. The Daemon captures exact source, assets, resolved packages, and
Effect identity as a Workflow Revision before a Run can start.

The private Runner loads only captured Revisions. It executes `effect/unstable/workflow` programs,
records activity, and recovers suspended Runs. Trigger is a runtime port that can supply events to
the Runner. It is not a CLI polling service.

## Client commands

```text
kojo daemon install|start|stop|status|logs
kojo project register|list|status|relocate|archive|restore|configure|repair
kojo workflow list|status|start|stop
kojo run list|status|cancel|resume
kojo gate list|answer
kojo ui
```

`workflow start` accepts a JSON payload. `run` only manages existing Runs. `ui` launches the
Daemon-hosted Console and returns.

## Errors

Expected failures use typed error channels. Process ownership, unavailable Revisions, invalid
payloads, and Gate conflicts have stable API errors. Removed legacy surfaces are parse, resolution,
or export failures. They are not compatibility redirects.

## Package checks

The package graph has no barrels. Type declarations must not leak `Effect<any, any, any>`. Knip
must report no dead compatibility surface.

## Agent selection at the call

Each `agent(...)` call supplies an agent label, `model`, `provider`, `system`, and `prompt`.
The label identifies the work. It does not select an entry from a roster. The provider function
receives the call definition and returns a Sandcastle agent provider. For example,
`SandcastleAgentInvoker.claude` selects Claude Code with the call's model. A Factory can use
`(definition) => kojoPi(definition)` for pi, or a different provider for another call.

Provide `SandcastleAgentInvoker.layer` inside the sandbox scope. Session capabilities depend on
both the selected provider and that Sandbox. A correction reuses the call's provider and model.

System and user prompts can stay in separate files. The authored Workflow reads them and builds
the user task explicitly. The runtime adds the answer schema to the task. The generated examples
show these reads beside the call. A Factory does not need `kojo.config.yaml`. `commands.ts` and
`envelopes.ts` are optional helper modules; when present, the validator checks their contracts.

## Factory asset references

A Factory needs no `factory.json` asset declaration. Capture follows literal relative
`new URL("../prompts/system.md", import.meta.url)` references in the selected Workflow and its
source imports. The generated prompt reads use this form. Non-source static imports are also
retained. Assets can contain JavaScript or TypeScript when a URL references them as data.

Use the optional `assets` field in `workflow(...)` for additional inputs, such as
`assets: [new URL("../sandbox/Dockerfile", import.meta.url)]`. List each required Docker build
input with a literal relative URL. Keep computed paths out of asset references. `tsconfig.json`
remains shared resolution configuration. The obsolete `factory.json` file is ignored.

Capture rejects credential paths, runtime data, symbolic links, and references that leave
`.kojo`. It does not copy unrelated Factory or Project files. Keep credentials outside authored
prompts and assets. The capture records hashes and modes, verifies copied bytes, and checks the
source and asset sets again before it publishes a Revision. A Run continues to read its retained
files after the current Factory changes.
