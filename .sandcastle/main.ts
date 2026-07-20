#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { deliveryCommand } from "./src/commands/delivery";
import { previewCommand } from "./src/commands/preview";

export const sandcastleCommand = Command.make("sandcastle").pipe(
  Command.withDescription("Run Delimoov delivery and preview workflows"),
  Command.withSubcommands([deliveryCommand, previewCommand]),
);

if (import.meta.main) {
  sandcastleCommand.pipe(
    Command.run({ version: "0.1.0" }),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain,
  );
}
