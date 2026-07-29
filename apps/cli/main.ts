#!/usr/bin/env bun

import { runCliCommand } from "./src/cli/run-cli-command";

if (import.meta.main) {
  process.exitCode = await runCliCommand(process.argv.slice(2));
}
