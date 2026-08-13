#!/usr/bin/env bun
// Deep paths, not the package barrel. The barrel re-exports `BunRedis`, which imports the `bun`
// builtin, so anything loading it under a Node worker — every Vitest worker, including under
// `bun vitest` — dies at import before a single test runs. The no-barrel rule has teeth here.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { kojo, version } from "./cli/kojo.ts";

// `BunServices.layer` supplies the whole command environment in one line — child process spawner,
// crypto, filesystem, path, stdio, and terminal. argv is read from the stdio service rather than
// from `process.argv`, which is what lets the unit test drive this command without spawning.
kojo.pipe(Command.run({ version }), Effect.provide(BunServices.layer), BunRuntime.runMain);
