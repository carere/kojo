import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { ProjectSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";

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
    expect(
      readFileSync(join(hostPaths.dataRoot, "client-requests", "request-one.json"), "utf8"),
    ).toContain(`"location":"${missing}"`);
  });

  it("retains exact requests and receipts across a Daemon replacement", async () => {
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
      request: { requestId: input.requestId, arguments: { location: project } },
      receipt: { status: "committed" },
    });
    expect((await retry(replacement, input.requestId)).status).toBe(200);
    const snapshot = (await (
      await call(replacement, "/api/v1/projects")
    ).json()) as ProjectSnapshot;
    expect(snapshot.counts.total).toBe(1);
  });
});
