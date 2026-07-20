import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { acquireTargetLock, releaseTargetLock } from "../../src/workflows/delivery/target";
import { runEffect, runFailure } from "../helpers/effect";
import { runGit } from "../helpers/git";

const withBunServices = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  runEffect(effect.pipe(Effect.provide(BunServices.layer)));

describe("delivery target lock", () => {
  test("recovers an ownerless lock left between claim and owner persistence", async () => {
    const repository = await mkdtemp(join(tmpdir(), "sandcastle-target-lock-"));
    await runGit(repository, "init", "-b", "main");

    try {
      const lockPath = await withBunServices(acquireTargetLock(repository, "delivery/main"));
      await withBunServices(releaseTargetLock(lockPath));
      await mkdir(lockPath);

      const recovered = await withBunServices(acquireTargetLock(repository, "delivery/main"));

      expect(recovered).toBe(lockPath);
      await withBunServices(releaseTargetLock(recovered));
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("takes over a lock whose owner process is dead", async () => {
    const repository = await mkdtemp(join(tmpdir(), "sandcastle-target-lock-"));
    await runGit(repository, "init", "-b", "main");

    try {
      const original = await withBunServices(acquireTargetLock(repository, "delivery/main"));
      await rm(original, { force: true, recursive: true });
      await writeFile(original, "pid=999999999 started=old target=delivery/main\n");

      const recovered = await withBunServices(acquireTargetLock(repository, "delivery/main"));

      expect(recovered).toBe(original);
      expect(await readFile(recovered, "utf8")).toContain(`pid=${globalThis.process.pid}`);
      await withBunServices(releaseTargetLock(recovered));
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("takes over an orphaned stale-lock recovery gate", async () => {
    const repository = await mkdtemp(join(tmpdir(), "sandcastle-target-lock-"));
    await runGit(repository, "init", "-b", "main");

    try {
      const stale = await withBunServices(acquireTargetLock(repository, "delivery/main"));
      const deadOwner = "pid=999999999 started=old target=delivery/main\n";
      await rm(stale, { force: true, recursive: true });
      await writeFile(stale, deadOwner);
      await writeFile(`${stale}.recovery`, deadOwner);

      const recovered = await withBunServices(acquireTargetLock(repository, "delivery/main"));

      expect(recovered).toBe(stale);
      expect(await readFile(recovered, "utf8")).toContain(`pid=${globalThis.process.pid}`);
      await withBunServices(releaseTargetLock(recovered));
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("recovers when a crash leaves only the stale-lock recovery gate", async () => {
    const repository = await mkdtemp(join(tmpdir(), "sandcastle-target-lock-"));
    await runGit(repository, "init", "-b", "main");

    try {
      const lockPath = await withBunServices(acquireTargetLock(repository, "delivery/main"));
      await withBunServices(releaseTargetLock(lockPath));
      await writeFile(`${lockPath}.recovery`, "pid=999999999 started=old target=delivery/main\n");

      const recovered = await withBunServices(acquireTargetLock(repository, "delivery/main"));

      expect(recovered).toBe(lockPath);
      expect(await Bun.file(`${lockPath}.recovery`).exists()).toBe(false);
      await withBunServices(releaseTargetLock(recovered));
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("refuses a lock whose owner process is still alive", async () => {
    const repository = await mkdtemp(join(tmpdir(), "sandcastle-target-lock-"));
    await runGit(repository, "init", "-b", "main");

    try {
      const lock = await withBunServices(acquireTargetLock(repository, "delivery/main"));
      const failure = await runFailure(
        acquireTargetLock(repository, "delivery/main").pipe(Effect.provide(BunServices.layer)),
      );

      expect(failure).toMatchObject({
        _tag: "WorkflowError",
        operation: "delivery.acquireTargetLock",
      });
      expect((failure as Error).message).toContain(`pid=${globalThis.process.pid}`);
      await withBunServices(releaseTargetLock(lock));
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("lets only one concurrent contender replace a stale lock", async () => {
    const repository = await mkdtemp(join(tmpdir(), "sandcastle-target-lock-"));
    await runGit(repository, "init", "-b", "main");

    try {
      const stale = await withBunServices(acquireTargetLock(repository, "delivery/main"));
      await rm(stale, { force: true, recursive: true });
      await writeFile(stale, "pid=999999999 started=old target=delivery/main\n");

      const contenders = await Promise.allSettled([
        withBunServices(acquireTargetLock(repository, "delivery/main")),
        withBunServices(acquireTargetLock(repository, "delivery/main")),
      ]);
      const winners = contenders.filter(
        (result): result is PromiseFulfilledResult<string> => result.status === "fulfilled",
      );
      const winner = winners.at(0);

      expect(winners).toHaveLength(1);
      expect(winner).toBeDefined();
      expect(await readFile(stale, "utf8")).toContain(`pid=${globalThis.process.pid}`);
      if (winner) await withBunServices(releaseTargetLock(winner.value));
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });
});
