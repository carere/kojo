import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import { afterEach, describe, expect, it } from "vitest";
import { replayHostClientRequest } from "../../../../src/contexts/daemon/adapters/HostClientRequestReplay.ts";
import { HostClientRequestRepository } from "../../../../src/contexts/daemon/adapters/HostClientRequestRepository.ts";
import { ManagedDaemonSupervision } from "../../../../src/contexts/daemon/adapters/ManagedDaemonSupervision.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";

const roots: Array<string> = [];
const start = Date.parse("2026-09-02T00:00:00.000Z");
const request: MutationEnvelope = {
  mutationVersion: 1,
  requestId: "request-retention",
  dataIdentity: "data-retention",
  operation: "configureProject",
  target: { identityVersion: 1, kind: "project", parts: ["project-a"] },
  arguments: { secret: "must-not-survive-compaction" },
  preconditions: { revision: 4 },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("HostClientRequestRepository", () => {
  it("keeps full resolved content for 30 days then atomically compacts to identity and result references", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-client-retention-"));
    roots.push(root);
    let now = start;
    const repository = new HostClientRequestRepository(root, request.dataIdentity, () => now);
    repository.prepare(request);
    repository.requireExact(request);
    repository.resolve(request.requestId, {
      resolvedAt: new Date(now).toISOString(),
      status: "committed",
      resultReference: {
        identityVersion: 1,
        kind: "clientRequestResult",
        parts: [request.requestId],
      },
    });

    now += 15 * 24 * 60 * 60 * 1_000;
    repository.resolve(request.requestId, {
      resolvedAt: new Date(now).toISOString(),
      status: "committed",
      resultReference: {
        identityVersion: 1,
        kind: "clientRequestResult",
        parts: [request.requestId],
      },
    });
    now += 15 * 24 * 60 * 60 * 1_000 - 1;
    expect(repository.lookup(request.requestId)?.request).toEqual(request);

    now += 1;
    const compacted = repository.lookup(request.requestId);
    expect(compacted).toMatchObject({
      requestId: request.requestId,
      dataIdentity: request.dataIdentity,
      subject: { operation: "configureProject", targetKind: "project" },
      resolution: {
        status: "committed",
        resultReference: { kind: "clientRequestResult", parts: [request.requestId] },
      },
    });
    expect(compacted?.request).toBeUndefined();
    expect(compacted?.body).toBeUndefined();

    const path = join(root, request.dataIdentity, request.requestId, "request.json");
    const retained = readFileSync(path, "utf8");
    expect(retained).not.toContain("must-not-survive-compaction");
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(
      new HostClientRequestRepository(root, request.dataIdentity, () => now).lookup(
        request.requestId,
      ),
    ).toEqual(compacted);
  });

  it("refuses changed content under a prepared request identity", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-client-conflict-"));
    roots.push(root);
    const repository = new HostClientRequestRepository(root, request.dataIdentity, () => start);
    repository.prepare(request);
    expect(() =>
      repository.requireExact({
        ...request,
        arguments: { secret: "replacement" },
      }),
    ).toThrow(/different request content/);
  });

  it("replays an exact Host repair without accepting replacement content", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-client-host-replay-"));
    roots.push(root);
    const dataRoot = join(root, "data");
    const paths: DaemonPaths = {
      installationRoot: join(root, "installation"),
      dataRoot,
      configurationRoot: join(root, "configuration"),
      cacheRoot: join(root, "cache"),
      runtimeRoot: join(root, "runtime"),
      serviceDefinition: join(root, "configuration", "kojo.service"),
      managedCli: join(root, "installation", "bin", "kojo"),
      managedLauncher: join(root, "installation", "bin", "kojo-launcher"),
    };
    mkdirSync(join(dataRoot, "lifecycle"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataRoot, "lifecycle", "data-identity"), "data-retention\n", {
      mode: 0o600,
    });
    const supervision = new ManagedDaemonSupervision(dataRoot);
    const initial = supervision.prepareAttempt();
    if (initial.outcome !== "scheduled") throw new Error("the initial attempt was not scheduled");
    supervision.startAttempt(initial.attemptId);
    supervision.activatePolicy(initial.attemptId, {
      restartDelaysMs: [1],
      healthyResetMs: 10,
    });
    supervision.finishAttempt(initial.attemptId, { detail: "test exhaustion" });
    const automatic = supervision.prepareAttempt();
    if (automatic.outcome !== "scheduled")
      throw new Error("the automatic attempt was not scheduled");
    await Bun.sleep(2);
    supervision.startAttempt(automatic.attemptId);
    supervision.finishAttempt(automatic.attemptId, { detail: "test budget exhaustion" });
    const plan = supervision.checkRepair().repairPlan;
    if (plan === undefined) throw new Error("the repair plan was not issued");
    const mutation: MutationEnvelope = {
      ...request,
      requestId: "request-host-repair",
      operation: "repairDaemonSupervision",
      target: { identityVersion: 1, kind: "daemonData", parts: [request.dataIdentity] },
      arguments: { planToken: plan.planId },
      preconditions: {},
    };
    const repository = new HostClientRequestRepository(
      join(dataRoot, "client-requests"),
      request.dataIdentity,
    );
    repository.prepare(mutation);
    expect(() =>
      repository.requireExact({ ...mutation, arguments: { planToken: "replacement" } }),
    ).toThrow(/different request content/);

    const receipt = await replayHostClientRequest(paths, mutation.requestId);
    expect(receipt).toMatchObject({
      operation: "repairDaemonSupervision",
      status: "committed",
      result: { state: "idle", repairRequired: false },
    });
    expect(repository.lookup(mutation.requestId)?.resolution).toMatchObject({
      status: "committed",
      resultReference: { kind: "clientRequestResult", parts: [mutation.requestId] },
    });
    expect(await replayHostClientRequest(paths, mutation.requestId)).toMatchObject({
      operation: "repairDaemonSupervision",
      status: "committed",
      result: { identityVersion: 1, kind: "clientRequestResult", parts: [mutation.requestId] },
    });
    expect(supervision.checkRepair()).toMatchObject({ state: "idle", repairRequired: false });
  });
});
