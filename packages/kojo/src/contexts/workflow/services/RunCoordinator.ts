import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type {
  CancelRunResult,
  RunDocument,
  RunSnapshot,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type {
  StartTriggerWorkflowResult,
  StopWorkflowResult,
  WorkflowMode,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Data, Effect } from "effect";
import type { DaemonGateRepository } from "../../gate/ports/DaemonGateRepository.ts";
import type { ProjectRecovery } from "../../project/models/ProjectRecovery.ts";
import type { DaemonProjectRepository } from "../../project/ports/DaemonProjectRepository.ts";
import type { ProjectRecoveryRepository } from "../../project/ports/ProjectRecoveryRepository.ts";
import type { ResourceLeaseRepository } from "../../project/ports/ResourceLeaseRepository.ts";
import { materializeRevision } from "../../project/services/materializeRevision.ts";
import { ProjectRecoveryCoordinator } from "../../project/services/ProjectRecoveryCoordinator.ts";
import {
  ProjectRunnerError,
  ProjectRunnerSupervisor,
} from "../../project/services/ProjectRunnerSupervisor.ts";
import type { ArtifactRepository } from "../../trace/ports/ArtifactRepository.ts";
import type { TraceRepository } from "../../trace/ports/TraceRepository.ts";
import type { TriggerRepository } from "../../trigger/ports/TriggerRepository.ts";
import { TriggerSupervisor } from "../../trigger/services/TriggerSupervisor.ts";
import type { ReservedRun, RunAuthority } from "../models/DaemonRun.ts";
import { RetainedContentFault } from "../models/RetainedContentFault.ts";
import type { RunnerMutationFault } from "../models/RunnerMutationFault.ts";
import { DEFAULT_RUNNER_IDLE_MILLIS } from "../models/SchedulingDefaults.ts";
import type { ExternalActionRepository } from "../ports/ExternalActionRepository.ts";
import type { RevisionRepository } from "../ports/RevisionRepository.ts";
import type { RunRepository } from "../ports/RunRepository.ts";
import { canonicalJson } from "./canonicalJson.ts";
import {
  type ActiveExecutionControl,
  ProjectRunnerConnectionLost,
  ProjectRunnerTransport,
  type RunnerExecution,
  type RunnerInspection,
  type RunnerRegistration,
} from "./ProjectRunnerTransport.ts";
import { runDocumentOf } from "./RunDocumentProjection.ts";

class RunApiFault extends Data.TaggedError("RunApiFault")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const runApiFault = (cause: unknown): RunApiFault =>
  new RunApiFault({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const runnerError = (cause: unknown): ProjectRunnerError =>
  cause instanceof ProjectRunnerError
    ? cause
    : new ProjectRunnerError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** Daemon-owned no-Trigger admission, dispatch, and observation service. */
export class RunCoordinator {
  readonly #dataIdentity: string;
  readonly #instanceId: string;
  readonly #dataRoot: string;
  readonly #now: () => number;
  readonly #projects: DaemonProjectRepository;
  readonly #projectRecovery: ProjectRecoveryRepository["Service"];
  readonly #runs: RunRepository["Service"];
  readonly #actions: ExternalActionRepository["Service"];
  readonly #revisions: RevisionRepository["Service"];
  readonly #gates: DaemonGateRepository["Service"];
  readonly #resources: ResourceLeaseRepository["Service"];
  readonly #trace: TraceRepository;
  readonly #artifacts: ArtifactRepository;
  readonly #runnerSettings: () => {
    readonly idleMs: number;
    readonly handshakeMs: number;
    readonly heartbeatMs: number;
    readonly unhealthyMs: number;
    readonly cleanupMs: number;
    readonly recoveryCheckMs: number;
  };
  readonly #resourceMutationFault?:
    | ((mutation: RunnerMutationFault) => "before-commit" | "after-commit" | undefined)
    | undefined;
  readonly #runnerSupervisor = new ProjectRunnerSupervisor();
  readonly #recoveryCoordinator: ProjectRecoveryCoordinator;
  readonly #triggerSupervisor: TriggerSupervisor;
  readonly #activeExecutions = new Map<string, ActiveExecutionControl>();
  readonly #runnerTransport: ProjectRunnerTransport;
  readonly #activeDispatches = new Set<Promise<void>>();
  readonly #activeDispatchRunIds = new Set<string>();
  readonly #projectDispatchHolds = new Set<string>();
  readonly #projectDispatches = new Map<string, number>();
  readonly #shutdownController = new AbortController();
  #activePump: Promise<void> | undefined;
  #stopping = false;
  #daemonDispatchHeld: boolean;

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly dataRoot: string;
    readonly now: () => number;
    readonly projects: DaemonProjectRepository;
    readonly projectRecovery: ProjectRecoveryRepository["Service"];
    readonly runs: RunRepository["Service"];
    readonly actions: ExternalActionRepository["Service"];
    readonly revisions: RevisionRepository["Service"];
    readonly triggers: TriggerRepository["Service"];
    readonly gates: DaemonGateRepository["Service"];
    readonly resources: ResourceLeaseRepository["Service"];
    readonly trace: TraceRepository;
    readonly artifacts: ArtifactRepository;
    readonly runnerIdleMillis?: number;
    readonly runnerCleanupMillis?: number;
    readonly runnerSettings?: () => {
      readonly idleMs: number;
      readonly handshakeMs: number;
      readonly heartbeatMs: number;
      readonly unhealthyMs: number;
      readonly cleanupMs: number;
      readonly recoveryCheckMs: number;
    };
    readonly resourceMutationFault?:
      | ((mutation: RunnerMutationFault) => "before-commit" | "after-commit" | undefined)
      | undefined;
    readonly resourceRecoveryBoundary?: (() => Effect.Effect<void>) | undefined;
    readonly daemonDispatchHeld?: boolean;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#instanceId = options.instanceId;
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#projects = options.projects;
    this.#projectRecovery = options.projectRecovery;
    this.#runs = options.runs;
    this.#actions = options.actions;
    this.#revisions = options.revisions;
    this.#gates = options.gates;
    this.#resources = options.resources;
    this.#trace = options.trace;
    this.#artifacts = options.artifacts;
    this.#runnerSettings =
      options.runnerSettings ??
      (() => ({
        idleMs: options.runnerIdleMillis ?? DEFAULT_RUNNER_IDLE_MILLIS,
        handshakeMs: 10_000,
        heartbeatMs: 5_000,
        unhealthyMs: 30_000,
        cleanupMs: options.runnerCleanupMillis ?? 30_000,
        recoveryCheckMs: 60_000,
      }));
    this.#resourceMutationFault = options.resourceMutationFault;
    this.#daemonDispatchHeld = options.daemonDispatchHeld ?? false;
    this.#runnerTransport = new ProjectRunnerTransport({
      dataRoot: this.#dataRoot,
      now: this.#now,
      projectRecovery: this.#projectRecovery,
      runs: this.#runs,
      actions: this.#actions,
      revisions: this.#revisions,
      resources: this.#resources,
      trace: this.#trace,
      artifacts: this.#artifacts,
      runnerSupervisor: this.#runnerSupervisor,
      activeExecutions: this.#activeExecutions,
      runnerSettings: this.#runnerSettings,
      resourceMutationFault: this.#resourceMutationFault,
    });
    this.#recoveryCoordinator = new ProjectRecoveryCoordinator({
      now: this.#now,
      recovery: this.#projectRecovery,
      resources: this.#resources,
      actions: this.#actions,
      runs: this.#runs,
      runnerSupervisor: this.#runnerSupervisor,
      resourceRecoveryBoundary: options.resourceRecoveryBoundary,
      shutdownSignal: this.#shutdownController.signal,
      isStopping: () => this.#stopping,
      onRecoveryReady: async (projectId) => {
        void this.#pump();
        await this.#triggerSupervisor.restoreProject(projectId);
      },
    });
    this.#triggerSupervisor = new TriggerSupervisor({
      dataRoot: this.#dataRoot,
      instanceId: this.#instanceId,
      now: this.#now,
      projects: this.#projects,
      projectRecovery: this.#projectRecovery,
      resources: this.#resources,
      revisions: this.#revisions,
      triggers: options.triggers,
      runnerSupervisor: this.#runnerSupervisor,
      runnerSettings: this.#runnerSettings,
      resourceRecoveryBoundary: options.resourceRecoveryBoundary,
      reconcileTerminatedResources: (projectId, runnerInstanceId, confirmedAt) =>
        this.#recoveryCoordinator.reconcileTerminatedResources(
          projectId,
          runnerInstanceId,
          confirmedAt,
        ),
      waitForRecovery: (nextAttemptAt) => this.#recoveryCoordinator.wait(nextAttemptAt),
      daemonDispatchHeld: () => this.#daemonDispatchHeld,
      isStopping: () => this.#stopping,
      pumpRuns: () => {
        void this.#pump();
      },
      shutdownSignal: this.#shutdownController.signal,
    });
  }

  readonly start = (options: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly payload: JsonValue;
  }): Effect.Effect<StartRunResult, RunApiFault> =>
    Effect.tryPromise({ try: () => this.#start(options), catch: runApiFault });

  readonly startWorkflow = (options: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly payload?: JsonValue;
    readonly mutation: MutationEnvelope;
    readonly reviewedMode: WorkflowMode;
    readonly reviewedRevisionId: string;
  }): Effect.Effect<StartRunResult | StartTriggerWorkflowResult, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity)
          throw new Error("the Daemon data identity changed");
        const workflow = await Effect.runPromise(
          this.#projects.workflow(options.projectId, options.workflowName),
        );
        if (workflow === undefined) throw new Error("the selected Project Workflow was not found");
        const trigger = workflow.trigger.state !== "not-declared";
        if (trigger) {
          if (options.payload !== undefined)
            throw new Error("a Trigger Workflow Start does not accept payload flags");
          const receipt = await Effect.runPromise(
            this.#projects.startActivity({
              dataIdentity: options.dataIdentity,
              requestId: options.requestId,
              projectId: options.projectId,
              workflowName: options.workflowName,
              changedAt: new Date(this.#now()).toISOString(),
              ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
              reviewedMode: options.reviewedMode,
              reviewedRevisionId: options.reviewedRevisionId,
            }),
          );
          if (receipt.pollerId === undefined)
            throw new Error("the active Trigger Workflow has no poller identity");
          await this.#triggerSupervisor.ensure(
            receipt.projectId,
            receipt.workflowName,
            receipt.pollerId,
          );
          return {
            kind: "trigger",
            projectId: receipt.projectId,
            workflowName: receipt.workflowName,
            activity: "active",
            triggerState: "polling",
            pollerStarted: receipt.pollerStarted,
          };
        }
        if (options.payload === undefined)
          throw new Error("a no-Trigger Workflow Start requires one JSON payload");
        return this.#start({ ...options, payload: options.payload });
      },
      catch: runApiFault,
    });

  readonly stopWorkflow = (options: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly force?: boolean;
    readonly mutation?: MutationEnvelope;
  }): Effect.Effect<StopWorkflowResult, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity)
          throw new Error("the Daemon data identity changed");
        const changedAt = new Date(this.#now()).toISOString();
        if (options.force === true) {
          const forced = await Effect.runPromise(
            this.#runs.forceStopWorkflow({
              dataIdentity: options.dataIdentity,
              requestId: options.requestId,
              canonicalRequest: canonicalJson({
                operation: "forceStopWorkflow",
                projectId: options.projectId,
                workflowName: options.workflowName,
              }),
              projectId: options.projectId,
              workflowName: options.workflowName,
              acceptedAt: changedAt,
              ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
            }),
          );
          await this.#triggerSupervisor.stopPoller(options.projectId, options.workflowName);
          await this.#stopCancelledProject(options.projectId, forced.targetRunIds, changedAt, {
            ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
            result: {
              kind: "stop",
              projectId: options.projectId,
              workflowName: options.workflowName,
              activity: "inactive",
              admittedRunsContinue: false,
              forced: true,
              targetSetId: forced.targetSetId,
              targetedRunIds: forced.targetRunIds,
            },
          });
          return {
            kind: "stop",
            projectId: options.projectId,
            workflowName: options.workflowName,
            activity: "inactive",
            admittedRunsContinue: false,
            forced: true,
            targetSetId: forced.targetSetId,
            targetedRunIds: forced.targetRunIds,
          };
        }
        const receipt = await Effect.runPromise(
          this.#projects.stopActivity({
            ...options,
            changedAt,
            ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
          }),
        );
        await this.#triggerSupervisor.stopPoller(options.projectId, options.workflowName);
        return {
          kind: "stop",
          projectId: receipt.projectId,
          workflowName: receipt.workflowName,
          activity: "inactive",
          admittedRunsContinue: true,
        };
      },
      catch: runApiFault,
    });

  readonly cancelRun = (options: {
    readonly runId: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly mutation?: MutationEnvelope;
  }): Effect.Effect<CancelRunResult, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity)
          throw new Error("the Daemon data identity changed");
        const requestedAt = new Date(this.#now()).toISOString();
        const cancellation = await Effect.runPromise(
          this.#runs.requestCancellation(
            options.runId,
            options.requestId,
            requestedAt,
            options.mutation,
          ),
        );
        if (cancellation.requiresExecutionStop) {
          await this.#stopCancelledProject(
            cancellation.run.projectId,
            [cancellation.run.runId],
            requestedAt,
            {
              ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
              result: {
                kind: "cancel",
                runId: cancellation.run.runId,
                cancellation: "confirmed",
                executionStopped: true,
                state: "cancelled",
              },
            },
          );
        }
        await Effect.runPromise(this.#gates.reconcileTerminalInabilities).catch(() => undefined);
        const run = await Effect.runPromise(this.#runs.read(options.runId));
        if (run === undefined) throw new Error("the selected Run was not found after cancellation");
        return {
          kind: "cancel",
          runId: run.runId,
          cancellation: run.cancellation?.state ?? "requested",
          executionStopped: run.cancellation?.state === "confirmed",
          state: run.state,
        };
      },
      catch: runApiFault,
    });

  /** Stop new dispatch and Trigger polling without cancelling admitted Runs. */
  readonly holdProjectDispatch = (
    projectId: string,
    detail: string,
  ): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        this.#projectDispatchHolds.add(projectId);
        await this.#triggerSupervisor.stopProject(projectId, detail);
      },
      catch: runApiFault,
    });

  /** Persisted lifecycle state supplies the initial hold after Daemon replacement. */
  readonly beginDaemonDrain: Effect.Effect<
    {
      readonly held: true;
      readonly executingRunIds: ReadonlyArray<string>;
      readonly observedAt: string;
    },
    RunApiFault
  > = Effect.tryPromise({
    try: async () => {
      this.#daemonDispatchHeld = true;
      await this.#triggerSupervisor.stopAll();
      return this.#daemonDrainProgress();
    },
    catch: runApiFault,
  });

  readonly daemonDrainProgress: Effect.Effect<
    {
      readonly held: true;
      readonly executingRunIds: ReadonlyArray<string>;
      readonly observedAt: string;
    },
    RunApiFault
  > = Effect.tryPromise({ try: () => this.#daemonDrainProgress(), catch: runApiFault });

  /** Stop current Runner processes for an explicit forced drain, but keep this Daemon reusable. */
  readonly forceDaemonDrain = (
    cleanupMillis: number,
  ): Effect.Effect<ReturnType<RunCoordinator["lifecycleOwner"]>, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (!Number.isSafeInteger(cleanupMillis) || cleanupMillis < 1) {
          throw new Error("forced Daemon drain requires a positive finite interval");
        }
        const owner = this.lifecycleOwner();
        this.#stopping = true;
        const stoppedOwners = await Effect.runPromise(
          this.#runnerSupervisor.shutdownOwnedStrict(cleanupMillis),
        );
        const missingOwners = owner.runnerInstanceIds.filter(
          (runnerInstanceId) => !stoppedOwners.includes(runnerInstanceId),
        );
        if (missingOwners.length > 0) {
          throw new Error(`Project Runner stop is unconfirmed for ${missingOwners.join(", ")}`);
        }
        await Effect.runPromise(
          this.#runs.recoverInterruptedExecutions(new Date(this.#now()).toISOString()),
        );
        this.#stopping = false;
        return owner;
      },
      catch: runApiFault,
    });

  readonly releaseDaemonDispatch: Effect.Effect<void, RunApiFault> = Effect.tryPromise({
    try: async () => {
      this.#daemonDispatchHeld = false;
      for (const project of await Effect.runPromise(this.#projects.projects)) {
        await this.#triggerSupervisor.restoreProject(project.projectId);
      }
      void this.#pump();
    },
    catch: runApiFault,
  });

  async #daemonDrainProgress(): Promise<{
    readonly held: true;
    readonly executingRunIds: ReadonlyArray<string>;
    readonly observedAt: string;
  }> {
    const runs = await Effect.runPromise(this.#runs.list);
    return {
      held: true,
      executingRunIds: [
        ...new Set([
          ...runs.filter((run) => run.state === "executing").map((run) => run.runId),
          ...this.#activeDispatchRunIds,
        ]),
      ].toSorted(),
      observedAt: new Date(this.#now()).toISOString(),
    };
  }

  readonly lifecycleOwner = (): {
    readonly daemonInstanceId: string;
    readonly runnerInstanceIds: ReadonlyArray<string>;
    readonly recordedAt: string;
  } => ({
    daemonInstanceId: this.#instanceId,
    runnerInstanceIds: this.#runnerSupervisor.owners().toSorted(),
    recordedAt: new Date(this.#now()).toISOString(),
  });

  /** Stop only processes owned by this Daemon. Forced Runs return to recovery, not cancellation. */
  readonly stopForDaemonLifecycle = (
    cleanupMillis: number,
    forced: boolean,
  ): Effect.Effect<ReturnType<RunCoordinator["lifecycleOwner"]>, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (!Number.isSafeInteger(cleanupMillis) || cleanupMillis < 1) {
          throw new Error("Daemon cleanup requires a positive finite interval");
        }
        const progress = await this.#daemonDrainProgress();
        if (!forced && progress.executingRunIds.length > 0) {
          throw new Error("planned Daemon cleanup cannot interrupt an executing Run");
        }
        const owner = this.lifecycleOwner();
        this.#stopping = true;
        const stoppedOwners = await Effect.runPromise(
          this.#runnerSupervisor.shutdownOwnedStrict(cleanupMillis),
        );
        const missingOwners = owner.runnerInstanceIds.filter(
          (runnerInstanceId) => !stoppedOwners.includes(runnerInstanceId),
        );
        if (missingOwners.length > 0) {
          throw new Error(`Project Runner stop is unconfirmed for ${missingOwners.join(", ")}`);
        }
        if (forced) {
          await Effect.runPromise(
            this.#runs.recoverInterruptedExecutions(new Date(this.#now()).toISOString()),
          );
        }
        return owner;
      },
      catch: runApiFault,
    });

  /** Hold one Project before its active location changes, then confirm its Runner is stopped. */
  readonly drainProject = (projectId: string): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        await Effect.runPromise(
          this.holdProjectDispatch(projectId, "Project location change draining"),
        );
        while (
          (this.#projectDispatches.get(projectId) ?? 0) > 0 ||
          [...this.#activeExecutions.values()].some((control) => control.projectId === projectId)
        ) {
          await Bun.sleep(10);
        }
        await Effect.runPromise(this.#runnerSupervisor.stop(projectId));
        const recovery = await Effect.runPromise(this.#projectRecovery.read(projectId));
        if (
          recovery !== undefined &&
          (recovery.state !== "healthy" || recovery.safety !== "safe")
        ) {
          throw new Error("Project recovery is not safe enough to release its location");
        }
        const leases = await Effect.runPromise(this.#resources.byProject(projectId));
        const unresolved = leases.filter((lease) => lease.state !== "released");
        if (unresolved.length > 0) {
          throw new Error(
            `Project location release waits for ${unresolved.length} Resource lease(s) to be confirmed released`,
          );
        }
      },
      catch: runApiFault,
    });

  readonly releaseProjectDispatch = (projectId: string): void => {
    this.#projectDispatchHolds.delete(projectId);
    void this.#pump();
  };

  async #stopCancelledProject(
    projectId: string,
    targetRunIds: ReadonlyArray<string>,
    requestedAt: string,
    operation?: { readonly mutation?: MutationEnvelope; readonly result: JsonValue },
  ): Promise<void> {
    const deadline = Date.now() + this.#runnerSettings().cleanupMs;
    let controls: ReadonlyArray<ActiveExecutionControl> = [];
    while (Date.now() <= deadline) {
      controls = [
        ...new Map(
          targetRunIds.flatMap((runId) => {
            const control = this.#activeExecutions.get(runId);
            return control === undefined || control.projectId !== projectId
              ? []
              : [[control.authority.runnerInstanceId, control] as const];
          }),
        ).values(),
      ];
      if (controls.length > 0) break;
      const targets = await Promise.all(
        targetRunIds.map((runId) => Effect.runPromise(this.#runs.read(runId))),
      );
      if (targets.every((run) => run?.state !== "executing")) return;
      await Bun.sleep(5);
    }
    if (controls.length === 0) return;
    try {
      const remainingMillis = Math.max(1, deadline - Date.now());
      await Promise.all(controls.map((control) => control.cancelAndStop(remainingMillis)));
      const confirmedAt = new Date(this.#now()).toISOString();
      const safe = await Promise.all(
        controls.map((control) =>
          Effect.runPromise(
            this.#resources.confirmRunnerTermination({
              projectId,
              priorRunnerInstanceId: control.authority.runnerInstanceId,
              terminationConfirmedAt: confirmedAt,
            }),
          ).then(() =>
            this.#recoveryCoordinator.reconcileTerminatedResources(
              projectId,
              control.authority.runnerInstanceId,
              confirmedAt,
            ),
          ),
        ),
      );
      if (safe.some((value) => !value)) {
        throw new Error(
          "Project Runner stopped, but Resource cleanup remains preserved or unresolved",
        );
      }
    } catch (cause) {
      const detail = `Project Runner termination is not confirmed: ${cause instanceof Error ? cause.message : String(cause)}`;
      await Effect.runPromise(this.#runs.recordCleanupFault(targetRunIds, detail));
      throw cause;
    }
    const stoppedAt = new Date(Math.max(this.#now(), Date.parse(requestedAt))).toISOString();
    await Effect.runPromise(
      this.#runs.confirmProjectRunnerStopped(
        projectId,
        targetRunIds,
        stoppedAt,
        {
          state: "confirmed",
        },
        ...(operation?.mutation === undefined
          ? []
          : ([{ mutation: operation.mutation, result: operation.result }] as const)),
      ),
    );
    void this.#pump();
  }

  readonly restore = (): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        const recoveries = await this.#recoveryCoordinator.restore();
        for (const poller of await Effect.runPromise(this.#projects.triggerPollers)) {
          const recovery = recoveries.find((candidate) => candidate.projectId === poller.projectId);
          if (recovery !== undefined && recovery.state !== "healthy") continue;
          await this.#triggerSupervisor.ensure(
            poller.projectId,
            poller.workflowName,
            poller.pollerId,
          );
        }
        void this.#pump();
      },
      catch: runApiFault,
    });

  readonly shutdown = (): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        this.#stopping = true;
        this.#shutdownController.abort();
        this.#recoveryCoordinator.shutdown();
        await this.#triggerSupervisor.stopAll();
        const pumpResults = await Promise.allSettled(
          this.#activePump === undefined ? [] : [this.#activePump],
        );
        const [runnerResult, ...dispatchResults] = await Promise.allSettled([
          Effect.runPromise(this.#runnerSupervisor.shutdown()),
          ...this.#activeDispatches,
        ]);
        const failed = [...pumpResults, runnerResult, ...dispatchResults].find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed !== undefined) throw failed.reason;
      },
      catch: runApiFault,
    });

  async #start(options: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly payload: JsonValue;
    readonly mutation?: MutationEnvelope;
    readonly reviewedMode?: WorkflowMode;
    readonly reviewedRevisionId?: string;
  }): Promise<StartRunResult> {
    if (options.dataIdentity !== this.#dataIdentity)
      throw new Error("the Daemon data identity changed");
    const revision = await Effect.runPromise(
      this.#projects.executionRevision(options.projectId, options.workflowName),
    );
    const executionRoot = join(this.#dataRoot, "runner-materialized");
    mkdirSync(executionRoot, { recursive: true, mode: 0o700 });
    const materialized = materializeRevision({
      retainedRoot: revision.publishedPath,
      executionRoot,
      revisionId: revision.revisionId,
      packageGraphId: revision.packageGraphId,
    });
    const runnerInstanceId = crypto.randomUUID();
    const registration: RunnerRegistration = {
      registrationVersion: 1,
      selectedProtocol: 1,
      daemonInstanceId: this.#instanceId,
      runnerInstanceId,
      projectId: revision.projectId,
      boundProjectId: revision.projectId,
      revisionId: revision.revisionId,
      packageGraphId: revision.packageGraphId,
      boundPackageGraphId: revision.packageGraphId,
      executionRoot: materialized.root,
      workflowName: revision.workflowName,
      entrySource: revision.entrySource,
      payload: options.payload,
      connectionSecret: crypto.getRandomValues(new Uint8Array(32)).toHex(),
    };
    try {
      const inspected = await this.#runnerTransport.run<RunnerInspection>(
        revision.location,
        materialized.runner,
        "inspect",
        registration,
      );
      const admittedAt = new Date(this.#now()).toISOString();
      const admission = await Effect.runPromise(
        this.#runs.admit({
          dataIdentity: options.dataIdentity,
          requestId: options.requestId,
          canonicalRequest: canonicalJson({
            ...(options.mutation ?? {
              operation: "startRun",
              projectId: options.projectId,
              workflowName: options.workflowName,
              payload: options.payload,
            }),
          }),
          projectId: options.projectId,
          workflowName: options.workflowName,
          idempotencyKey: inspected.idempotencyKey,
          payload: options.payload,
          revisionId: revision.revisionId,
          packageGraphId: revision.packageGraphId,
          admittedAt,
          ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
          ...(options.reviewedMode === undefined ? {} : { reviewedMode: options.reviewedMode }),
          ...(options.reviewedRevisionId === undefined
            ? {}
            : { reviewedRevisionId: options.reviewedRevisionId }),
        }),
      );
      await Effect.runPromise(
        this.#projects.startActivity({
          dataIdentity: options.dataIdentity,
          requestId: `${options.requestId}:activity`,
          projectId: options.projectId,
          workflowName: options.workflowName,
          changedAt: admittedAt,
        }),
      );
      void this.#pump();
      materialized.dispose();
      return {
        kind: "run",
        runId: admission.run.runId,
        duplicate: admission.duplicate,
        revisionId: admission.run.revisionId,
        state: admission.run.state,
      };
    } catch (cause) {
      materialized.dispose();
      throw cause;
    }
  }

  #pump(): Promise<void> {
    if (this.#activePump !== undefined) return this.#activePump;
    if (this.#stopping || this.#daemonDispatchHeld) return Promise.resolve();
    const active = this.#pumpRuns();
    this.#activePump = active;
    return active;
  }

  async #pumpRuns(): Promise<void> {
    try {
      while (true) {
        if (this.#stopping || this.#daemonDispatchHeld) break;
        const reservationId = crypto.randomUUID();
        const now = this.#now();
        const blockedProjectIds = new Set(
          (await Effect.runPromise(this.#projectRecovery.recoveries))
            .filter(
              (recovery) =>
                recovery.state === "held" ||
                recovery.safety !== "safe" ||
                (recovery.nextAttemptAt !== undefined && Date.parse(recovery.nextAttemptAt) > now),
            )
            .map((recovery) => recovery.projectId),
        );
        for (const projectId of this.#projectDispatchHolds) blockedProjectIds.add(projectId);
        for (const project of await Effect.runPromise(this.#projects.projects)) {
          if (
            project.projectState !== "available" ||
            !project.locationActive ||
            !project.locationConfirmed ||
            project.locationChange.state === "draining"
          ) {
            blockedProjectIds.add(project.projectId);
          }
        }
        if (this.#stopping || this.#daemonDispatchHeld) break;
        const reserved = await Effect.runPromise(
          this.#runs.reserveNext(reservationId, new Date(now).toISOString(), blockedProjectIds),
        );
        if (reserved === undefined) break;
        this.#activeDispatchRunIds.add(reserved.run.runId);
        this.#projectDispatches.set(
          reserved.run.projectId,
          (this.#projectDispatches.get(reserved.run.projectId) ?? 0) + 1,
        );
        let dispatch: Promise<void>;
        dispatch = this.#dispatch(reserved).finally(() => {
          this.#activeDispatches.delete(dispatch);
          this.#activeDispatchRunIds.delete(reserved.run.runId);
          const remaining = (this.#projectDispatches.get(reserved.run.projectId) ?? 1) - 1;
          if (remaining === 0) this.#projectDispatches.delete(reserved.run.projectId);
          else this.#projectDispatches.set(reserved.run.projectId, remaining);
          void this.#pump();
        });
        this.#activeDispatches.add(dispatch);
      }
    } finally {
      this.#activePump = undefined;
    }
  }

  async #dispatch(reserved: ReservedRun): Promise<void> {
    const { run } = reserved;
    const attemptSettings = this.#runnerSettings();
    let authority: RunAuthority | undefined;
    try {
      const current = await Effect.runPromise(
        this.#projects.workflow(run.projectId, run.workflowName),
      );
      const { revision, materialized } = await Effect.runPromise(
        this.#runnerSupervisor.prepare({
          projectId: run.projectId,
          packageGraphId: run.packageGraphId,
          stopCurrentPolling: Effect.tryPromise({
            try: () =>
              this.#triggerSupervisor.stopProject(
                run.projectId,
                current?.currentRevisionId !== run.revisionId
                  ? `Historical polling delay: pinned revision ${run.revisionId} is executing`
                  : `Trigger polling waits for execution turn ${run.runId}`,
              ),
            catch: runnerError,
          }),
          load: Effect.tryPromise({
            try: async () => {
              const revision = await Effect.runPromise(
                this.#projects.retainedExecutionRevision(
                  run.projectId,
                  run.workflowName,
                  run.revisionId,
                  run.packageGraphId,
                ),
              ).catch((cause) => {
                throw new RetainedContentFault({
                  code: "RETAINED_CONTENT_MISSING",
                  message: `the pinned Workflow Revision ${run.revisionId} is not registered`,
                  remedy:
                    "Restore the exact retained revision metadata and bytes. Do not refresh this Run.",
                  cause,
                });
              });
              const executionRoot = join(this.#dataRoot, "runner-materialized");
              mkdirSync(executionRoot, { recursive: true, mode: 0o700 });
              return {
                revision,
                materialized: materializeRevision({
                  retainedRoot: revision.publishedPath,
                  executionRoot,
                  revisionId: revision.revisionId,
                  packageGraphId: revision.packageGraphId,
                }),
              };
            },
            catch: (cause) => (cause instanceof RetainedContentFault ? cause : runnerError(cause)),
          }),
        }),
      );
      authority = await Effect.runPromise(
        this.#runs.claimReserved(
          reserved.reservationId,
          crypto.randomUUID(),
          new Date(this.#now()).toISOString(),
        ),
      );
      const registration: RunnerRegistration = {
        registrationVersion: 1,
        selectedProtocol: 1,
        daemonInstanceId: this.#instanceId,
        runnerInstanceId: authority.runnerInstanceId,
        projectId: run.projectId,
        boundProjectId: run.projectId,
        revisionId: run.revisionId,
        packageGraphId: run.packageGraphId,
        boundPackageGraphId: run.packageGraphId,
        executionRoot: materialized.root,
        workflowName: run.workflowName,
        entrySource: revision.entrySource,
        payload: run.payload,
        connectionSecret: crypto.getRandomValues(new Uint8Array(32)).toHex(),
      };
      await this.#execute(revision.location, materialized.runner, registration, authority).finally(
        materialized.dispose,
      );
    } catch (cause) {
      if (cause instanceof RetainedContentFault) {
        const heldAt = new Date(this.#now()).toISOString();
        const fault = {
          code: cause.code,
          detail: cause.message,
          remedy: cause.remedy,
          retry:
            cause.code === "RETAINED_CONTENT_MISSING" || cause.code === "RETAINED_CONTENT_CORRUPT"
              ? ("after-repair" as const)
              : ("after-compatible-release" as const),
          scope: {
            projectId: run.projectId,
            workflowName: run.workflowName,
            revisionId: run.revisionId,
            packageGraphId: run.packageGraphId,
          },
        };
        await Effect.runPromise(
          authority === undefined
            ? this.#runs.holdReserved(reserved.reservationId, fault, heldAt)
            : this.#runs.hold(authority, fault, heldAt),
        ).catch(() => undefined);
      } else if (cause instanceof ProjectRunnerConnectionLost && authority !== undefined) {
        await this.#recoveryCoordinator.recoverRunnerLoss({
          run,
          authority,
          cause,
          recoveryCheckMs: attemptSettings.recoveryCheckMs,
        });
      } else if (authority !== undefined) {
        const current = await Effect.runPromise(this.#runs.read(authority.runId)).catch(
          () => undefined,
        );
        if (current?.cancellation === undefined) {
          await Effect.runPromise(
            this.#runs.completeRun(authority, "failed", new Date(this.#now()).toISOString()),
          ).catch(() => undefined);
        }
        await Effect.runPromise(this.#gates.reconcileTerminalInabilities).catch(() => undefined);
      } else {
        await Effect.runPromise(this.#runs.releaseReservation(reserved.reservationId)).catch(
          () => undefined,
        );
      }
    } finally {
      await Effect.runPromise(
        this.#projects.settleManualActivity(run.projectId, run.workflowName),
      ).catch(() => undefined);
      if (!this.#stopping) await this.#triggerSupervisor.restoreProject(run.projectId);
    }
  }

  readonly snapshot = (projectId?: string): Effect.Effect<RunSnapshot, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        const runs = await Effect.runPromise(this.#runs.list);
        const selected =
          projectId === undefined ? runs : runs.filter((run) => run.projectId === projectId);
        return {
          observationVersion: 1,
          instanceId: this.#instanceId,
          dataIdentity: this.#dataIdentity,
          snapshotVersion: selected.reduce(
            (version, run) => Math.max(version, run.admissionSequence),
            0,
          ),
          observedAt: new Date(this.#now()).toISOString(),
          refreshAfterMillis: 1_000,
          runs: await Promise.all(
            selected.map(async (run) =>
              runDocumentOf(
                run,
                await Effect.runPromise(this.#runs.phases(run.runId)),
                await Effect.runPromise(this.#trace.projection(run.runId)),
                this.#artifacts.list(run.runId),
                await Effect.runPromise(this.#actions.current(run.runId)),
              ),
            ),
          ),
        };
      },
      catch: runApiFault,
    });

  readonly run = (runId: string): Effect.Effect<RunDocument | undefined, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        const run = await Effect.runPromise(this.#runs.read(runId));
        return run === undefined
          ? undefined
          : runDocumentOf(
              run,
              await Effect.runPromise(this.#runs.phases(runId)),
              await Effect.runPromise(this.#trace.projection(runId)),
              this.#artifacts.list(runId),
              await Effect.runPromise(this.#actions.current(runId)),
            );
      },
      catch: runApiFault,
    });

  readonly continueRun = (runId: string): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        const run = await Effect.runPromise(this.#runs.read(runId));
        if (run?.state === "queued") void this.#pump();
      },
      catch: runApiFault,
    });

  readonly retryUncertainAction = (options: {
    readonly dataIdentity: string;
    readonly requestId: string;
    readonly runId: string;
    readonly actionId: string;
    readonly reason: string;
    readonly possibleDuplicationAcknowledged: true;
    readonly mutation?: MutationEnvelope;
  }): Effect.Effect<
    {
      readonly kind: "retry-uncertain";
      readonly runId: string;
      readonly actionId: string;
      readonly uncertaintyRevision: number;
      readonly state: "retry-authorized";
    },
    RunApiFault
  > =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity)
          throw new Error("the Daemon data identity changed");
        const action = await Effect.runPromise(
          this.#actions.authorizeRetry({
            ...options,
            canonicalRequest: canonicalJson({
              operation: "retryUncertainAction",
              runId: options.runId,
              actionId: options.actionId,
              reason: options.reason,
              possibleDuplicationAcknowledged: options.possibleDuplicationAcknowledged,
            }),
            authorizedAt: new Date(this.#now()).toISOString(),
            ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
          }),
        );
        void this.#pump();
        return {
          kind: "retry-uncertain",
          runId: action.runId,
          actionId: action.actionId,
          uncertaintyRevision: action.uncertaintyRevision,
          state: "retry-authorized",
        };
      },
      catch: runApiFault,
    });

  readonly projectRecovery = (
    projectId: string,
  ): Effect.Effect<ProjectRecovery | undefined, RunApiFault> =>
    this.#recoveryCoordinator.read(projectId).pipe(Effect.mapError(runApiFault));

  readonly repairProject = (
    projectId: string,
    mutation?: MutationEnvelope,
  ): Effect.Effect<ProjectRecovery, RunApiFault> =>
    Effect.tryPromise({
      try: () => this.#recoveryCoordinator.repair(projectId, mutation),
      catch: runApiFault,
    });

  async #execute(
    project: string,
    runner: string,
    registration: RunnerRegistration,
    authority: RunAuthority,
  ): Promise<void> {
    const prior = await Effect.runPromise(this.#runs.phases(authority.runId));
    const recordedResults = Object.fromEntries(
      prior.map((phase) => [
        JSON.stringify([authority.runId, authority.revisionId, phase.phasePath, phase.attempt]),
        phase.encodedResult,
      ]),
    );
    const applications = await Effect.runPromise(this.#gates.deferredApplications(authority.runId));
    const durableDeferreds = await Effect.runPromise(this.#gates.deferredResults(authority.runId));
    const deferredResults = Object.fromEntries(
      durableDeferreds.map((application) => [
        JSON.stringify([authority.runId, application.deferredName]),
        {
          _id: "Exit",
          _tag: "Success",
          value:
            application.result === null
              ? null
              : {
                  choice: application.result.choice,
                  reason: application.result.reason,
                  answerer: application.result.answerer,
                  answeredAt: Date.parse(application.result.recordedAt),
                },
        } satisfies JsonValue,
      ]),
    );
    const executed = await this.#runnerTransport.run<RunnerExecution>(
      project,
      runner,
      "execute",
      {
        ...registration,
        runId: authority.runId,
        recordedResults,
        deferredResults,
        scheduledWakeups: {},
      },
      authority,
    );
    try {
      const endedAt = new Date(this.#now()).toISOString();
      const phaseByKey = new Map(
        executed.phases.map((phase) => [
          JSON.stringify([authority.runId, authority.revisionId, phase.phasePath, phase.attempt]),
          phase,
        ]),
      );
      for (const [key, result] of Object.entries(executed.recordedResults)) {
        if (key in recordedResults) continue;
        const tuple = JSON.parse(key) as [string, string, string, number];
        if (tuple[0] !== authority.runId || tuple[1] !== authority.revisionId) {
          throw new Error("the Runner returned a result outside its Run or revision");
        }
        const phase = phaseByKey.get(key);
        if (phase === undefined) {
          throw new Error("the Runner omitted timing for a committed Phase result");
        }
        await Effect.runPromise(
          this.#runs.completePhase(authority, { ...phase, encodedResult: result }),
        );
      }
      for (const application of applications) {
        await Effect.runPromise(this.#gates.markApplied(authority, application.wakeupId, endedAt));
      }
      if (executed.outcome === "suspended") {
        const asking = executed.askings[0];
        if (asking === undefined) {
          throw new Error("the Runner suspended without creating an Asking");
        }
        const parts = asking.internalDeferredName.split("/");
        const escalated = parts.at(-1) === "escalated";
        const numberAt = escalated ? parts.length - 2 : parts.length - 1;
        const askingNumber = Number(parts[numberAt]);
        if (parts[0] !== "gate" || !Number.isInteger(askingNumber) || askingNumber < 1) {
          throw new Error("the Runner returned an invalid structured Asking identity");
        }
        const gatePath = parts.slice(1, numberAt).join("/");
        if (gatePath.length === 0) throw new Error("the Runner returned an empty Gate path");
        const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        await Effect.runPromise(
          this.#gates.createAskingAndSuspend(authority, {
            identity: {
              identityVersion: 1,
              runId: authority.runId,
              gatePath,
              askingNumber,
              escalationStage: escalated ? 1 : 0,
            },
            token,
            projectId: registration.projectId,
            workflowName: registration.workflowName,
            description: asking.description,
            actor: asking.actor,
            choices: asking.choices,
            deadline: new Date(asking.deadlineAt).toISOString(),
            expiryBranch: asking.expiryBranch,
            internalDeferredName: asking.internalDeferredName,
            createdAt: new Date(asking.requestedAt).toISOString(),
          }),
        );
        await Effect.runPromise(
          this.#projectRecovery.observeHealthy(registration.projectId, endedAt, true),
        ).catch(() => undefined);
        return;
      }
      await Effect.runPromise(this.#runs.completeRun(authority, executed.outcome, endedAt));
      await Effect.runPromise(
        this.#projectRecovery.observeHealthy(registration.projectId, endedAt, true),
      ).catch(() => undefined);
    } finally {
      this.#activeExecutions.get(authority.runId)?.settleCommit();
    }
  }
}
