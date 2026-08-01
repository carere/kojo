import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  DeletionClock,
  DeletionClockLive,
} from "../../../../../src/contexts/workflow-execution/deletion/services/deletion-clock";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

it("keeps test-only clock and crash controls out of the production layers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-deletion-runtime-"));
  temporaryDirectories.push(directory);
  const clockPath = join(directory, "clock");
  await writeFile(clockPath, "123");
  const previousClockPath = process.env.KOJO_TEST_DELETION_CLOCK_FILE;
  process.env.KOJO_TEST_DELETION_CLOCK_FILE = clockPath;
  try {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(DeletionClockLive)));
    expect(Context.get(context, DeletionClock).now()).toBeGreaterThan(1_000_000_000_000);
  } finally {
    if (previousClockPath === undefined) delete process.env.KOJO_TEST_DELETION_CLOCK_FILE;
    else process.env.KOJO_TEST_DELETION_CLOCK_FILE = previousClockPath;
  }

  const hooksPath = fileURLToPath(
    new URL(
      "../../../../../src/contexts/workflow-execution/deletion/services/deletion-hooks.ts",
      import.meta.url,
    ),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Context, Effect, Layer } from "effect";
import { DeletionHooks, DeletionHooksLive } from ${JSON.stringify(hooksPath)};
const context = await Effect.runPromise(Effect.scoped(Layer.build(DeletionHooksLive)));
await Effect.runPromise(Context.get(context, DeletionHooks).afterPhase("quiescing"));`,
    ],
    {
      cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
      env: { ...process.env, KOJO_TEST_DELETION_CRASH_PHASE: "quiescing" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const diagnostic =
    child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : "";
  expect(await child.exited, diagnostic).toBe(0);
});
