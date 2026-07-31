import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshot } from "@kojo/control";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { StoredExecutionArtifact } from "../../../../../../src/contexts/workflow-execution/runs/repositories/workflow-run-repository";
import {
  ExecutionArtifactStore,
  LocalExecutionArtifactStoreLive,
} from "../../../../../../src/contexts/workflow-execution/runs/services/execution-artifact-store";

const race = vi.hoisted(() => ({
  swap: undefined as (() => Promise<void>) | undefined,
  target: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const swapAfterObservation = async (path: string) => {
    if (path !== race.target || race.swap === undefined) return;
    const swap = race.swap;
    race.swap = undefined;
    await swap();
  };
  return {
    ...original,
    lstat: async (path: string) => {
      const stats = await original.lstat(path);
      await swapAfterObservation(path);
      return stats;
    },
    open: async (path: string, flags: number) => {
      const file = await original.open(path, flags);
      await swapAfterObservation(path);
      return file;
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  race.swap = undefined;
  race.target = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it("never reads a replacement symlink after the Artifact path was observed", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "kojo-artifact-store-race-"));
  cleanups.push(() => rm(projectPath, { force: true, recursive: true }));
  const runId = "00000000-0000-7000-8000-000000000001";
  const artifactId = "00000000-0000-7000-8000-000000000002";
  const artifactPath = join(projectPath, ".kojo", "artifacts", runId, `${artifactId}.json`);
  const safePath = join(projectPath, "safe-artifact.json");
  const outsidePath = join(projectPath, "outside-artifact.json");
  await mkdir(join(projectPath, ".kojo", "artifacts", runId), { recursive: true });
  await writeFile(artifactPath, "safe Artifact content");
  await writeFile(outsidePath, "outside Artifact content");

  // The legacy lstat/readFile sequence would observe the regular file, then
  // follow this replacement link and accept the outside bytes' recorded hash.
  // The pinned-handle adapter either rejects the changed path or reports that
  // the already-opened safe file no longer matches that hash; it never returns
  // the outside content.
  race.target = await realpath(artifactPath);
  race.swap = async () => {
    await rename(artifactPath, safePath);
    await symlink(outsidePath, artifactPath);
  };
  const artifact: StoredExecutionArtifact = {
    artifactId,
    byteSize: Buffer.byteLength("outside Artifact content"),
    condition: "available",
    createdAtMs: 1,
    displayName: "artifact.json",
    mediaType: "application/json",
    sha256: createHash("sha256").update("outside Artifact content").digest(),
    storageKey: `${runId}/${artifactId}.json`,
    unavailableAtMs: null,
    unavailableReasonCode: null,
  };
  const project: ProjectSnapshot = {
    identity: "00000000-0000-7000-8000-000000000003" as ProjectSnapshot["identity"],
    path: projectPath,
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ExecutionArtifactStore;
      return yield* store.read(project, runId, artifact);
    }).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, ok: false as const }),
        onSuccess: (content) => ({ content, ok: true as const }),
      }),
      Effect.provide(LocalExecutionArtifactStoreLive),
    ),
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(["artifact-content-changed", "artifact-content-unsafe"]).toContain(result.failure._tag);
  }
  expect(race.swap).toBeUndefined();
  expect((await lstat(artifactPath)).isSymbolicLink()).toBe(true);
});
