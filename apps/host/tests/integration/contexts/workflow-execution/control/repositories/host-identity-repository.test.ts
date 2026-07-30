import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { loadHostIdentity } from "../../../../../../src/contexts/workflow-execution/control/repositories/host-identity-repository";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Host Identity Store", () => {
  it.effect("persists one opaque Host Identity across Host activations", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-identity-")));
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "host-identity");

      const first = yield* Effect.promise(() => loadHostIdentity(path));
      const second = yield* Effect.promise(() => loadHostIdentity(path));

      expect(first).toMatch(/^host:[0-9a-f-]{36}$/);
      expect(second).toBe(first);
      expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600);
    }),
  );
});
