#!/usr/bin/env bun

import { runProjectListCommand } from "./src/contexts/workflow-execution/projects/use-cases/run-project-list-command";

if (import.meta.main) {
  process.exitCode = await runProjectListCommand(process.argv.slice(2));
}
