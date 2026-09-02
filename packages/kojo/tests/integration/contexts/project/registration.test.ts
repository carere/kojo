import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ClientRequestDocument,
  ClientRequestSnapshot,
  ProjectSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteResourceLeaseRepository } from "../../../../src/contexts/project/adapters/SqliteResourceLeaseRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";
import { sendPreparedMutation } from "../../../support/daemon/preparedMutation.ts";

const roots: string[] = [];
const daemons: RunningDaemon[] = [];

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(tmpdir(), "kojo-project-registration-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const result = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(result);
  return result;
};

const repository = (parent: string, name: string): string => {
  const root = join(parent, name);
  mkdirSync(root);
  execFileSync("git", ["init", "--initial-branch=main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Kojo Test"]);
  writeFileSync(join(root, "README.md"), `${name}\n`);
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-m", "test: initial"]);
  return realpathSync(root);
};

const mutation = (
  daemon: RunningDaemon,
  requestId: string,
  location: string,
): MutationEnvelope => ({
  mutationVersion: 1,
  requestId,
  dataIdentity: daemon.endpoint.dataIdentity,
  operation: "registerProject",
  target: {
    identityVersion: 1,
    kind: "daemonData",
    parts: [daemon.endpoint.dataIdentity],
  },
  arguments: { location },
  preconditions: {},
});

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

const prepare = (daemon: RunningDaemon, input: MutationEnvelope): Promise<Response> =>
  call(daemon, `/api/v1/client-requests/${input.requestId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

const retry = (daemon: RunningDaemon, requestId: string): Promise<Response> =>
  call(daemon, `/api/v1/client-requests/${requestId}/retry`, { method: "POST" });

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable Project registration", () => {
  it("prepares every Console mutation family but exposes only redacted subjects", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const operations = [
      "relocateProject",
      "archiveProject",
      "restoreProject",
      "startWorkflow",
      "stopWorkflow",
      "cancelRun",
      "retryUncertainAction",
      "recordGateVerdict",
    ] as const;
    for (const operation of operations) {
      const requestId = `console-${operation}`;
      const response = await prepare(daemon, {
        mutationVersion: 1,
        requestId,
        dataIdentity: daemon.endpoint.dataIdentity,
        operation,
        target: { identityVersion: 1, kind: "resource", parts: [operation] },
        arguments: { reason: "private-reason", token: "private-token" },
        preconditions: { secret: "private-precondition" },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toEqual({
        subject: { requestId, operation, targetKind: "resource" },
        status: "accepted",
      });
    }
    const recent = await (await call(daemon, "/api/v1/client-requests")).text();
    for (const operation of operations) expect(recent).toContain(operation);
    for (const privateValue of ["private-reason", "private-token", "private-precondition"])
      expect(recent).not.toContain(privateValue);
    expect(recent).not.toContain('"arguments"');
  });

  it("keeps exact worktree identity, duplicates, atomic receipts, and Factory states", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const parent = roots[0] ?? "";
    const missing = repository(parent, "same-name");
    const linked = join(parent, "linked", "same-name");
    mkdirSync(join(parent, "linked"));
    execFileSync("git", ["-C", missing, "worktree", "add", "-b", "linked", linked]);
    const invalid = repository(parent, "invalid-factory");
    mkdirSync(join(invalid, ".kojo"));

    const firstRequest = mutation(daemon, "request-one", missing);
    expect((await prepare(daemon, firstRequest)).status).toBe(201);
    const firstResponse = await retry(daemon, firstRequest.requestId);
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const first = (await firstResponse.json()) as OperationReceipt;
    const firstProject = first.result as unknown as {
      readonly created: boolean;
      readonly project: { readonly projectId: string; readonly factoryState: string };
    };
    expect(firstProject.created).toBe(true);
    expect(firstProject.project.factoryState).toBe("missing");
    const recordedOutcome = await call(daemon, "/api/v1/operations/request-one");
    expect(recordedOutcome.status).toBe(200);
    const publicOutcome = await recordedOutcome.text();
    expect(JSON.parse(publicOutcome)).toMatchObject({
      requestId: "request-one",
      operation: "registerProject",
      status: "committed",
      resultReference: {
        identityVersion: 1,
        kind: "operationOutcome",
        parts: ["request-one"],
      },
    });
    expect(publicOutcome).not.toContain(missing);
    expect(publicOutcome).not.toContain("arguments");

    const lostReply = (await (
      await retry(daemon, firstRequest.requestId)
    ).json()) as OperationReceipt;
    expect(lostReply).toEqual(first);

    const duplicateRequest = mutation(daemon, "request-two", missing);
    await prepare(daemon, duplicateRequest);
    const duplicate = (await (
      await retry(daemon, duplicateRequest.requestId)
    ).json()) as OperationReceipt;
    expect(duplicate.result).toMatchObject({
      created: false,
      project: { projectId: firstProject.project.projectId },
    });

    for (const [requestId, location] of [
      ["request-linked", realpathSync(linked)],
      ["request-invalid", invalid],
    ] as const) {
      const input = mutation(daemon, requestId, location);
      await prepare(daemon, input);
      expect((await retry(daemon, requestId)).status).toBe(200);
    }

    const collision = mutation(daemon, firstRequest.requestId, linked);
    expect((await prepare(daemon, collision)).status).toBe(409);

    const snapshot = (await (await call(daemon, "/api/v1/projects")).json()) as ProjectSnapshot;
    expect(snapshot.counts).toMatchObject({
      total: 3,
      available: 3,
      missingFactories: 2,
      invalidFactories: 1,
    });
    expect(snapshot.snapshotVersion).toBe(3);
    expect(snapshot.refreshAfterMillis).toBeGreaterThanOrEqual(250);
    expect(snapshot.refreshAfterMillis).toBeLessThanOrEqual(5_000);
    expect(new Set(snapshot.projects.map((project) => project.projectId)).size).toBe(3);
    expect(
      snapshot.projects.filter((project) => project.label.startsWith("same-name ·")),
    ).toHaveLength(2);
    const retainedPath = join(
      hostPaths.dataRoot,
      "client-requests",
      firstRequest.dataIdentity,
      "request-one",
      "request.json",
    );
    expect(readFileSync(retainedPath, "utf8")).toContain(`"location":"${missing}"`);
    expect(lstatSync(retainedPath).mode & 0o077).toBe(0);
    expect(lstatSync(join(retainedPath, "..")).mode & 0o077).toBe(0);
  });

  it("retains exact requests, receipts, and Recent changes across a Daemon replacement", async () => {
    const hostPaths = paths();
    const project = repository(roots[0] ?? "", "restart-project");
    const first = startDaemon(hostPaths);
    daemons.push(first);
    const input = mutation(first, "request-restart", project);
    await prepare(first, input);
    const firstRetry = await retry(first, input.requestId);
    expect(firstRetry.status, await firstRetry.clone().text()).toBe(200);
    await Effect.runPromise(first.stop);
    daemons.splice(daemons.indexOf(first), 1);

    const replacement = startDaemon(hostPaths);
    daemons.push(replacement);
    const lookup = await call(replacement, `/api/v1/client-requests/${input.requestId}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      subject: { requestId: input.requestId, operation: "registerProject" },
      status: "committed",
    });
    const recent = (await (
      await call(replacement, "/api/v1/client-requests")
    ).json()) as ClientRequestSnapshot;
    expect(JSON.stringify(recent)).not.toContain(project);
    expect(JSON.stringify(recent)).not.toContain("arguments");
    expect(JSON.stringify(recent)).not.toContain("preconditions");
    expect(recent.requests).toContainEqual(
      expect.objectContaining({
        subject: expect.objectContaining({ requestId: input.requestId }),
        status: "committed",
      }),
    );
    expect((await retry(replacement, input.requestId)).status).toBe(200);
    const snapshot = (await (
      await call(replacement, "/api/v1/projects")
    ).json()) as ProjectSnapshot;
    expect(snapshot.counts.total).toBe(1);
  });

  it("keeps an accepted destination reserved and blocks new Run admission across restart", async () => {
    const hostPaths = paths();
    const parent = roots[0] ?? "";
    const origin = repository(parent, "reservation-origin");
    const destination = repository(parent, "reservation-destination");
    let daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const registration = mutation(daemon, "reservation-project", origin);
    await prepare(daemon, registration);
    const registered = (await (
      await retry(daemon, registration.requestId)
    ).json()) as OperationReceipt;
    const projectId = (
      registered.result as unknown as { readonly project: { readonly projectId: string } }
    ).project.projectId;
    const dataIdentity = daemon.endpoint.dataIdentity;
    await Effect.runPromise(daemon.stop);
    daemons.splice(daemons.indexOf(daemon), 1);

    const database = new Database(join(hostPaths.dataRoot, "kojo.db"), { strict: true });
    const projects = new SqliteProjectRepository(database);
    await Effect.runPromise(
      projects.beginLocationChange({
        requestId: "accepted-relocation",
        requestBody: "accepted-relocation",
        dataIdentity,
        projectId,
        action: "relocate",
        requestedLocation: destination,
        changedAt: "2026-09-01T10:00:00.000Z",
      }),
    );
    const runs = new SqliteRunRepository(database, { enforceProjectEligibility: true });
    await expect(
      Effect.runPromise(
        runs.admit({
          dataIdentity,
          requestId: "start-during-drain",
          canonicalRequest: "start-during-drain",
          projectId,
          workflowName: "retained",
          idempotencyKey: "start-during-drain",
          payload: null,
          revisionId: "a".repeat(64),
          packageGraphId: "b".repeat(64),
          admittedAt: "2026-09-01T10:00:00.100Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "RUN_NOT_ELIGIBLE" });
    database.close();

    daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const competing = mutation(daemon, "competing-registration", destination);
    expect((await prepare(daemon, competing)).status).toBe(201);
    const refused = await retry(daemon, competing.requestId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      problem: { code: "PROJECT_LOCATION_RESERVED", retry: "safe" },
    });
    const snapshot = (await (await call(daemon, "/api/v1/projects")).json()) as ProjectSnapshot;
    expect(snapshot.projects.find((project) => project.projectId === projectId)).toMatchObject({
      location: origin,
      locationChange: {
        state: "draining",
        action: "relocate",
        requestedLocation: destination,
      },
    });
  });

  it("requires explicit same-path confirmation and retains identity while locations change", async () => {
    const hostPaths = paths();
    let daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const parent = roots[0] ?? "";
    const firstLocation = repository(parent, "relocating");
    const alternateLocation = repository(parent, "restored");

    const register = async (requestId: string, location: string) => {
      const input = mutation(daemon, requestId, location);
      expect((await prepare(daemon, input)).status).toBe(201);
      const response = await retry(daemon, requestId);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as OperationReceipt;
    };
    const original = await register("location-original", firstLocation);
    const originalId = (
      original.result as unknown as { readonly project: { readonly projectId: string } }
    ).project.projectId;

    const absent = `${firstLocation}-absent`;
    renameSync(firstLocation, absent);
    const unavailable = (await (await call(daemon, "/api/v1/projects")).json()) as ProjectSnapshot;
    expect(unavailable.projects.find((project) => project.projectId === originalId)).toMatchObject({
      projectState: "unavailable",
      locationConfirmed: false,
    });
    renameSync(absent, firstLocation);
    const stillUnavailable = (await (
      await call(daemon, "/api/v1/projects")
    ).json()) as ProjectSnapshot;
    expect(
      stillUnavailable.projects.find((project) => project.projectId === originalId),
    ).toMatchObject({
      projectState: "unavailable",
      locationConfirmed: false,
    });

    const confirmResponse = await sendPreparedMutation(
      daemon,
      `/api/v1/projects/${originalId}/actions/relocate`,
      {
        mutationVersion: 1,
        requestId: "confirm-same-location",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "relocateProject",
        target: { identityVersion: 1, kind: "project", parts: [originalId] },
        arguments: { location: firstLocation },
        preconditions: { confirm: true },
      },
    );
    expect(confirmResponse.status, await confirmResponse.clone().text()).toBe(200);
    expect((await confirmResponse.json()) as OperationReceipt).toMatchObject({
      operation: "relocateProject",
      status: "committed",
      result: {
        project: {
          projectId: originalId,
          projectState: "available",
          locationConfirmed: true,
          refreshState: "pending",
        },
      },
    });

    const archiveMutation: MutationEnvelope = {
      mutationVersion: 1,
      requestId: "archive-original",
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "archiveProject",
      target: { identityVersion: 1, kind: "project", parts: [originalId] },
      arguments: {},
      preconditions: { confirm: true },
    };
    const archiveRequest = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(archiveMutation),
    } satisfies RequestInit;
    const database = new Database(join(hostPaths.dataRoot, "kojo.db"), { strict: true });
    const resources = new SqliteResourceLeaseRepository(database);
    const resourceAuthority = {
      projectId: originalId,
      runId: "retained-run",
      revisionId: "a".repeat(64),
      runnerInstanceId: "runner-before-location-change",
      claimGeneration: 1,
    } as const;
    await Effect.runPromise(
      resources.beginAcquisition(
        {
          ...resourceAuthority,
          leaseId: "lease-before-location-change",
          kind: "worktree",
          acquisitionKey: "retained-run/worktree",
          requestedAt: "2026-09-01T10:00:00.000Z",
          detail: { branch: "kojo/retained-run" },
        },
        {
          providerIdentity: "kojo-resource:location-change",
          inspectionLocator: join(
            hostPaths.dataRoot,
            "resource-inspections",
            "location-change.json",
          ),
        },
      ),
    );
    const heldByResource = await sendPreparedMutation(
      daemon,
      `/api/v1/projects/${originalId}/actions/archive`,
      archiveMutation,
    );
    expect(heldByResource.status).toBe(409);
    const draining = (await (await call(daemon, "/api/v1/projects")).json()) as ProjectSnapshot;
    expect(draining.projects.find((project) => project.projectId === originalId)).toMatchObject({
      projectState: "available",
      locationChange: { state: "draining", action: "archive" },
    });
    const retainedArchive = (await (
      await call(daemon, "/api/v1/client-requests/archive-original")
    ).json()) as ClientRequestDocument;
    expect(retainedArchive).toMatchObject({
      subject: { operation: "archiveProject", targetKind: "project" },
      status: "accepted",
    });
    await Effect.runPromise(daemon.stop);
    daemons.splice(daemons.indexOf(daemon), 1);
    daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    expect(
      (await (
        await call(daemon, "/api/v1/client-requests/archive-original")
      ).json()) as ClientRequestDocument,
    ).toMatchObject({ status: "accepted" });
    await Effect.runPromise(
      resources.confirmAcquired(
        resourceAuthority,
        "lease-before-location-change",
        "2026-09-01T10:00:00.500Z",
        {
          providerIdentity: "kojo-resource:location-change",
          locator: firstLocation,
        },
      ),
    );
    await Effect.runPromise(
      resources.beginRelease(
        resourceAuthority,
        "lease-before-location-change",
        "2026-09-01T10:00:01.000Z",
      ),
    );
    await Effect.runPromise(
      resources.confirmReleased(
        resourceAuthority,
        "lease-before-location-change",
        "2026-09-01T10:00:02.000Z",
        "fixture confirmed release",
      ),
    );
    database.run(
      `INSERT INTO project_runner_recovery (
         project_id, cycle, attempts, state, safety, failed_operation_pending, last_fault
       ) VALUES (?, 1, 1, 'held', 'uncertain', 1, 'fixture recovery is uncertain')`,
      [originalId],
    );
    const heldByRecovery = await call(
      daemon,
      `/api/v1/projects/${originalId}/actions/archive`,
      archiveRequest,
    );
    expect(heldByRecovery.status).toBe(409);
    database.run(
      `UPDATE project_runner_recovery SET state = 'healthy', safety = 'safe',
         failed_operation_pending = 0, last_fault = NULL WHERE project_id = ?`,
      [originalId],
    );
    const archiveResponse = await call(daemon, "/api/v1/client-requests/archive-original/retry", {
      method: "POST",
    });
    expect(archiveResponse.status, await archiveResponse.clone().text()).toBe(200);
    expect((await archiveResponse.json()) as OperationReceipt).toMatchObject({
      status: "committed",
      result: {
        project: {
          projectId: originalId,
          projectState: "archived",
          locationActive: false,
          location: firstLocation,
        },
      },
    });
    database.close();

    const replacement = await register("new-project-at-released-location", firstLocation);
    expect(replacement.result).toMatchObject({ created: true });
    const conflict = await sendPreparedMutation(
      daemon,
      `/api/v1/projects/${originalId}/actions/restore`,
      {
        mutationVersion: 1,
        requestId: "restore-conflict",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "restoreProject",
        target: { identityVersion: 1, kind: "project", parts: [originalId] },
        arguments: { location: firstLocation },
        preconditions: { confirm: true },
      },
    );
    expect(conflict.status).toBe(409);
    const afterConflict = (await (
      await call(daemon, "/api/v1/projects")
    ).json()) as ProjectSnapshot;
    expect(
      afterConflict.projects.find((project) => project.projectId === originalId),
    ).toMatchObject({
      projectState: "archived",
      location: firstLocation,
      locationActive: false,
    });

    const restored = await sendPreparedMutation(
      daemon,
      `/api/v1/projects/${originalId}/actions/restore`,
      {
        mutationVersion: 1,
        requestId: "restore-alternate",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "restoreProject",
        target: { identityVersion: 1, kind: "project", parts: [originalId] },
        arguments: { location: alternateLocation },
        preconditions: { confirm: true },
      },
    );
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await restored.json()) as OperationReceipt).toMatchObject({
      status: "committed",
      result: {
        project: {
          projectId: originalId,
          projectState: "available",
          location: alternateLocation,
          locationHistory: [
            { location: firstLocation, releaseReason: "archived" },
            { location: alternateLocation },
          ],
        },
      },
    });

    const secondArchive = await sendPreparedMutation(
      daemon,
      `/api/v1/projects/${originalId}/actions/archive`,
      {
        mutationVersion: 1,
        requestId: "archive-restored-location",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "archiveProject",
        target: { identityVersion: 1, kind: "project", parts: [originalId] },
        arguments: {},
        preconditions: { confirm: true },
      },
    );
    expect(secondArchive.status, await secondArchive.clone().text()).toBe(200);
    const samePathRestore = await sendPreparedMutation(
      daemon,
      `/api/v1/projects/${originalId}/actions/restore`,
      {
        mutationVersion: 1,
        requestId: "restore-same-path",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "restoreProject",
        target: { identityVersion: 1, kind: "project", parts: [originalId] },
        arguments: { location: alternateLocation },
        preconditions: { confirm: true },
      },
    );
    expect(samePathRestore.status, await samePathRestore.clone().text()).toBe(200);
    expect((await samePathRestore.json()) as OperationReceipt).toMatchObject({
      result: {
        project: {
          locationHistory: [
            { location: firstLocation, releaseReason: "archived" },
            { location: alternateLocation, releaseReason: "archived" },
            { location: alternateLocation },
          ],
        },
      },
    });
  });
});
