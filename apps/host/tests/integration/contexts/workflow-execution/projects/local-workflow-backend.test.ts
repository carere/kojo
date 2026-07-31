import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  ProjectIdentity,
  type ProjectSnapshot,
  RequestKey,
  WorkflowRunId,
  type WorkflowRunStartSnapshot,
} from "@kojo/control";
import {
  defineCommand,
  defineCustomAgentProvider,
  defineCustomSandboxProvider,
  defineSandbox,
} from "@kojo/workflow";
import { Context, Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect";
import {
  emptyProjectIndexState,
  ProjectIndexRepository,
} from "../../../../../src/contexts/workflow-authoring/projects/repositories/project-index-repository";
import { ProjectLayout } from "../../../../../src/contexts/workflow-authoring/projects/services/project-layout";
import { HostDiagnosticLogger } from "../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  completeProjectRepositoryMigration,
  DrizzleProjectRepositoryLive,
  DrizzleWorkflowRunRepositoryLive,
  migrateProjectRepository,
} from "../../../../../src/contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { ProjectRepository } from "../../../../../src/contexts/workflow-execution/projects/repositories/project-repository";
import { makeLocalWorkflowBackendLayer } from "../../../../../src/contexts/workflow-execution/projects/services/local-workflow-backend";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import {
  type LocalWorkflowDefinition,
  WorkflowBackend,
  type WorkflowBackendReference,
  type WorkflowBackendState,
} from "../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";
import { WorkflowRunRepository } from "../../../../../src/contexts/workflow-execution/runs/repositories/workflow-run-repository";
import {
  reconcileStoppingWorkflowRuns,
  stopWorkflowRun,
} from "../../../../../src/contexts/workflow-execution/runs/use-cases/manage-workflow-runs";
import {
  type ProviderRuntime,
  ProviderRuntimeUnavailable,
} from "../../../../../src/contexts/workflow-execution/sandboxes/services/provider-runtime";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Local Workflow backend ownership", () => {
  it.live(
    "delivers an occurrence-specific durable wake-up after the Project Runtime restarts",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          initializedWorkflowProject("kojo-schedule-wakeup-"),
        );
        const wakeup = {
          scheduleKey: "nightly-report",
          scheduledAtMs: Date.now() + 500,
          scheduleRevision: "schedule-v1",
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const backendContext = yield* Layer.build(makeLocalWorkflowBackendLayer("first-host"));
            const backend = Context.get(backendContext, WorkflowBackend);
            const runtimeContext = yield* Layer.build(
              ProjectRuntimeLive.pipe(
                Layer.provide([
                  DrizzleProjectRepositoryLive,
                  Layer.succeed(WorkflowBackend, backend),
                ]),
              ),
            );
            const runtime = Context.get(runtimeContext, ProjectRuntime);
            expect(
              yield* runtime.coordinateRegistration(fixture.project, Effect.succeed({}), (ready) =>
                Effect.succeed(ready),
              ),
            ).toBe(true);
            yield* backend.armScheduleWakeup?.(fixture.project, wakeup) ??
              Effect.die("missing wake-up adapter");
          }),
        );

        yield* Effect.sleep("750 millis");

        const due = yield* Effect.scoped(
          Effect.gen(function* () {
            const backendContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("restarted-host"),
            );
            const backend = Context.get(backendContext, WorkflowBackend);
            const runtimeContext = yield* Layer.build(
              ProjectRuntimeLive.pipe(
                Layer.provide([
                  DrizzleProjectRepositoryLive,
                  Layer.succeed(WorkflowBackend, backend),
                ]),
              ),
            );
            const runtime = Context.get(runtimeContext, ProjectRuntime);
            expect(
              yield* runtime.coordinateRegistration(fixture.project, Effect.succeed({}), (ready) =>
                Effect.succeed(ready),
              ),
            ).toBe(true);
            return yield* (
              backend.takeDueScheduleWakeups?.(fixture.project) ??
              Effect.die("missing wake-up adapter")
            ).pipe(
              Effect.repeat({
                until: (wakeups) => wakeups.length === 1,
                schedule: Schedule.spaced("25 millis"),
                times: 200,
              }),
            );
          }),
        );

        expect(due).toEqual([wakeup]);
      }),
    15_000,
  );

  it.live("retries bounded ownership contention and acquires after release", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-backend-ownership-retry-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const projectPath = join(directory, "project");
      yield* Effect.promise(() =>
        mkdir(join(projectPath, ".kojo"), { recursive: true, mode: 0o700 }),
      );
      const project: ProjectSnapshot = {
        identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
        path: projectPath,
      };
      const firstContext = yield* Layer.build(makeLocalWorkflowBackendLayer("first-host"));
      const secondContext = yield* Layer.build(makeLocalWorkflowBackendLayer("second-host"));
      const first = Context.get(firstContext, WorkflowBackend);
      const second = Context.get(secondContext, WorkflowBackend);
      expect(yield* first.acquire(project)).toBe(true);

      const waiting = yield* Effect.forkChild(second.acquire(project), {
        startImmediately: true,
      });
      yield* Effect.sleep("40 millis");
      yield* first.release(project);
      expect(yield* Fiber.join(waiting)).toBe(true);
    }),
  );

  it.live(
    "interrupts and cleans up active Activity, Agent, Command, and Sandbox work through the controlled Provider Runtime boundary",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          initializedWorkflowProject("kojo-provider-interrupt-"),
        );
        const calls: Array<string> = [];
        const releases = new Map<string, Deferred.Deferred<void>>();
        const active = (kind: string) =>
          Effect.gen(function* () {
            const release = yield* Deferred.make<void>();
            releases.set(kind, release);
            calls.push(`started:${kind}`);
            yield* Deferred.await(release);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                calls.push(`cleaned:${kind}`);
              }),
            ),
          );
        const provider = defineCustomSandboxProvider({
          kind: "custom",
          providerKey: "controlled-provider",
          revision: "1",
          runCommand: () => Effect.succeed({ durationMs: 0, exitCode: 0, stderr: "", stdout: "" }),
        });
        const sandbox = defineSandbox({
          sandboxKey: "controlled-sandbox",
          revision: "1",
          provider,
        });
        const command = defineCommand({
          commandKey: "controlled-command",
          revision: "1",
          arguments: ["controlled-command"],
        });
        const agent = defineCustomAgentProvider({
          kind: "custom",
          providerKey: "controlled-agent",
          revision: "1",
          run: () => Effect.succeed({ commits: [], text: "unreachable" }),
        });
        const runId = randomUUID();
        const logicalSandbox = {
          _tag: "workflow-sandbox" as const,
          identity: "controlled-sandbox-identity",
          operationKey: "controlled-sandbox",
          providerKind: "custom" as const,
          providerKey: provider.providerKey,
          providerRevision: provider.revision,
          sandboxKey: sandbox.sandboxKey,
          revision: sandbox.revision,
        };
        const providerRuntime: ProviderRuntime["Service"] = {
          ...ProviderRuntimeUnavailable,
          acquire: () =>
            active("sandbox").pipe(
              Effect.as({
                providerKind: "custom" as const,
                sessionRecreated: true,
                worktreeBranch: "controlled-provider",
              }),
            ),
          runCommand: () =>
            active("command").pipe(
              Effect.as({
                durationMs: 0,
                exitCode: 0,
                sessionRecreated: false,
                stderr: "",
                stdout: "",
                worktreeBranch: "controlled-provider",
              }),
            ),
          runAgent: () =>
            active("agent").pipe(
              Effect.as({
                commits: [],
                durationMs: 0,
                sessionContinued: false,
                sessionRecreated: false,
                text: "",
                worktreeBranch: "controlled-provider",
              }),
            ),
          interruptRun: (_project: ProjectSnapshot, interruptedRunId: string) =>
            Effect.gen(function* () {
              calls.push(`interrupted:${interruptedRunId}`);
              for (const release of releases.values()) yield* Deferred.succeed(release, undefined);
            }),
        };
        const definition: LocalWorkflowDefinition<typeof Schema.Null, typeof Schema.String> = {
          workflowKey: "provider-interrupt-proof",
          revision: "1",
          inputSchema: Schema.Null,
          successSchema: Schema.String,
          execute: (_input, operations) =>
            operations.waitForResume({
              operationKey: "wait-for-provider-interrupt",
              valueSchema: Schema.String,
            }),
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(active("activity"));
            yield* Effect.forkScoped(
              providerRuntime.acquire({
                definition: sandbox,
                project: fixture.project,
                runId,
                sandbox: logicalSandbox,
              }),
            );
            yield* Effect.forkScoped(
              providerRuntime.runCommand({
                command,
                definition: sandbox,
                project: fixture.project,
                runId,
                sandbox: logicalSandbox,
              }),
            );
            yield* Effect.forkScoped(
              providerRuntime.runAgent({
                agent,
                definition: sandbox,
                idempotencyKey: "controlled-agent",
                project: fixture.project,
                prompt: "wait for interruption",
                runId,
                sandbox: logicalSandbox,
              }),
            );
            for (let attempt = 0; attempt < 100 && releases.size !== 4; attempt += 1) {
              yield* Effect.sleep("10 millis");
            }
            expect([...releases.keys()].sort()).toEqual([
              "activity",
              "agent",
              "command",
              "sandbox",
            ]);

            const backendContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer(
                "provider-interrupt-host",
                [definition],
                providerRuntime,
              ),
            );
            const backend = Context.get(backendContext, WorkflowBackend);
            expect(yield* backend.acquire(fixture.project)).toBe(true);
            expect(yield* backend.initialize(fixture.project)).toBe(true);
            if (backend.interrupt === undefined) {
              return yield* Effect.die("Local Workflow Backend does not support interruption.");
            }
            const reference = yield* backend.submit(fixture.project, {
              workflowKey: definition.workflowKey,
              workflowRevision: definition.revision ?? "default",
              runId,
              input: null,
            });
            expect(yield* awaitState(backend, fixture.project, reference, "Waiting")).toEqual({
              _tag: "Waiting",
              suspension: { kind: "manual", operationKey: "wait-for-provider-interrupt" },
            });
            expect(yield* backend.interrupt(fixture.project, reference)).toEqual({
              _tag: "interrupted",
            });
            for (
              let attempt = 0;
              attempt < 100 && calls.filter((call) => call.startsWith("cleaned:")).length !== 4;
              attempt += 1
            ) {
              yield* Effect.sleep("10 millis");
            }
            expect(calls).toContain(`interrupted:${runId}`);
            for (const kind of ["activity", "agent", "command", "sandbox"]) {
              expect(calls).toContain(`cleaned:${kind}`);
              expect(calls.indexOf(`interrupted:${runId}`)).toBeLessThan(
                calls.indexOf(`cleaned:${kind}`),
              );
            }
          }),
        );
      }),
    15_000,
  );

  it.live(
    "keeps a Run stopping and records execution-trace evidence when provider cleanup fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(() =>
            initializedWorkflowProject("kojo-stop-cleanup-failure-"),
          );
          const repositoryContext = yield* Layer.build(DrizzleWorkflowRunRepositoryLive);
          const repository = Context.get(repositoryContext, WorkflowRunRepository);
          const startRequestKey = Schema.decodeUnknownSync(RequestKey)(`start-${randomUUID()}`);
          const stopRequestKey = Schema.decodeUnknownSync(RequestKey)(`stop-${randomUUID()}`);
          const runId = randomUUID();
          let interruptions = 0;
          let stateWhenProviderInterrupts: string | undefined;
          const definition: LocalWorkflowDefinition<typeof Schema.Null, typeof Schema.String> = {
            workflowKey: "cleanup-failure",
            revision: "1",
            inputSchema: Schema.Null,
            successSchema: Schema.String,
            execute: (_input, operations) =>
              operations.waitForResume({
                operationKey: "wait-for-provider-cleanup",
                valueSchema: Schema.String,
              }),
          };
          const providerRuntime: ProviderRuntime["Service"] = {
            ...ProviderRuntimeUnavailable,
            interruptRun: (project) =>
              Effect.gen(function* () {
                stateWhenProviderInterrupts = (yield* repository.show(project, runId))?.run.state;
                interruptions += 1;
                if (interruptions === 1) {
                  return yield* Effect.die("controlled provider cleanup failed");
                }
              }),
          };
          const backendContext = yield* Layer.build(
            makeLocalWorkflowBackendLayer(
              "provider-cleanup-failure-host",
              [definition],
              providerRuntime,
            ),
          );
          const backend = Context.get(backendContext, WorkflowBackend);
          expect(yield* backend.acquire(fixture.project)).toBe(true);
          expect(yield* backend.initialize(fixture.project)).toBe(true);
          yield* repository.acceptManualStart({
            project: fixture.project,
            requestKey: startRequestKey,
            requestHash: new Uint8Array(32),
            runId,
            workflowKey: "cleanup-failure",
            workflowRevision: "1",
            encodedInput: null,
            inputSensitivityPaths: [],
            startSnapshot: {
              workflow: {
                workflowKey: "cleanup-failure",
                workflowRevision: "1",
                sourceIdentity: "cleanup-failure-test",
                inputSchemaFingerprint: "cleanup-failure-test",
              },
              trigger: { kind: "manual", requestKey: startRequestKey },
              environment: {
                projectIdentity: fixture.project.identity,
                definitionSnapshotId: "cleanup-failure-test",
                runtimeKind: "local-effect-workflow",
              },
              input: null,
              inputSensitivityPaths: [],
            },
            acceptedAtMs: Date.now(),
          });
          const reference = yield* backend.submit(fixture.project, {
            workflowKey: definition.workflowKey,
            workflowRevision: definition.revision ?? "default",
            runId,
            input: null,
          });
          expect(yield* awaitState(backend, fixture.project, reference, "Waiting")).toEqual({
            _tag: "Waiting",
            suspension: { kind: "manual", operationKey: "wait-for-provider-cleanup" },
          });
          yield* repository.confirmSubmission(fixture.project, runId, Date.now());
          const stopped = yield* stopWorkflowRun({
            identity: fixture.project.identity,
            requestKey: stopRequestKey,
            runId,
          }).pipe(
            Effect.provideService(ProjectIndexRepository, {
              read: Effect.succeed({ ...emptyProjectIndexState(), projects: [fixture.project] }),
              update: () => Effect.die("Project Index writes are not used by Run stop."),
            }),
            Effect.provideService(ProjectLayout, {
              inspectIndexedPath: () =>
                Effect.succeed({ status: "valid", identity: fixture.project.identity }),
              validate: () =>
                Effect.succeed({
                  ok: true,
                  project: fixture.project,
                  definitions: undefined as never,
                }),
            }),
            Effect.provideService(ProjectRuntime, {} as unknown as ProjectRuntime["Service"]),
            Effect.provideService(HostDiagnosticLogger, {
              cleanup: Effect.void,
              emit: () => Effect.void,
            }),
            Effect.provideService(WorkflowBackend, backend),
            Effect.provideService(WorkflowRunRepository, repository),
          );

          expect(stopped).toMatchObject({
            ok: false,
            error: { code: "run-stop-needs-attention" },
          });
          expect(stateWhenProviderInterrupts).toBe("stopping");
          expect((yield* repository.show(fixture.project, runId))?.run).toMatchObject({
            state: "stopping",
            outcome: null,
          });
          const database = new Database(join(fixture.project.path, ".kojo", "kojo.sqlite"), {
            readonly: true,
          });
          try {
            expect(
              database.query("SELECT kind FROM kojo_execution_events WHERE run_id = ?").all(runId),
            ).not.toEqual(
              expect.arrayContaining([
                expect.objectContaining({ kind: "run.stop-needs-attention" }),
              ]),
            );
          } finally {
            database.close();
          }

          const redelivered = yield* stopWorkflowRun({
            identity: fixture.project.identity,
            requestKey: stopRequestKey,
            runId,
          }).pipe(
            Effect.provideService(ProjectIndexRepository, {
              read: Effect.succeed({ ...emptyProjectIndexState(), projects: [fixture.project] }),
              update: () => Effect.die("Project Index writes are not used by Run stop."),
            }),
            Effect.provideService(ProjectLayout, {
              inspectIndexedPath: () =>
                Effect.succeed({ status: "valid", identity: fixture.project.identity }),
              validate: () =>
                Effect.succeed({
                  ok: true,
                  project: fixture.project,
                  definitions: undefined as never,
                }),
            }),
            Effect.provideService(ProjectRuntime, {} as unknown as ProjectRuntime["Service"]),
            Effect.provideService(HostDiagnosticLogger, {
              cleanup: Effect.void,
              emit: () => Effect.void,
            }),
            Effect.provideService(WorkflowBackend, backend),
            Effect.provideService(WorkflowRunRepository, repository),
          );
          expect(redelivered).toMatchObject({
            ok: true,
            alreadyApplied: true,
            run: { state: "stopped", outcome: { kind: "stopped" } },
          });
          expect(interruptions).toBe(2);
        }),
      ),
  );

  it.live(
    "records stop intent before work, keeps the stopped outcome through late engine results, and finalizes parents after children",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(() =>
            initializedWorkflowProject("kojo-stop-lifecycle-"),
          );
          const repositoryContext = yield* Layer.build(DrizzleWorkflowRunRepositoryLive);
          const repository = Context.get(repositoryContext, WorkflowRunRepository);
          const parentRunId = Schema.decodeUnknownSync(WorkflowRunId)(randomUUID());
          const childRunId = Schema.decodeUnknownSync(WorkflowRunId)(randomUUID());
          const parentRequestKey = Schema.decodeUnknownSync(RequestKey)(`start-${parentRunId}`);
          const timestamp = Date.now();
          yield* repository.acceptManualStart({
            project: fixture.project,
            requestKey: parentRequestKey,
            requestHash: new Uint8Array(32),
            runId: parentRunId,
            workflowKey: "parent",
            workflowRevision: "1",
            encodedInput: null,
            inputSensitivityPaths: [],
            startSnapshot: runStartSnapshot(fixture.project, "parent", parentRequestKey),
            acceptedAtMs: timestamp,
          });
          yield* repository.confirmSubmission(fixture.project, parentRunId, timestamp);
          const childRequestKey = Schema.decodeUnknownSync(RequestKey)(`child-${childRunId}`);
          yield* repository.acceptChildStart({
            project: fixture.project,
            requestKey: childRequestKey,
            requestHash: new Uint8Array(32),
            runId: childRunId,
            workflowKey: "child",
            workflowRevision: "1",
            encodedInput: null,
            inputSensitivityPaths: [],
            parentRunId,
            invocationKey: "child",
            startSnapshot: {
              ...runStartSnapshot(fixture.project, "child", childRequestKey),
              trigger: { kind: "child", parentRunId, invocationKey: "child" },
            },
            acceptedAtMs: timestamp,
          });
          yield* repository.confirmSubmission(fixture.project, childRunId, timestamp);

          const accepted = yield* repository.acceptStop(fixture.project, {
            requestHash: new Uint8Array(32),
            requestKey: Schema.decodeUnknownSync(RequestKey)(`stop-${parentRunId}`),
            requestedAtMs: timestamp,
            runId: parentRunId,
          });
          expect(accepted).toMatchObject({
            _tag: "accepted",
            alreadyApplied: false,
            run: { run: { state: "stopping" } },
            runs: expect.arrayContaining([
              expect.objectContaining({ runId: parentRunId, state: "stopping" }),
              expect.objectContaining({ runId: childRunId, state: "stopping" }),
            ]),
          });
          expect(
            yield* repository.prepareActivity(
              fixture.project,
              parentRunId,
              {
                activityName: "must-not-start",
                definitionFingerprint: "must-not-start",
                durableOperationKey: "must-not-start",
              },
              timestamp,
            ),
          ).toEqual({ _tag: "conflict" });
          expect(yield* repository.pendingSubmissions(fixture.project, parentRunId)).toEqual([]);

          yield* repository.recordOutcome(
            fixture.project,
            parentRunId,
            { kind: "completed", sensitivityPaths: [], value: "late success" },
            timestamp,
          );
          yield* repository.recordOutcome(
            fixture.project,
            parentRunId,
            { kind: "failed", sensitivityPaths: [] },
            timestamp,
          );
          yield* repository.recordStopped(fixture.project, parentRunId, timestamp);
          expect((yield* repository.show(fixture.project, parentRunId))?.run).toMatchObject({
            state: "stopping",
            outcome: null,
          });

          const interruptedRunIds: Array<string> = [];
          yield* reconcileStoppingWorkflowRuns(
            {
              interrupt: (_project: ProjectSnapshot, reference: WorkflowBackendReference) =>
                Effect.sync(() => {
                  interruptedRunIds.push(reference.runId);
                  return { _tag: "interrupted" as const };
                }),
            } as unknown as WorkflowBackend["Service"],
            repository,
            fixture.project,
          );
          expect(interruptedRunIds).toEqual([childRunId, parentRunId]);
          expect((yield* repository.show(fixture.project, parentRunId))?.run).toMatchObject({
            state: "stopped",
            outcome: { kind: "stopped" },
          });
          expect(
            yield* repository.acceptStop(fixture.project, {
              requestHash: new Uint8Array(32),
              requestKey: Schema.decodeUnknownSync(RequestKey)(`stop-again-${parentRunId}`),
              requestedAtMs: timestamp,
              runId: parentRunId,
            }),
          ).toMatchObject({ _tag: "not-stoppable" });

          const database = new Database(join(fixture.project.path, ".kojo", "kojo.sqlite"), {
            readonly: true,
          });
          try {
            const events = database
              .query("SELECT kind FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence")
              .all(parentRunId) as ReadonlyArray<{ readonly kind: string }>;
            const kinds = events.map(({ kind }) => kind);
            expect(kinds).toEqual(
              expect.arrayContaining([
                "run.stop-requested",
                "run.late-engine-outcome",
                "run.stopped",
              ]),
            );
            expect(kinds.filter((kind) => kind === "run.late-engine-outcome")).toHaveLength(2);
          } finally {
            database.close();
          }
        }),
      ),
  );

  it.live("keeps exclusive ownership until failed migration restoration completes", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-backend-owned-restoration-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const projectPath = join(directory, "project");
      yield* Effect.promise(() =>
        mkdir(join(projectPath, ".kojo"), { recursive: true, mode: 0o700 }),
      );
      const project: ProjectSnapshot = {
        identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
        path: projectPath,
      };
      let restorationStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        restorationStarted = resolve;
      });
      let restorationComplete = false;

      const firstContext = yield* Layer.build(makeLocalWorkflowBackendLayer("first-host"));
      const secondContext = yield* Layer.build(makeLocalWorkflowBackendLayer("second-host"));
      const first = Context.get(firstContext, WorkflowBackend);
      const second = Context.get(secondContext, WorkflowBackend);
      const backend = Layer.succeed(WorkflowBackend, {
        ...first,
        initialize: () => Effect.succeed(true),
        postflight: () => Effect.succeed(false),
        readiness: () => Effect.succeed("uninitialized" as const),
      });
      const store = Layer.succeed(ProjectRepository, {
        migrate: () => Effect.succeed(true),
        postflight: () => Effect.succeed(true),
        completeMigration: (_project, succeeded) =>
          succeeded
            ? Effect.succeed(true)
            : Effect.gen(function* () {
                restorationStarted();
                yield* Effect.sleep("40 millis");
                restorationComplete = true;
                return false;
              }),
        readiness: () => Effect.succeed("limited" as const),
        inspectForgetBlockers: () =>
          Effect.succeed({
            assessment: "available" as const,
            enabledScheduleKeys: [],
            nonFinalRunIds: [],
          }),
      });
      const runtimeContext = yield* Layer.build(
        ProjectRuntimeLive.pipe(Layer.provide([store, backend])),
      );
      const runtime = Context.get(runtimeContext, ProjectRuntime);
      const activation = yield* Effect.forkChild(
        runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
          Effect.succeed(ready),
        ),
        { startImmediately: true },
      );
      yield* Effect.promise(() => started);
      const competing = yield* Effect.forkChild(second.acquire(project), {
        startImmediately: true,
      });
      const competingAcquired = yield* Fiber.join(competing);
      const completeWhenAcquired = restorationComplete;
      yield* second.release(project);

      expect({
        activation: yield* Fiber.join(activation),
        competingAcquired,
        completeWhenAcquired,
      }).toEqual({
        activation: false,
        competingAcquired: true,
        completeWhenAcquired: true,
      });
    }),
  );

  it.live("quiesces an initialized Workflow backend before restoring a failed migration", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-backend-initialized-restoration-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const projectPath = join(directory, "project");
      const dataPath = join(projectPath, ".kojo");
      yield* Effect.promise(() => mkdir(dataPath, { recursive: true, mode: 0o700 }));
      const project: ProjectSnapshot = {
        identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
        path: projectPath,
      };
      yield* Effect.promise(() =>
        writeFile(
          join(dataPath, "project.json"),
          `${JSON.stringify({ layoutVersion: 1, projectIdentity: project.identity })}\n`,
          { mode: 0o600 },
        ),
      );
      const databasePath = join(dataPath, "kojo.sqlite");
      yield* Effect.sync(() => {
        const database = new Database(databasePath, { create: true, strict: true });
        database.exec(`CREATE TABLE kojo_project_store_identity (
          singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
          project_identity TEXT NOT NULL UNIQUE,
          database_instance_id TEXT NOT NULL UNIQUE
        ) STRICT`);
        database
          .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
          .run(project.identity, randomUUID());
        database.exec("PRAGMA user_version = 0");
        database.close();
      });
      yield* Effect.promise(() => chmod(databasePath, 0o600));
      yield* Effect.sync(() => migrateProjectRepository(project));
      expect(completeProjectRepositoryMigration(project, true)).toBe(true);
      let quiescedBeforeRestoration = false;

      const backendContext = yield* Layer.build(makeLocalWorkflowBackendLayer("initialized-host"));
      const storeContext = yield* Layer.build(DrizzleProjectRepositoryLive);
      const backend = Context.get(backendContext, WorkflowBackend);
      const realStore = Context.get(storeContext, ProjectRepository);
      const failingStore = Layer.succeed(ProjectRepository, {
        ...realStore,
        postflight: (snapshot) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              const connection = new Database(databasePath);
              connection.exec(
                "INSERT INTO kojo_deletion_intents(deletion_id, request_key, target_kind, target_sha256, target_snapshot_json, phase, created_at_ms, updated_at_ms) VALUES ('deletion', 'request', 'run', zeroblob(32), '{}', 'quiescing', 1, 1)",
              );
              connection.close();
            });
            return yield* realStore.postflight(snapshot);
          }),
        completeMigration: (snapshot, succeeded) =>
          succeeded
            ? realStore.completeMigration(snapshot, true)
            : Effect.gen(function* () {
                quiescedBeforeRestoration =
                  (yield* backend.readiness(snapshot)) === "uninitialized";
                return yield* realStore.completeMigration(snapshot, false);
              }),
      });
      const runtimeContext = yield* Layer.build(
        ProjectRuntimeLive.pipe(
          Layer.provide([failingStore, Layer.succeed(WorkflowBackend, backend)]),
        ),
      );
      const runtime = Context.get(runtimeContext, ProjectRuntime);
      const activation = yield* runtime.coordinateRegistration(
        project,
        Effect.succeed({}),
        (ready) => Effect.succeed(ready),
      );

      expect(activation).toBe(false);
      expect(quiescedBeforeRestoration).toBe(true);
      const restored = new Database(databasePath, { readonly: true });
      expect(restored.query("SELECT * FROM kojo_deletion_intents").all()).toEqual([]);
      restored.close();
    }),
  );

  it.live(
    "executes Workflows through the engine owned by the active Project Runtime",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "kojo-project-runtime-workflow-")),
        );
        cleanups.push(() => rm(directory, { recursive: true }));
        const projectPath = join(directory, "project");
        const dataPath = join(projectPath, ".kojo");
        yield* Effect.promise(() => mkdir(dataPath, { recursive: true, mode: 0o700 }));
        const project: ProjectSnapshot = {
          identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
          path: projectPath,
        };
        yield* Effect.promise(() =>
          writeFile(
            join(dataPath, "project.json"),
            `${JSON.stringify({ layoutVersion: 1, projectIdentity: project.identity })}\n`,
            { mode: 0o600 },
          ),
        );
        const databasePath = join(dataPath, "kojo.sqlite");
        yield* Effect.sync(() => {
          const database = new Database(databasePath, { create: true, strict: true });
          database.exec(`CREATE TABLE kojo_project_store_identity (
            singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
            project_identity TEXT NOT NULL UNIQUE,
            database_instance_id TEXT NOT NULL UNIQUE
          ) STRICT`);
          database
            .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
            .run(project.identity, randomUUID());
          database.exec("PRAGMA user_version = 0");
          database.close();
        });
        yield* Effect.promise(() => chmod(databasePath, 0o600));
        yield* Effect.sync(() => migrateProjectRepository(project));
        expect(completeProjectRepositoryMigration(project, true)).toBe(true);

        const wakeAfterMillis = 1_000;
        let activityInvocations = 0;
        const definition = makeRecoveryDefinition(() => {
          activityInvocations += 1;
          return "recorded activity result";
        });

        const reference = yield* Effect.scoped(
          Effect.gen(function* () {
            const backendContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("execution-host", [definition]),
            );
            const backend = Context.get(backendContext, WorkflowBackend);
            const runtimeContext = yield* Layer.build(
              ProjectRuntimeLive.pipe(
                Layer.provide([
                  DrizzleProjectRepositoryLive,
                  Layer.succeed(WorkflowBackend, backend),
                ]),
              ),
            );
            const runtime = Context.get(runtimeContext, ProjectRuntime);
            expect(
              yield* runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
                Effect.succeed(ready),
              ),
            ).toBe(true);
            yield* Effect.sync(() => {
              const connection = new Database(databasePath, { readonly: true });
              try {
                expect(connection.query("PRAGMA journal_mode").get()).toEqual({
                  journal_mode: "wal",
                });
                expect(
                  connection
                    .query(
                      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kojo_%' AND name NOT LIKE 'sqlite_%'",
                    )
                    .all(),
                ).not.toEqual([]);
              } finally {
                connection.close();
              }
            });

            const accepted = yield* backend.submit(project, {
              workflowKey: definition.workflowKey,
              workflowRevision: definition.revision ?? "default",
              runId: "run:project-runtime-recovery-proof",
              input: { wakeAfterMillis },
            });
            expect(yield* awaitState(backend, project, accepted, "Waiting")).toEqual({
              _tag: "Waiting",
              suspension: { kind: "clock", operationKey: "durable-clock" },
            });
            expect(activityInvocations).toBe(1);

            const competitorContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("competing-host", [definition]),
            );
            const competitor = Context.get(competitorContext, WorkflowBackend);
            expect(yield* competitor.acquire(project)).toBe(false);
            return accepted;
          }),
        );

        yield* Effect.sleep(`${wakeAfterMillis + 250} millis`);

        const completed = yield* Effect.scoped(
          Effect.gen(function* () {
            const backendContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("execution-host", [definition]),
            );
            const backend = Context.get(backendContext, WorkflowBackend);
            const runtimeContext = yield* Layer.build(
              ProjectRuntimeLive.pipe(
                Layer.provide([
                  DrizzleProjectRepositoryLive,
                  Layer.succeed(WorkflowBackend, backend),
                ]),
              ),
            );
            const runtime = Context.get(runtimeContext, ProjectRuntime);
            expect(
              yield* runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
                Effect.succeed(ready),
              ),
            ).toBe(true);
            return yield* awaitState(backend, project, reference, "Completed");
          }),
        );

        expect(completed).toEqual({
          _tag: "Completed",
          result: { activityResult: "recorded activity result", wakeUpDelivered: true },
        });
        expect(activityInvocations).toBe(1);
      }),
    20_000,
  );
});

const RecoveryInput = Schema.Struct({
  wakeAfterMillis: Schema.Number,
});

const RecoveryResult = Schema.Struct({
  activityResult: Schema.String,
  wakeUpDelivered: Schema.Boolean,
});

const runStartSnapshot = (
  project: ProjectSnapshot,
  workflowKey: string,
  requestKey: typeof RequestKey.Type,
): WorkflowRunStartSnapshot => ({
  workflow: {
    workflowKey,
    workflowRevision: "1",
    sourceIdentity: "workflow-run-stop-test",
    inputSchemaFingerprint: "workflow-run-stop-test",
  },
  trigger: { kind: "manual", requestKey },
  environment: {
    projectIdentity: project.identity,
    definitionSnapshotId: "workflow-run-stop-test",
    runtimeKind: "local-effect-workflow",
  },
  input: null,
  inputSensitivityPaths: [],
});

const makeRecoveryDefinition = (
  invokeActivity: () => string,
): LocalWorkflowDefinition<typeof RecoveryInput, typeof RecoveryResult> => ({
  workflowKey: "recovery-proof",
  inputSchema: RecoveryInput,
  successSchema: RecoveryResult,
  execute: (input, operations) =>
    Effect.gen(function* () {
      const activityResult = yield* operations.activity({
        operationKey: "record-result",
        successSchema: Schema.String,
        execute: Effect.sync(invokeActivity),
      });
      yield* operations.sleep({
        operationKey: "wake-after-restart",
        duration: `${input.wakeAfterMillis} millis`,
      });
      return { activityResult, wakeUpDelivered: true };
    }),
});

const initializedWorkflowProject = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true }));
  const projectPath = join(directory, "project");
  const dataPath = join(projectPath, ".kojo");
  await mkdir(dataPath, { recursive: true, mode: 0o700 });
  const project: ProjectSnapshot = {
    identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
    path: projectPath,
  };
  await writeFile(
    join(dataPath, "project.json"),
    `${JSON.stringify({ layoutVersion: 1, projectIdentity: project.identity })}\n`,
    { mode: 0o600 },
  );
  const databasePath = join(dataPath, "kojo.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`CREATE TABLE kojo_project_store_identity (
    singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
    project_identity TEXT NOT NULL UNIQUE,
    database_instance_id TEXT NOT NULL UNIQUE
  ) STRICT`);
  database
    .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
    .run(project.identity, randomUUID());
  database.exec("PRAGMA user_version = 0");
  database.close();
  await chmod(databasePath, 0o600);
  migrateProjectRepository(project);
  expect(completeProjectRepositoryMigration(project, true)).toBe(true);
  return { project };
};

const awaitState = (
  backend: WorkflowBackend["Service"],
  project: ProjectSnapshot,
  reference: WorkflowBackendReference,
  tag: WorkflowBackendState["_tag"],
) =>
  backend.observe(project, reference).pipe(
    Effect.repeat({
      until: (state) => state._tag === tag,
      schedule: Schedule.spaced("25 millis"),
      times: 400,
    }),
  );
