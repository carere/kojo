import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { ResourceLeaseClient } from "../../../../src/contexts/project/ports/ResourceLeaseClient.ts";
import { noSandbox } from "../../../../src/contexts/sandbox/adapters/providers.ts";
import { workspaceProbe } from "../../../../src/contexts/sandbox/guards/workspaceIsReachable.ts";
import { ExecResult } from "../../../../src/contexts/sandbox/models/ExecResult.ts";
import { WorktreeState } from "../../../../src/contexts/sandbox/models/WorktreeState.ts";
import { SandboxSource } from "../../../../src/contexts/sandbox/ports/SandboxSource.ts";
import { Workspace } from "../../../../src/contexts/sandbox/ports/Workspace.ts";
import { Tracer } from "../../../../src/contexts/trace/ports/Tracer.ts";
import { CurrentRun } from "../../../../src/contexts/workflow/services/CurrentRun.ts";
import { sandboxed } from "../../../../src/contexts/workflow/services/sandboxed.ts";

describe("controlled Resource lifecycle", () => {
  it("counts real fixture acquisitions and confirmed releases without a paid provider", async () => {
    const events: Array<string> = [];
    let providerAcquisitions = 0;
    let providerReleases = 0;
    const resources = Layer.succeed(ResourceLeaseClient, {
      beginAcquisition: (resource) =>
        Effect.sync(() => {
          events.push(`intent:${resource.kind}`);
          return {
            acquisitionKey: resource.acquisitionKey,
            providerIdentity: `kojo-resource:${resource.leaseId}`,
            inspectionLocator: `/fixture/${resource.leaseId}.json`,
            ...(resource.kind === "worktree" ? { providerLocator: "/fixture/worktree" } : {}),
          };
        }),
      confirmAcquired: (leaseId) => Effect.sync(() => events.push(`acquired:${leaseId}`)),
      beginRelease: (leaseId) => Effect.sync(() => events.push(`release-intent:${leaseId}`)),
      confirmReleased: (leaseId) => Effect.sync(() => events.push(`released:${leaseId}`)),
      preserve: (leaseId) => Effect.sync(() => events.push(`preserved:${leaseId}`)),
      unresolved: (leaseId) => Effect.sync(() => events.push(`unresolved:${leaseId}`)),
    });
    const workspace = Layer.succeed(Workspace, {
      root: "/fixture/worktree",
      hostPath: Option.some("/fixture/worktree"),
      exec: () => Effect.die("unused fixture exec"),
      git: () => Effect.die("unused fixture git"),
      read: () => Effect.die("unused fixture read"),
      write: () => Effect.die("unused fixture write"),
      stat: () => Effect.die("unused fixture stat"),
      unlink: () => Effect.die("unused fixture unlink"),
    });
    const source = Layer.succeed(SandboxSource, {
      acquire: (request, observer) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            providerAcquisitions += 1;
            const acquired = {
              provider: "controlled-fixture",
              capabilities: request.provider.capabilities,
              branch: request.branch,
              worktreePath: "/fixture/worktree",
              exec: (command: string) =>
                Effect.succeed(
                  new ExecResult({
                    argv: [command],
                    exitCode: 0,
                    stdout: command === workspaceProbe ? "/fixture/worktree" : "",
                    stderr: "",
                  }),
                ),
              agent: () => Effect.die("the sandbox fixture cannot resolve an agent provider"),
            };
            yield* observer?.acquired(acquired) ?? Effect.void;
            return acquired;
          }),
          () =>
            Effect.gen(function* () {
              yield* observer?.releaseIntent ?? Effect.void;
              providerReleases += 1;
              yield* observer?.released("sandbox", "fixture counted provider release") ??
                Effect.void;
              yield* observer?.released("worktree", "fixture counted worktree release") ??
                Effect.void;
            }),
        ),
      worktree: (sandbox) =>
        Effect.succeed(
          new WorktreeState({
            head: sandbox.branch,
            detached: false,
            modified: false,
            tracked: false,
            behind: 0,
            ahead: 0,
          }),
        ),
      workspace: () => workspace,
    });
    const tracer = Layer.succeed(Tracer, {
      runStarted: () => Effect.void,
      runFinished: () => Effect.void,
      phaseEntered: () => Effect.void,
      phase: () => Effect.void,
      gate: () => Effect.void,
      sandbox: () => Effect.void,
      occurrence: () => Effect.void,
    });

    await Effect.runPromise(
      Effect.scoped(
        sandboxed(
          { name: "controlled", branch: "kojo/run-controlled", provider: noSandbox() },
          Effect.void,
        ),
      ).pipe(
        Effect.provide(Layer.mergeAll(resources, source, tracer)),
        Effect.provideService(CurrentRun, { runId: "run-controlled" as never }),
      ),
    );

    expect(providerAcquisitions).toBe(1);
    expect(providerReleases).toBe(1);
    expect(events.filter((event) => event.startsWith("intent:"))).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("acquired:"))).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("release-intent:"))).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("released:"))).toHaveLength(2);
    expect(events.some((event) => event.startsWith("unresolved:"))).toBe(false);
  });
});
