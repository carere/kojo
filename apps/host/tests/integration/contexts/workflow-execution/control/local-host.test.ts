import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { type ControlSubscriptionDelivery, ProjectIdentity, RequestKey } from "@kojo/control";
import {
  connectUnixControlClient,
  connectUnixControlConnection,
  makeLocalClient,
} from "@kojo/control/local-client";
import { Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeFileProjectIndexRepositoryLayer } from "../../../../../src/contexts/workflow-authoring/projects/repositories/file-project-index-repository";
import { GitProjectLayoutLive } from "../../../../../src/contexts/workflow-authoring/projects/services/git-project-layout";
import { SubprocessProjectDefinitionLoaderLive } from "../../../../../src/contexts/workflow-authoring/projects/services/subprocess-project-definition-loader";
import { HostIdentity } from "../../../../../src/contexts/workflow-execution/control/models/host-identity";
import { ControlSubscriptionReader } from "../../../../../src/contexts/workflow-execution/control/services/control-subscription-reader";
import { makeHostDiagnosticLoggerLayer } from "../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  type KojoHostServer,
  makeKojoControlServerLayer,
  startKojoHost,
  UnsafeHostStoreError,
} from "../../../../../src/contexts/workflow-execution/control/services/local-host";
import {
  DrizzleProjectRepositoryLive,
  DrizzleWorkflowRunRepositoryLive,
  DrizzleWorkflowScheduleRepositoryLive,
} from "../../../../../src/contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { makeLocalWorkflowBackendLayer } from "../../../../../src/contexts/workflow-execution/projects/services/local-workflow-backend";
import { ProjectRuntimeLive } from "../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { ScheduleClockLive } from "../../../../../src/contexts/workflow-execution/schedules/services/schedule-clock";

const cleanups: Array<() => Promise<void>> = [];
const TEST_HOST_IDENTITY = Schema.decodeUnknownSync(HostIdentity)(
  "host:00000000-0000-4000-8000-000000000000",
);
const LegacyHostInformation = Schema.Struct({
  protocol: Schema.Struct({ major: Schema.Number, minor: Schema.Number }),
  hostVersion: Schema.String,
  capabilities: Schema.Array(Schema.Literal("projects:list")),
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("local Kojo Host control", () => {
  it.effect(
    "negotiates and returns the authoritative empty Project list over its Unix socket",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-")));
        const socketPath = join(directory, "host.sock");
        const diagnosticPath = join(directory, "diagnostics.jsonl");
        const server = yield* Effect.promise(() => startTestHost(socketPath, diagnosticPath));
        cleanups.push(() => close(server, directory));

        const legacyHandshake = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connectUnixControlClient(socketPath);
            return yield* client.Negotiate();
          }),
        );
        expect(Schema.decodeUnknownSync(LegacyHostInformation)(legacyHandshake)).toEqual({
          protocol: { major: 1, minor: 11 },
          hostVersion: "0.1.0",
          capabilities: ["projects:list"],
        });

        const overview = yield* makeLocalClient({
          connect: connectUnixControlClient(socketPath),
          maxAttempts: 1,
        }).getHostOverview;

        expect(overview).toEqual({
          host: {
            protocol: { major: 1, minor: 11 },
            hostVersion: "0.1.0",
            capabilities: [
              "projects:list",
              "projects:list-page",
              "projects:show",
              "projects:register",
              "projects:forget",
              "readiness:show",
              "readiness:refresh",
              "readiness:repair",
              "workflows:list",
              "workflows:show",
              "schedules:list",
              "schedules:show",
              "schedules:next",
              "schedules:enable",
              "schedules:disable",
              "occurrences:list",
              "occurrences:show",
              "runs:start",
              "runs:list",
              "runs:show",
              "runs:reveal",
              "runs:resume",
              "runs:deferred-complete",
              "runs:stop",
              "traces:read",
              "traces:export",
              "artifacts:read",
              "control:subscribe",
              "control:acknowledge",
            ],
          },
          projects: [],
          readiness: [],
          projectDefinitions: [],
          workflowSchedules: [],
          workflowOccurrences: [],
          workflowRuns: [],
        });
        const directoryMode = yield* Effect.promise(() => stat(directory));
        const diagnosticMode = yield* Effect.promise(() => stat(server.diagnosticPath));
        const lockMode = yield* Effect.promise(() => stat(server.lockPath));
        const socketMode = yield* Effect.promise(() => stat(socketPath));
        expect(directoryMode.mode & 0o777).toBe(0o700);
        expect(diagnosticMode.mode & 0o777).toBe(0o600);
        expect(lockMode.mode & 0o777).toBe(0o600);
        expect(socketMode.mode & 0o777).toBe(0o600);

        const diagnosticContents = yield* Effect.promise(() =>
          readFile(server.diagnosticPath, "utf8"),
        );
        const events = diagnosticContents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toHaveLength(4);
        expect(events.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
          { operation: "Negotiate", outcome: "success" },
          { operation: "Negotiate", outcome: "success" },
          { operation: "NegotiateCapabilities", outcome: "success" },
          { operation: "ListProjects", outcome: "success" },
        ]);
        expect(events[0]).toMatchObject({
          eventVersion: 1,
          eventKind: "host-request.completed",
          hostIdentity: "host:00000000-0000-4000-8000-000000000000",
          hostVersion: "0.1.0",
          protocolMajor: 1,
          protocolMinor: 11,
        });
      }),
  );

  it.effect("refuses a second Host without orphaning the active Host socket", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-owner-")));
      const socketPath = join(directory, "host.sock");
      const first = yield* Effect.promise(() =>
        startTestHost(socketPath, join(directory, "first-diagnostics.jsonl")),
      );
      cleanups.push(() => close(first, directory));

      const secondExit = yield* Effect.exit(
        Effect.promise(() =>
          startTestHost(socketPath, join(directory, "second-diagnostics.jsonl")),
        ),
      );
      if (Exit.isSuccess(secondExit)) cleanups.push(secondExit.value.stop);

      expect(Exit.isFailure(secondExit)).toBe(true);

      const overview = yield* makeLocalClient({
        connect: connectUnixControlClient(socketPath),
        maxAttempts: 1,
      }).getHostOverview;
      expect(overview.host.hostVersion).toBe("0.1.0");
    }),
  );

  it.effect("atomically conflicts concurrent failed forgets that reuse one Request Key", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-forget-")));
      const socketPath = join(directory, "host.sock");
      const server = yield* Effect.promise(() =>
        startTestHost(socketPath, join(directory, "diagnostics.jsonl")),
      );
      cleanups.push(() => close(server, directory));
      const firstIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
        "00000000-0000-7000-8000-000000000001",
      );
      const secondIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
        "00000000-0000-7000-8000-000000000002",
      );
      const requestKey = Schema.decodeUnknownSync(RequestKey)("shared-forget-request");
      const client = makeLocalClient({
        connect: connectUnixControlClient(socketPath),
        maxAttempts: 1,
      });

      const results = yield* Effect.all(
        [
          client.forgetProject(
            firstIdentity,
            { kind: "identity", identity: firstIdentity },
            requestKey,
          ),
          client.forgetProject(
            secondIdentity,
            { kind: "identity", identity: secondIdentity },
            requestKey,
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.map((result) => (result.ok ? "success" : result.error.code)).sort()).toEqual([
        "project-not-found",
        "request-key-conflict",
      ]);
    }),
  );

  it.effect("rejects a Host store that resolves through another user's directory", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-host-unsafe-store-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const unsafeDirectory = join(directory, "unsafe");
      yield* Effect.promise(() => symlink(tmpdir(), unsafeDirectory));

      const error = yield* Effect.promise(async () => {
        try {
          await startTestHost(
            join(unsafeDirectory, "host.sock"),
            join(unsafeDirectory, "diagnostics.jsonl"),
          );
          return undefined;
        } catch (cause) {
          return cause;
        }
      });

      expect(error).toBeInstanceOf(UnsafeHostStoreError);
    }),
  );

  it.effect(
    "bounds one unacknowledged Unix-RPC subscriber without delaying controls or another subscriber",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "kojo-host-subscription-window-")),
        );
        const socketPath = join(directory, "host.sock");
        const server = yield* Effect.promise(() =>
          startTestHost(
            socketPath,
            join(directory, "diagnostics.jsonl"),
            Layer.succeed(ControlSubscriptionReader, {
              readResourceFingerprint: () => Effect.succeed("unchanged"),
              readTrace: (input) => {
                const sequence = (input.afterSequence ?? 0) + 1;
                // A real asynchronous source leaves the test runner's Effect
                // clock alone while the Host owns the live polling loop.
                return Effect.promise(
                  () =>
                    new Promise((resolve) => {
                      setTimeout(
                        () =>
                          resolve({
                            ok: true as const,
                            page: {
                              events: [
                                {
                                  activityAttemptId: null,
                                  boundaryId: null,
                                  childRunId: null,
                                  compatibility: "supported" as const,
                                  engineOperationId: null,
                                  envelopeVersion: 1,
                                  eventId: `event-${sequence}`,
                                  kind: "run.engine-confirmed" as const,
                                  kindVersion: 1,
                                  observedAtMs: null,
                                  payload: {},
                                  recordedAtMs: sequence,
                                  runId: input.runId,
                                  sequence,
                                },
                              ],
                              final: false,
                              firstSequence: sequence,
                              hasMore: false,
                              highWaterSequence: sequence,
                              lastSequence: sequence,
                              nextCursor: null,
                              runState: "running" as const,
                            },
                          }),
                        10,
                      );
                    }),
                );
              },
            }),
          ),
        );
        cleanups.push(() => close(server, directory));
        const identity = Schema.decodeUnknownSync(ProjectIdentity)(
          "00000000-0000-7000-8000-000000000037",
        );
        const runId = "00000000-0000-7000-8000-000000000038" as never;
        const input = {
          projects: [identity],
          topics: ["traces"] as const,
          traces: [{ identity, runId, afterSequence: 0 }],
        };
        const client = makeLocalClient({
          connect: connectUnixControlConnection(socketPath),
          maxAttempts: 1,
        });

        // This real Unix-RPC client reads every update but deliberately sends
        // no acknowledgement. The test therefore observes receiver lag at the
        // application delivery boundary rather than a socket queue heuristic.
        const slowFiber = yield* Effect.forkScoped(
          client.subscribeControl(input).pipe(Stream.runCollect),
        );
        const acknowledgedUpdates: Array<{
          readonly deliverySequence: number;
          readonly kind: string;
          readonly subscriptionId: ControlSubscriptionDelivery["subscriptionId"];
        }> = [];
        const acknowledgedFiber = yield* Effect.forkScoped(
          client.subscribeControl(input).pipe(
            Stream.take(20),
            Stream.runForEach((update) =>
              client
                .acknowledgeControlSubscription(update)
                .pipe(Effect.tap(() => Effect.sync(() => acknowledgedUpdates.push(update)))),
            ),
          ),
        );

        // This test runs under Effect's virtual test clock; native time is
        // intentional here because the Unix socket adapter is external to it.
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 150)));
        // A separate control request must stay responsive while the first
        // transport consumes updates without ever acknowledging them.
        expect(yield* client.listProjects).toEqual({ projects: [] });

        const slowResult = yield* Fiber.join(slowFiber).pipe(Effect.timeoutOption("3 seconds"));
        expect(Option.isSome(slowResult)).toBe(true);
        const slowUpdates = Array.from(Option.getOrThrow(slowResult));
        const acknowledgedResult = yield* Fiber.join(acknowledgedFiber).pipe(
          Effect.timeoutOption("3 seconds"),
        );
        expect(Option.isSome(acknowledgedResult)).toBe(true);
        const resync = slowUpdates.find((update) => update.kind === "resync-required");
        expect(resync).toMatchObject({ kind: "resync-required", highWaterSequence: 17 });
        expect(slowUpdates.filter((update) => update.kind === "trace-event")).toHaveLength(16);
        expect(acknowledgedUpdates).toHaveLength(20);
        expect(acknowledgedUpdates.every((update) => update.kind === "trace-event")).toBe(true);
        expect(new Set(acknowledgedUpdates.map((update) => update.subscriptionId)).size).toBe(1);
        expect(acknowledgedUpdates[0]?.subscriptionId).not.toBe(resync?.subscriptionId);
        // `take(20)` aborts the source before its Host window overflows. Its
        // session must be gone just as promptly as the naturally completed
        // slow stream, proving abort-driven Unix client detachment.
        const lastAcknowledgedUpdate = acknowledgedUpdates.at(-1);
        expect(
          yield* client.acknowledgeControlSubscription({
            deliverySequence: lastAcknowledgedUpdate?.deliverySequence ?? 1,
            subscriptionId: lastAcknowledgedUpdate?.subscriptionId ?? ("missing" as never),
          }),
        ).toEqual({ acknowledged: false });

        // The terminal stream finalizer removes the Host registry entry. A
        // delayed acknowledgement is a safe typed no-op, not an error.
        expect(
          yield* client.acknowledgeControlSubscription({
            deliverySequence: resync?.deliverySequence ?? 1,
            subscriptionId: resync?.subscriptionId ?? ("missing" as never),
          }),
        ).toEqual({ acknowledged: false });

        // A new subscription has a distinct ephemeral sequence but resumes
        // through the durable per-Run sequence, with no duplicate event.
        const lastTraceSequence = slowUpdates
          .filter((update) => update.kind === "trace-event")
          .at(-1)?.sequence;
        const resumed = yield* client
          .subscribeControl({
            ...input,
            traces: [{ identity, runId, afterSequence: lastTraceSequence ?? 0 }],
          })
          .pipe(Stream.runHead);
        expect(Option.getOrThrow(resumed)).toMatchObject({
          kind: "trace-event",
          sequence: (lastTraceSequence ?? 0) + 1,
        });
        const resumedUpdate = Option.getOrThrow(resumed);
        expect(yield* client.acknowledgeControlSubscription(resumedUpdate)).toEqual({
          acknowledged: false,
        });
      }),
    8_000,
  );
});

const startTestHost = (
  socketPath: string,
  diagnosticPath: string,
  subscriptionReader?: Layer.Layer<ControlSubscriptionReader>,
) => {
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const workflowBackend = makeLocalWorkflowBackendLayer(TEST_HOST_IDENTITY);
  const projectRuntime = ProjectRuntimeLive.pipe(
    Layer.provide([DrizzleProjectRepositoryLive, workflowBackend]),
  );
  const serverLayer = makeKojoControlServerLayer(
    protocol,
    makeHostDiagnosticLoggerLayer(diagnosticPath),
    TEST_HOST_IDENTITY,
    subscriptionReader,
  ).pipe(
    Layer.provide([
      makeFileProjectIndexRepositoryLayer(join(dirname(socketPath), "projects.json")),
      GitProjectLayoutLive.pipe(Layer.provide(SubprocessProjectDefinitionLoaderLive)),
      DrizzleProjectRepositoryLive,
      DrizzleWorkflowRunRepositoryLive,
      DrizzleWorkflowScheduleRepositoryLive,
      ScheduleClockLive,
      workflowBackend,
      projectRuntime,
    ]),
  ) as Layer.Layer<never, unknown>;
  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};

const close = async (server: KojoHostServer, directory: string) => {
  await server.stop();
  await rm(directory, { recursive: true });
};
