#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { startLiveKojoHost } from "../src/composition/live";
import { DeletionClock } from "../src/contexts/workflow-execution/deletion/services/deletion-clock";
import { DeletionHooks } from "../src/contexts/workflow-execution/deletion/services/deletion-hooks";

/** Test-only process composition. Production layers never inspect these variables. */
const deletionClock = (() => {
  const path = process.env.KOJO_TEST_DELETION_CLOCK_FILE;
  if (path === undefined) return undefined;
  return Layer.succeed(DeletionClock, {
    now: () => {
      try {
        const value = Number(readFileSync(path, "utf8").trim());
        return Number.isFinite(value) ? value : Date.now();
      } catch {
        return Date.now();
      }
    },
  });
})();

const deletionHooks = (() => {
  const crashPhase = process.env.KOJO_TEST_DELETION_CRASH_PHASE;
  const lateFilePath = process.env.KOJO_TEST_DELETION_LATE_FILE;
  if (crashPhase === undefined && lateFilePath === undefined) return undefined;
  return Layer.succeed(DeletionHooks, {
    afterPhase: (phase) =>
      Effect.sync(() => {
        if (phase !== crashPhase) return;
        if (lateFilePath !== undefined) writeFileSync(lateFilePath, "created after intent");
        process.kill(process.pid, "SIGKILL");
      }),
  });
})();

if (import.meta.main) {
  const server = await startLiveKojoHost({ deletionClock, deletionHooks });
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => undefined);
}
