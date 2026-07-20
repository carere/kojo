#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { deliveryCommand } from "./src/commands/delivery";
import { projectCommand } from "./src/commands/project";
import { serveCommand } from "./src/commands/serve";
import {
  logsCommand,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./src/commands/system";
import { workflowCommand } from "./src/commands/workflow";
import { resolveKojoHome } from "./src/system/lifecycle";
import { runSystemProcess } from "./src/system/process";
import { runProjectRuntime } from "./src/system/project-runtime";

export const kojoCommand = Command.make("kojo").pipe(
  Command.withDescription("Run Kojo Developer Workflows and control the local System Process"),
  Command.withSubcommands([
    startCommand,
    stopCommand,
    restartCommand,
    statusCommand,
    logsCommand,
    projectCommand,
    workflowCommand,
    serveCommand,
    deliveryCommand,
  ]),
);

if (import.meta.main) {
  if (process.env.KOJO_INTERNAL_PROJECT_RUNTIME === "1") {
    runProjectRuntime().catch(() => process.exit(1));
  } else if (process.env.KOJO_INTERNAL_SYSTEM === "1") {
    runSystemProcess(resolveKojoHome()).catch(() => process.exit(1));
  } else {
    kojoCommand.pipe(
      Command.run({ version: "0.1.0" }),
      Effect.provide(BunServices.layer),
      BunRuntime.runMain,
    );
  }
}
