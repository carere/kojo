#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { program } from "./src/program";

export const kojoCommand = Command.make("kojo").pipe(
  Command.withDescription("Run Kojo"),
  Command.withHandler(() => Effect.flatMap(program, Console.log)),
);

if (import.meta.main) {
  kojoCommand.pipe(
    Command.run({ version: "0.1.0" }),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain,
  );
}
