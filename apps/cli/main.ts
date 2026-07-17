#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { deliveryCommand } from "./src/commands/delivery";
import { serveCommand } from "./src/commands/serve";

export const kojoCommand = Command.make("kojo").pipe(
  Command.withDescription("Run Kojo delivery workflows and services"),
  Command.withSubcommands([serveCommand, deliveryCommand]),
);

if (import.meta.main) {
  kojoCommand.pipe(
    Command.run({ version: "0.1.0" }),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain,
  );
}
