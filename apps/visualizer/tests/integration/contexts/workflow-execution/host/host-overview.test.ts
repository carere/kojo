import { afterAll, describe, expect, it } from "@effect/vitest";
import { ProjectIdentity, WorkflowRunId } from "@kojo/control";
import { LocalTransportError } from "@kojo/control/local-client";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcGroup, RpcTest } from "effect/unstable/rpc";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";
import {
  HostOverview,
  HostOverviewError,
  ReadExecutionTrace,
} from "../../../../../src/contexts/shared/models/contracts";
import { disposeApi, handleApiRequest } from "../../../../../src/contexts/shared/server";
import {
  makeVisualizerApiClientLayer,
  VisualizerApiClient,
} from "../../../../../src/contexts/shared/services/client";
import {
  HostOverviewHandler,
  ReadExecutionTraceHandler,
} from "../../../../../src/contexts/workflow-execution/host/server/handlers";
import { HostControlClient } from "../../../../../src/contexts/workflow-execution/host/services/host-control-client";

afterAll(() => disposeApi());

describe("Host overview", () => {
  it.effect("proxies Host-owned Execution Trace evidence through the same-origin API", () =>
    Effect.gen(function* () {
      const identity = Schema.decodeUnknownSync(ProjectIdentity)(
        "00000000-0000-7000-8000-000000000001",
      );
      const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000002");
      const client = yield* RpcTest.makeClient(RpcGroup.make(ReadExecutionTrace));
      const result = yield* client.ReadExecutionTrace({
        identity,
        runId,
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 50,
      });

      expect(result).toMatchObject({
        ok: true,
        page: {
          events: [{ kind: "run.accepted", sequence: 1 }],
          highWaterSequence: 1,
          runState: "running",
          final: false,
        },
      });
    }).pipe(
      Effect.provide(ReadExecutionTraceHandler),
      Effect.provideService(HostControlClient, {
        getHostOverview: Effect.die("Overview is not used by this test"),
        readExecutionTrace: (input) =>
          Effect.succeed({
            ok: true as const,
            page: {
              events: [
                {
                  eventId: "event-one",
                  runId: input.runId,
                  sequence: 1,
                  envelopeVersion: 1,
                  kind: "run.accepted",
                  kindVersion: 1,
                  recordedAtMs: 1,
                  observedAtMs: null,
                  engineOperationId: null,
                  activityAttemptId: null,
                  boundaryId: null,
                  childRunId: null,
                  compatibility: "supported" as const,
                  payload: { safe: true },
                },
              ],
              nextCursor: null,
              highWaterSequence: 1,
              runState: "running" as const,
              final: false,
            },
          }),
        enableWorkflowSchedule: () => Effect.die("Schedule control is not used by this test"),
        disableWorkflowSchedule: () => Effect.die("Schedule control is not used by this test"),
      }),
    ),
  );

  it.effect("preserves safe transport failures as typed browser-operation errors", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RpcGroup.make(HostOverview));
      const error = yield* Effect.flip(client.HostOverview());

      expect(error).toEqual(
        new HostOverviewError({
          code: "host-unavailable",
          message: "Kojo Host is unavailable.",
          next: "Start the Kojo Host and try again.",
        }),
      );
    }).pipe(
      Effect.provide(HostOverviewHandler),
      Effect.provideService(HostControlClient, {
        getHostOverview: Effect.fail(
          new LocalTransportError({ message: "Kojo Host is unavailable." }),
        ),
        enableWorkflowSchedule: () => Effect.die("Schedule control is not used by this test"),
        disableWorkflowSchedule: () => Effect.die("Schedule control is not used by this test"),
      }),
    ),
  );

  it.effect("is exposed through an explicit same-origin operation", () => {
    const fetchThroughApi = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("origin", new URL(request.url).origin);
      request.headers.set("sec-fetch-site", "same-origin");
      return handleApiRequest(request);
    }) as typeof fetch;

    return Effect.acquireUseRelease(
      Effect.promise(async () => {
        const previousSocketPath = process.env.KOJO_HOST_SOCKET;
        const host = await startKojoHostProcess();
        process.env.KOJO_HOST_SOCKET = host.socketPath;
        return { host, previousSocketPath };
      }),
      () =>
        Effect.gen(function* () {
          const client = yield* VisualizerApiClient;
          const overview = yield* client.HostOverview();

          expect(overview).toEqual({
            host: {
              protocol: { major: 1, minor: 8 },
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
                "control:subscribe",
              ],
            },
            projects: [],
            readiness: [],
            projectDefinitions: [],
            workflowSchedules: [],
            workflowOccurrences: [],
            workflowRuns: [],
          });
        }),
      ({ host, previousSocketPath }) =>
        Effect.promise(async () => {
          if (previousSocketPath === undefined) delete process.env.KOJO_HOST_SOCKET;
          else process.env.KOJO_HOST_SOCKET = previousSocketPath;
          await host.stop();
        }),
    ).pipe(
      Effect.provide(makeVisualizerApiClientLayer("http://kojo.test/api/rpc")),
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughApi),
    );
  });
});
