# 02 — The kojo CLI entrypoint

**What to build:** `kojo` is a real command. Running it with no arguments prints help; `--version` prints the version. This is the shell that every later command hangs off, so the environment and the argv seam are settled once here rather than per command.

**Blocked by:** 01

**Status:** done

- [x] `kojo --help` and `kojo --version` work from a shell after a local install
- [x] The command runs on the Bun services layer that supplies the whole command environment in one line
- [x] argv is read from the framework's stdio service, not from the process global, so a test can drive the CLI without spawning
- [x] A unit test drives the CLI end to end through the test stdio layer
- [x] The five framework-reserved global flags are documented in the package so nobody later tries to claim them

## Comments

Done. `kojo --version` prints `kojo v0.0.0` from a real shell, and a bare `kojo` renders help.

Three findings that cost a debugging cycle each, recorded so ticket 12 does not repeat them:

- **The built-in flags render through `Console.log`** — not through the stdio sinks, and not
  through `Terminal.display`. A test that captures either of those sees an empty string and fails
  with no clue why. `it.effect` already supplies a `TestConsole`, so `TestConsole.logLines` reads
  them.
- **`runWith` does not print help. It raises `ShowHelp` in the typed error channel** and leaves
  rendering to `Command.run`. That makes the unit seam a test of parsing and dispatch, which is
  the right thing for a unit test to assert.
- **`Effect.either` is a v3 API.** The Effect language service flagged it at build time and named
  the replacement: `Effect.result`, returning `Result` rather than `Either`. Worth knowing that
  this diagnostic works and is worth reading — it caught this before a single test ran.

The five reserved global flags are confirmed by the rendered help: `--help/-h`, `--version/-v`,
`--wizard`, `--completions`, `--log-level`.

Deferred deliberately: `Command.withSharedFlags` is documented on the root command but not yet
used, because there is no subcommand to share a flag with. Ticket 12 adds the first one.
