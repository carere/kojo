import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  CancelRunResult,
  RunDocument,
  RunSnapshot,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type {
  StartTriggerWorkflowResult,
  StopWorkflowResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import {
  decodeJsonValue,
  type JsonValue,
} from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { OperationReplyBody } from "@carere/kojo-runner-contracts/contexts/project/contracts/execution";
import type { RunnerFrame } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import { Data, Effect } from "effect";
import type { SqliteDaemonGateRepository } from "../../gate/adapters/SqliteDaemonGateRepository.ts";
import type {
  ExecutionRevision,
  SqliteProjectRepository,
} from "../../project/adapters/SqliteProjectRepository.ts";
import {
  type MaterializedRevision,
  materializeRevision,
} from "../../project/services/materializeRevision.ts";
import {
  ProjectRunnerError,
  ProjectRunnerSupervisor,
} from "../../project/services/ProjectRunnerSupervisor.ts";
import { makeRunnerFrameReader, writeRunnerFrame } from "../../project/services/runnerChannel.ts";
import type { SqliteTriggerRepository } from "../../trigger/adapters/SqliteTriggerRepository.ts";
import type { SqliteRevisionRepository } from "../adapters/SqliteRevisionRepository.ts";
import type { SqliteRunRepository } from "../adapters/SqliteRunRepository.ts";
import type { DaemonRun, PhaseResult, ReservedRun, RunAuthority } from "../models/DaemonRun.ts";
import { RetainedContentFault } from "../models/RetainedContentFault.ts";
import { DEFAULT_RUNNER_IDLE_MILLIS } from "../models/SchedulingDefaults.ts";
import { canonicalJson } from "./canonicalJson.ts";

interface RunnerRegistration {
  readonly registrationVersion: 1;
  readonly selectedProtocol: 1;
  readonly daemonInstanceId: string;
  readonly runnerInstanceId: string;
  readonly projectId: string;
  readonly boundProjectId: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly boundPackageGraphId: string;
  readonly executionRoot: string;
  readonly workflowName: string;
  readonly entrySource: string;
  readonly payload: JsonValue;
  readonly purpose?: "execution" | "trigger";
  readonly connectionSecret: string;
}

interface RunnerInspection {
  readonly idempotencyKey: string;
  readonly enginePayload: Record<string, unknown>;
}

interface RunnerExecution extends RunnerInspection {
  readonly runId: string;
  readonly outcome: "succeeded" | "failed" | "suspended";
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
  readonly phases: ReadonlyArray<PhaseResult>;
  readonly askings: ReadonlyArray<{
    readonly runId: string;
    readonly gatePath: string;
    readonly asking: string;
    readonly description: string;
    readonly actor: string;
    readonly choices: ReadonlyArray<string>;
    readonly requestedAt: number;
    readonly deadlineAt: number;
    readonly expiryBranch: "fail" | "reject" | "escalate";
    readonly internalDeferredName: string;
  }>;
  readonly deferredResults: Readonly<Record<string, JsonValue>>;
  readonly scheduledWakeups: Readonly<Record<string, string>>;
}

const INTERNAL_PHASE_DESCRIPTION = "__kojo_internal_activity__";

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

const terminal = (run: DaemonRun): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";

const documentOf = (run: DaemonRun, phases: ReadonlyArray<PhaseResult>): RunDocument => ({
  runId: run.runId,
  projectId: run.projectId,
  workflowName: run.workflowName,
  revisionId: run.revisionId,
  packageGraphId: run.packageGraphId,
  state: run.state,
  ...(!terminal(run) && run.state === "queued"
    ? { queueReason: run.queueReason ?? ("runner-starting" as const) }
    : {}),
  admittedAt: run.admittedAt,
  ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  ...(run.executionFault === undefined ? {} : { executionFault: run.executionFault }),
  ...(run.cancellation === undefined ? {} : { cancellation: run.cancellation }),
  ...(run.recovery === undefined ? {} : { recovery: run.recovery }),
  ...(run.cleanup === undefined ? {} : { cleanup: run.cleanup }),
  phases: phases
    .filter((phase) => phase.description !== INTERNAL_PHASE_DESCRIPTION)
    .map((phase) => ({
      phasePath: phase.phasePath,
      attempt: phase.attempt,
      kind: phase.kind,
      outcome: phase.outcome,
      description: phase.description,
      startedAt: phase.startedAt,
      endedAt: phase.endedAt,
      result: phase.encodedResult,
    })),
});

const runnerEnvironment = (
  channel: string,
  binding: {
    readonly daemonInstanceId: string;
    readonly runnerInstanceId: string;
    readonly projectId: string;
    readonly packageGraphId: string;
  },
  executionRoot: string,
): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  KOJO_RUNNER_CHANNEL: channel,
  KOJO_RUNNER_BINDING: JSON.stringify(binding),
  KOJO_FACTORY_ASSET_ROOT: join(executionRoot, ".kojo"),
});

interface ProjectTriggerGroup {
  readonly packageGraphId: string;
  readonly add: (
    revision: ExecutionRevision,
    materialized: MaterializedRevision,
    pollerId: string,
  ) => Promise<void>;
  readonly remove: (revisionId: string, workflowName: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

interface ActiveExecutionControl {
  readonly projectId: string;
  readonly authority: RunAuthority;
  /** Resolves only after the owned Project Runner process group has stopped. */
  readonly cancelAndStop: (deadlineMillis: number) => Promise<void>;
  /** Releases cancellation after returned Phase results reach durable storage. */
  readonly settleCommit: () => void;
}

/** Daemon-owned no-Trigger admission, dispatch, and observation service. */
export class RunApi {
  readonly #dataIdentity: string;
  readonly #instanceId: string;
  readonly #dataRoot: string;
  readonly #now: () => number;
  readonly #projects: SqliteProjectRepository;
  readonly #runs: SqliteRunRepository;
  readonly #revisions: SqliteRevisionRepository;
  readonly #triggers: SqliteTriggerRepository;
  readonly #gates: SqliteDaemonGateRepository;
  readonly #runnerIdleMillis: number;
  readonly #runnerCleanupMillis: number;
  readonly #runnerSupervisor = new ProjectRunnerSupervisor();
  readonly #triggerProcesses = new Map<string, { readonly stop: () => Promise<void> }>();
  readonly #triggerGroups = new Map<string, ProjectTriggerGroup>();
  readonly #activeExecutions = new Map<string, ActiveExecutionControl>();
  #pumping = false;
  #stopping = false;

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly dataRoot: string;
    readonly now: () => number;
    readonly projects: SqliteProjectRepository;
    readonly runs: SqliteRunRepository;
    readonly revisions: SqliteRevisionRepository;
    readonly triggers: SqliteTriggerRepository;
    readonly gates: SqliteDaemonGateRepository;
    readonly runnerIdleMillis?: number;
    readonly runnerCleanupMillis?: number;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#instanceId = options.instanceId;
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#projects = options.projects;
    this.#runs = options.runs;
    this.#revisions = options.revisions;
    this.#triggers = options.triggers;
    this.#gates = options.gates;
    this.#runnerIdleMillis = options.runnerIdleMillis ?? DEFAULT_RUNNER_IDLE_MILLIS;
    this.#runnerCleanupMillis = options.runnerCleanupMillis ?? 30_000;
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
            }),
          );
          if (receipt.pollerId === undefined)
            throw new Error("the active Trigger Workflow has no poller identity");
          await this.#ensureTriggerPoller(
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
            }),
          );
          await this.#stopTriggerPoller(options.projectId, options.workflowName);
          await this.#stopCancelledProject(options.projectId, forced.targetRunIds, changedAt);
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
          this.#projects.stopActivity({ ...options, changedAt }),
        );
        await this.#stopTriggerPoller(options.projectId, options.workflowName);
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
  }): Effect.Effect<CancelRunResult, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity)
          throw new Error("the Daemon data identity changed");
        const requestedAt = new Date(this.#now()).toISOString();
        const cancellation = await Effect.runPromise(
          this.#runs.requestCancellation(options.runId, options.requestId, requestedAt),
        );
        if (cancellation.requiresExecutionStop) {
          await this.#stopCancelledProject(
            cancellation.run.projectId,
            [cancellation.run.runId],
            requestedAt,
          );
        }
        await Effect.runPromise(this.#gates.reconcileTerminalInabilities()).catch(() => undefined);
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

  async #stopCancelledProject(
    projectId: string,
    targetRunIds: ReadonlyArray<string>,
    requestedAt: string,
  ): Promise<void> {
    const deadline = Date.now() + this.#runnerCleanupMillis;
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
    } catch (cause) {
      const detail = `Project Runner termination is not confirmed: ${cause instanceof Error ? cause.message : String(cause)}`;
      await Effect.runPromise(this.#runs.recordCleanupFault(targetRunIds, detail));
      throw cause;
    }
    const stoppedAt = new Date(Math.max(this.#now(), Date.parse(requestedAt))).toISOString();
    await Effect.runPromise(
      this.#runs.confirmProjectRunnerStopped(projectId, targetRunIds, stoppedAt, {
        state: "confirmed",
      }),
    );
    void this.#pump();
  }

  readonly restore = (): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        await Effect.runPromise(
          this.#runs.recoverInterruptedExecutions(new Date(this.#now()).toISOString()),
        );
        for (const poller of await Effect.runPromise(this.#projects.triggerPollers)) {
          await this.#ensureTriggerPoller(poller.projectId, poller.workflowName, poller.pollerId);
        }
        void this.#pump();
      },
      catch: runApiFault,
    });

  readonly shutdown = (): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        this.#stopping = true;
        await Promise.allSettled([
          ...Array.from(this.#triggerProcesses.values(), (process) => process.stop()),
          Effect.runPromise(this.#runnerSupervisor.shutdown()),
        ]);
      },
      catch: runApiFault,
    });

  async #start(options: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly payload: JsonValue;
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
      const inspected = await this.#runner<RunnerInspection>(
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
            operation: "startRun",
            projectId: options.projectId,
            workflowName: options.workflowName,
            payload: options.payload,
          }),
          projectId: options.projectId,
          workflowName: options.workflowName,
          idempotencyKey: inspected.idempotencyKey,
          payload: options.payload,
          revisionId: revision.revisionId,
          packageGraphId: revision.packageGraphId,
          admittedAt,
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

  async #pump(): Promise<void> {
    if (this.#pumping || this.#stopping) return;
    this.#pumping = true;
    try {
      while (true) {
        const reservationId = crypto.randomUUID();
        const reserved = await Effect.runPromise(
          this.#runs.reserveNext(reservationId, new Date(this.#now()).toISOString()),
        );
        if (reserved === undefined) break;
        void this.#dispatch(reserved).finally(() => this.#pump());
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #dispatch(reserved: ReservedRun): Promise<void> {
    const { run } = reserved;
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
              this.#stopProjectTriggerPollers(
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
      } else if (authority !== undefined) {
        const current = await Effect.runPromise(this.#runs.read(authority.runId)).catch(
          () => undefined,
        );
        if (current?.cancellation === undefined) {
          await Effect.runPromise(
            this.#runs.completeRun(authority, "failed", new Date(this.#now()).toISOString()),
          ).catch(() => undefined);
        }
        await Effect.runPromise(this.#gates.reconcileTerminalInabilities()).catch(() => undefined);
      }
    } finally {
      await Effect.runPromise(
        this.#projects.settleManualActivity(run.projectId, run.workflowName),
      ).catch(() => undefined);
      if (!this.#stopping) await this.#restoreProjectTriggerPollers(run.projectId);
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
              documentOf(run, await Effect.runPromise(this.#runs.phases(run.runId))),
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
          : documentOf(run, await Effect.runPromise(this.#runs.phases(runId)));
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
    const executed = await this.#runner<RunnerExecution>(
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
        return;
      }
      await Effect.runPromise(this.#runs.completeRun(authority, executed.outcome, endedAt));
    } finally {
      this.#activeExecutions.get(authority.runId)?.settleCommit();
    }
  }

  #pollerKey(projectId: string, workflowName: string): string {
    return JSON.stringify([projectId, workflowName]);
  }

  async #stopTriggerPoller(projectId: string, workflowName: string): Promise<void> {
    const process = this.#triggerProcesses.get(this.#pollerKey(projectId, workflowName));
    if (process !== undefined) await process.stop();
  }

  async #stopProjectTriggerPollers(projectId: string, detail: string): Promise<void> {
    const pollers = (await Effect.runPromise(this.#projects.triggerPollers)).filter(
      (poller) => poller.projectId === projectId,
    );
    for (const poller of pollers) {
      await Effect.runPromise(
        this.#projects.observeTrigger({
          projectId: poller.projectId,
          workflowName: poller.workflowName,
          state: "delayed",
          detail,
          observedAt: new Date(this.#now()).toISOString(),
        }),
      );
      await this.#stopTriggerPoller(poller.projectId, poller.workflowName);
    }
  }

  async #restoreProjectTriggerPollers(projectId: string): Promise<void> {
    const pollers = (await Effect.runPromise(this.#projects.triggerPollers)).filter(
      (poller) => poller.projectId === projectId,
    );
    for (const poller of pollers) {
      await this.#ensureTriggerPoller(poller.projectId, poller.workflowName, poller.pollerId).catch(
        () => undefined,
      );
    }
  }

  async #ensureTriggerPoller(
    projectId: string,
    workflowName: string,
    pollerId: string,
  ): Promise<void> {
    const key = this.#pollerKey(projectId, workflowName);
    if (this.#triggerProcesses.has(key)) return;
    const revision = await Effect.runPromise(
      this.#projects.executionRevision(projectId, workflowName),
    );
    let group = this.#triggerGroups.get(projectId);
    if (group !== undefined && group.packageGraphId !== revision.packageGraphId) {
      await Effect.runPromise(this.#runnerSupervisor.stop(projectId));
      group = undefined;
    }
    const executionRoot = join(this.#dataRoot, "runner-materialized");
    mkdirSync(executionRoot, { recursive: true, mode: 0o700 });
    const materialized = materializeRevision({
      retainedRoot: revision.publishedPath,
      executionRoot,
      revisionId: revision.revisionId,
      packageGraphId: revision.packageGraphId,
    });
    let created = false;
    try {
      if (group === undefined) {
        group = await this.#createTriggerGroup(revision, materialized);
        created = true;
      }
      await group.add(revision, materialized, pollerId);
      const selectedGroup = group;
      const handle = {
        stop: async (): Promise<void> => {
          await selectedGroup.remove(revision.revisionId, revision.workflowName);
          if (this.#triggerProcesses.get(key) === handle) this.#triggerProcesses.delete(key);
        },
      };
      this.#triggerProcesses.set(key, handle);
    } catch (cause) {
      if (created) await group?.stop().catch(() => undefined);
      materialized.dispose();
      throw cause;
    }
  }

  async #createTriggerGroup(
    bootstrap: ExecutionRevision,
    bootstrapMaterialized: MaterializedRevision,
  ): Promise<ProjectTriggerGroup> {
    await Effect.runPromise(this.#runnerSupervisor.stop(bootstrap.projectId));
    const runnerInstanceId = crypto.randomUUID();
    const connectionSecret = crypto.getRandomValues(new Uint8Array(32)).toHex();
    const channelRoot = join(this.#dataRoot, "runner-channels", crypto.randomUUID());
    const channel = join(channelRoot, "runner.sock");
    mkdirSync(channelRoot, { recursive: true, mode: 0o700 });
    let server: Server | undefined;
    let socket: Socket | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const registrations = new Map<
      string,
      {
        readonly revision: ExecutionRevision;
        readonly materialized: MaterializedRevision;
        readonly pollerId: string;
      }
    >();
    const pending = new Map<
      string,
      {
        readonly resolve: (frame: RunnerFrame) => void;
        readonly reject: (cause: unknown) => void;
      }
    >();
    const registrationKey = (revisionId: string, workflowName: string): string =>
      JSON.stringify([revisionId, workflowName]);
    let stopping: Promise<void> | undefined;
    let readerDone: Promise<void> | undefined;
    let readerFailure: unknown;
    let stopGroup: (() => Promise<void>) | undefined;
    const cleanup = (): void => {
      socket?.destroy();
      server?.close();
      rmSync(channelRoot, { recursive: true, force: true });
    };
    const reply = (frame: RunnerFrame, result: JsonValue): Promise<void> =>
      Effect.runPromise(
        writeRunnerFrame(socket as Socket, {
          version: 1,
          kind: "Ready",
          requestId: crypto.randomUUID(),
          daemonInstanceId: this.#instanceId,
          runnerInstanceId,
          body: {
            replyVersion: 1,
            operationRequestId: frame.requestId,
            state: "committed",
            result,
          },
        }),
      );
    const command = async (
      kind: "RegisterRevision" | "DisposeRevision" | "StartTrigger" | "StopTrigger" | "Shutdown",
      body: JsonValue,
    ): Promise<RunnerFrame> => {
      if (socket === undefined) throw new Error("the Project Runner channel is not connected");
      if (readerFailure !== undefined) throw readerFailure;
      const requestId = crypto.randomUUID();
      const result = new Promise<RunnerFrame>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
      });
      await Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind,
          requestId,
          daemonInstanceId: this.#instanceId,
          runnerInstanceId,
          body,
        }),
      ).catch((cause) => {
        pending.delete(requestId);
        throw cause;
      });
      return result;
    };
    const handleMutation = async (frame: RunnerFrame): Promise<void> => {
      const body = frame.body as unknown as Record<string, unknown>;
      const workflowName = body.workflowName;
      if (typeof workflowName !== "string" || !("revisionId" in frame)) {
        throw new Error("the Trigger Runner operation has no exact registration identity");
      }
      const registered = registrations.get(registrationKey(frame.revisionId, workflowName));
      if (registered === undefined || body.projectId !== bootstrap.projectId) {
        throw new Error("the Trigger Runner operation escaped its exact registration");
      }
      if (frame.kind === "AdmitTriggerRequest") {
        try {
          const payload = decodeJsonValue(body.payload);
          if (
            typeof body.source !== "string" ||
            typeof body.eventId !== "string" ||
            typeof body.idempotencyKey !== "string" ||
            typeof body.deliveredAt !== "string" ||
            body.revisionId !== registered.revision.revisionId ||
            body.packageGraphId !== registered.revision.packageGraphId ||
            !payload.ok
          ) {
            throw new Error("the Trigger admission body is invalid");
          }
          const admission = await Effect.runPromise(
            this.#triggers.admit({
              projectId: bootstrap.projectId,
              workflowName,
              source: body.source,
              eventId: body.eventId,
              idempotencyKey: body.idempotencyKey,
              payload: payload.value,
              revisionId: registered.revision.revisionId,
              packageGraphId: registered.revision.packageGraphId,
              deliveredAt: body.deliveredAt,
            }),
          );
          await reply(frame, {
            accepted: true,
            duplicate: admission.duplicate,
            runId: admission.run.runId,
          });
        } catch (cause) {
          const code =
            typeof cause === "object" && cause !== null && "code" in cause
              ? String(cause.code)
              : "STORE_FAILED";
          await reply(frame, {
            accepted: false,
            retry: code === "QUEUE_FULL" || code === "STORE_FAILED",
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
        return;
      }
      if (frame.kind === "RecordRejectedTriggerEvent") {
        if (
          typeof body.reason !== "string" ||
          typeof body.source !== "string" ||
          typeof body.eventId !== "string" ||
          typeof body.deliveredAt !== "string" ||
          body.revisionId !== registered.revision.revisionId ||
          body.packageGraphId !== registered.revision.packageGraphId
        ) {
          throw new Error("the Trigger rejection body is invalid");
        }
        await Effect.runPromise(
          this.#triggers.reject(
            {
              projectId: bootstrap.projectId,
              workflowName,
              source: body.source,
              eventId: body.eventId,
              revisionId: registered.revision.revisionId,
              packageGraphId: registered.revision.packageGraphId,
              deliveredAt: body.deliveredAt,
            },
            body.reason,
          ),
        );
        await reply(frame, { recorded: true });
        return;
      }
      if (frame.kind === "RecordTriggerProgress") {
        const state = body.state;
        if (state !== "polling" && state !== "delayed" && state !== "failed") {
          throw new Error("the Trigger progress state is invalid");
        }
        await Effect.runPromise(
          this.#projects.observeTrigger({
            projectId: bootstrap.projectId,
            workflowName,
            state,
            detail: String(body.detail ?? "Trigger progress"),
            observedAt: String(body.observedAt ?? new Date(this.#now()).toISOString()),
          }),
        );
        await reply(frame, { recorded: true });
        if (state === "polling") void this.#pump();
        return;
      }
      throw new Error(`the Trigger Runner sent unexpected ${frame.kind}`);
    };

    try {
      const accepted = new Promise<Socket>((resolve, reject) => {
        server = createServer(resolve);
        server.once("error", reject);
        server.listen(channel);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("listening", resolve);
        server?.once("error", reject);
      });
      chmodSync(channel, 0o600);
      child = Bun.spawn(
        [process.execPath, "--no-install", "--no-env-file", bootstrapMaterialized.runner],
        {
          cwd: bootstrap.location,
          env: runnerEnvironment(
            channel,
            {
              daemonInstanceId: this.#instanceId,
              runnerInstanceId,
              projectId: bootstrap.projectId,
              packageGraphId: bootstrap.packageGraphId,
            },
            bootstrapMaterialized.root,
          ),
          stdin: new Blob([connectionSecret]),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = new Response(child.stdout as ReadableStream<Uint8Array>).text();
      const error = new Response(child.stderr as ReadableStream<Uint8Array>).text();
      socket = await Promise.race([
        accepted,
        child.exited.then((exit) =>
          Promise.reject(new Error(`Project Runner exited ${exit} before Trigger binding`)),
        ),
        Bun.sleep(10_000).then(() =>
          Promise.reject(new Error("Project Runner Trigger binding timed out")),
        ),
      ]);
      server?.close();
      const reader = makeRunnerFrameReader(socket);
      const hello = await Effect.runPromise(reader.read);
      if (
        hello.kind !== "Hello" ||
        hello.daemonInstanceId !== this.#instanceId ||
        hello.runnerInstanceId !== runnerInstanceId ||
        hello.body.connectionSecret !== connectionSecret ||
        hello.body.projectId !== bootstrap.projectId ||
        hello.body.packageGraphId !== bootstrap.packageGraphId
      ) {
        throw new Error("the Trigger Runner Hello does not match its private binding");
      }
      await Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind: "Welcome",
          requestId: crypto.randomUUID(),
          daemonInstanceId: this.#instanceId,
          runnerInstanceId,
          body: {
            welcomeVersion: 1,
            packageGraphId: bootstrap.packageGraphId,
            projectId: bootstrap.projectId,
            selectedProtocol: 1,
            features: [],
          },
        }),
      );
      readerDone = (async () => {
        while (true) {
          const frame = await Effect.runPromise(reader.read);
          if (
            frame.daemonInstanceId !== this.#instanceId ||
            frame.runnerInstanceId !== runnerInstanceId
          ) {
            throw new Error("the Trigger Runner frame escaped its private binding");
          }
          if (frame.kind === "Ready" || frame.kind === "Stopped") {
            const body = frame.body as unknown as { readonly operationRequestId?: string };
            const selected =
              typeof body.operationRequestId === "string"
                ? pending.get(body.operationRequestId)
                : undefined;
            if (selected === undefined) throw new Error("the Runner reply has no pending command");
            pending.delete(body.operationRequestId as string);
            selected.resolve(frame);
            if (frame.kind === "Stopped") return;
            continue;
          }
          if (frame.kind === "Fault") {
            const body = frame.body as unknown as Record<string, unknown>;
            if (typeof body.workflowName === "string") {
              await Effect.runPromise(
                this.#projects.observeTrigger({
                  projectId: bootstrap.projectId,
                  workflowName: body.workflowName,
                  state: "failed",
                  detail: String(body.message ?? "the Trigger Runner reported a fault"),
                  observedAt: new Date(this.#now()).toISOString(),
                }),
              ).catch(() => undefined);
            }
            continue;
          }
          await handleMutation(frame);
        }
      })().catch((cause) => {
        readerFailure = cause;
        for (const selected of pending.values()) selected.reject(cause);
        pending.clear();
        if (stopping === undefined && !this.#stopping) {
          for (const registered of registrations.values()) {
            void Effect.runPromise(
              this.#projects.observeTrigger({
                projectId: bootstrap.projectId,
                workflowName: registered.revision.workflowName,
                state: "failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                observedAt: new Date(this.#now()).toISOString(),
              }),
            ).catch(() => undefined);
          }
        }
        void stopGroup?.().catch(() => undefined);
        throw cause;
      });

      let group: ProjectTriggerGroup;
      const stop = (): Promise<void> => {
        stopping ??= (async () => {
          try {
            if (child !== undefined && child.exitCode === null) {
              const stopped = await command("Shutdown", null).catch(() => undefined);
              if (stopped?.kind !== "Stopped") child.kill("SIGTERM");
              await child.exited;
            }
            await readerDone?.catch(() => undefined);
            await Promise.all([output, error]);
            await Effect.runPromise(
              this.#revisions.confirmProcessExit(
                runnerInstanceId,
                new Date(this.#now()).toISOString(),
              ),
            );
          } finally {
            for (const registered of registrations.values()) registered.materialized.dispose();
            registrations.clear();
            for (const pollerKey of this.#triggerProcesses.keys()) {
              if (pollerKey.startsWith(`[${JSON.stringify(bootstrap.projectId)},`)) {
                this.#triggerProcesses.delete(pollerKey);
              }
            }
            if (this.#triggerGroups.get(bootstrap.projectId) === group) {
              this.#triggerGroups.delete(bootstrap.projectId);
            }
            this.#runnerSupervisor.detach(bootstrap.projectId, runnerInstanceId);
            cleanup();
          }
        })();
        return stopping;
      };
      stopGroup = stop;
      group = {
        packageGraphId: bootstrap.packageGraphId,
        add: async (revision, materialized, pollerId) => {
          if (revision.packageGraphId !== bootstrap.packageGraphId) {
            throw new Error("one Project Runner cannot load a different package graph");
          }
          const key = registrationKey(revision.revisionId, revision.workflowName);
          if (registrations.has(key)) return;
          await Effect.runPromise(
            this.#revisions.acquireReader({
              readerId: JSON.stringify([
                "runner-registration",
                runnerInstanceId,
                revision.revisionId,
                revision.workflowName,
              ]),
              revisionId: revision.revisionId,
              kind: "loaded",
              runnerInstanceId,
              acquiredAt: new Date(this.#now()).toISOString(),
            }),
          );
          const registered = await command("RegisterRevision", {
            registrationVersion: 1,
            purpose: "trigger",
            revisionId: revision.revisionId,
            packageGraphId: revision.packageGraphId,
            workflowName: revision.workflowName,
            retainedRoot: materialized.root,
            entrySource: revision.entrySource,
            payload: null,
          });
          const registeredBody = registered.body as unknown as OperationReplyBody;
          if (
            registered.kind !== "Ready" ||
            registeredBody.state !== "committed" ||
            registeredBody.result === null ||
            typeof registeredBody.result !== "object" ||
            Array.isArray(registeredBody.result) ||
            !("triggerDeclared" in registeredBody.result) ||
            registeredBody.result.triggerDeclared !== true
          ) {
            throw new Error("the Project Runner did not register one authored Trigger");
          }
          registrations.set(key, { revision, materialized, pollerId });
          const started = await command("StartTrigger", {
            pollerId,
            revisionId: revision.revisionId,
            workflowName: revision.workflowName,
          });
          if (started.kind !== "Ready") {
            registrations.delete(key);
            throw new Error("the Project Runner did not start its authored Trigger");
          }
          await Effect.runPromise(
            this.#projects.observeTrigger({
              projectId: revision.projectId,
              workflowName: revision.workflowName,
              state: "polling",
              detail: `listening in shared Project Runner ${runnerInstanceId}`,
              observedAt: new Date(this.#now()).toISOString(),
            }),
          );
        },
        remove: async (revisionId, workflowName) => {
          const key = registrationKey(revisionId, workflowName);
          const registered = registrations.get(key);
          if (registered === undefined) return;
          await command("StopTrigger", { revisionId, workflowName });
          await command("DisposeRevision", { revisionId, workflowName });
          await Effect.runPromise(
            this.#revisions.releaseReader(
              JSON.stringify(["runner-registration", runnerInstanceId, revisionId, workflowName]),
              { kind: "disposed", confirmedAt: new Date(this.#now()).toISOString() },
            ),
          );
          registrations.delete(key);
          registered.materialized.dispose();
          if (registrations.size === 0) await stop();
        },
        stop,
      };
      this.#triggerGroups.set(bootstrap.projectId, group);
      await Effect.runPromise(
        this.#runnerSupervisor.attach(bootstrap.projectId, {
          instanceId: runnerInstanceId,
          packageGraphId: bootstrap.packageGraphId,
          purpose: "trigger",
          stop: Effect.tryPromise({ try: stop, catch: runnerError }),
        }),
      );
      return group;
    } catch (cause) {
      child?.kill();
      await child?.exited.catch(() => undefined);
      await Effect.runPromise(
        this.#revisions.confirmProcessExit(runnerInstanceId, new Date(this.#now()).toISOString()),
      ).catch(() => undefined);
      cleanup();
      throw cause;
    }
  }

  async #runner<A>(
    project: string,
    runner: string,
    mode: "execute" | "inspect",
    request:
      | RunnerRegistration
      | (RunnerRegistration & {
          readonly runId: string;
          readonly recordedResults: Readonly<Record<string, JsonValue>>;
          readonly deferredResults: Readonly<Record<string, JsonValue>>;
          readonly scheduledWakeups: Readonly<Record<string, string>>;
        }),
    authority?: RunAuthority,
  ): Promise<A> {
    if (mode === "execute") {
      await Effect.runPromise(this.#runnerSupervisor.stop(request.projectId));
    }
    const channelRoot = join(this.#dataRoot, "runner-channels", crypto.randomUUID());
    const channel = join(channelRoot, "runner.sock");
    mkdirSync(channelRoot, { recursive: true, mode: 0o700 });
    let server: Server | undefined;
    let socket: Socket | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let detached = false;
    let processExitConfirmed = false;
    const revisionReaderId = JSON.stringify([
      "runner-registration",
      request.runnerInstanceId,
      request.revisionId,
      request.workflowName,
    ]);
    let revisionReaderAcquired = false;
    const cleanup = (): void => {
      socket?.destroy();
      server?.close();
      child?.kill();
      rmSync(channelRoot, { recursive: true, force: true });
    };
    try {
      const accepted = new Promise<Socket>((resolve, reject) => {
        server = createServer(resolve);
        server.once("error", reject);
        server.listen(channel);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("listening", resolve);
        server?.once("error", reject);
      });
      chmodSync(channel, 0o600);
      child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", runner], {
        cwd: project,
        env: runnerEnvironment(
          channel,
          {
            daemonInstanceId: request.daemonInstanceId,
            runnerInstanceId: request.runnerInstanceId,
            projectId: request.projectId,
            packageGraphId: request.packageGraphId,
          },
          request.executionRoot,
        ),
        stdin: new Blob([request.connectionSecret]),
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      const output = new Response(child.stdout as ReadableStream<Uint8Array>).text();
      const error = new Response(child.stderr as ReadableStream<Uint8Array>).text();
      socket = await Promise.race([
        accepted,
        child.exited.then((exit) =>
          Promise.reject(new Error(`Project Runner exited ${exit} before private binding`)),
        ),
        Bun.sleep(10_000).then(() =>
          Promise.reject(new Error("Project Runner private binding timed out")),
        ),
      ]);
      server?.close();
      const reader = makeRunnerFrameReader(socket);
      const hello = await Effect.runPromise(reader.read);
      if (
        hello.kind !== "Hello" ||
        hello.daemonInstanceId !== request.daemonInstanceId ||
        hello.runnerInstanceId !== request.runnerInstanceId ||
        hello.body.connectionSecret !== request.connectionSecret ||
        hello.body.projectId !== request.projectId ||
        hello.body.packageGraphId !== request.packageGraphId
      ) {
        throw new Error("the Project Runner Hello does not match its private binding");
      }
      await Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind: "Welcome",
          requestId: crypto.randomUUID(),
          daemonInstanceId: request.daemonInstanceId,
          runnerInstanceId: request.runnerInstanceId,
          body: {
            welcomeVersion: 1,
            packageGraphId: request.packageGraphId,
            projectId: request.projectId,
            selectedProtocol: 1,
            features: [],
          },
        }),
      );
      await Effect.runPromise(
        this.#revisions.acquireReader({
          readerId: revisionReaderId,
          revisionId: request.revisionId,
          kind: "loaded",
          runnerInstanceId: request.runnerInstanceId,
          acquiredAt: new Date(this.#now()).toISOString(),
        }),
      );
      revisionReaderAcquired = true;
      const registerRequestId = crypto.randomUUID();
      await Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind: "RegisterRevision",
          requestId: registerRequestId,
          daemonInstanceId: request.daemonInstanceId,
          runnerInstanceId: request.runnerInstanceId,
          body: {
            registrationVersion: 1,
            purpose: request.purpose ?? "execution",
            revisionId: request.revisionId,
            packageGraphId: request.packageGraphId,
            workflowName: request.workflowName,
            retainedRoot: request.executionRoot,
            entrySource: request.entrySource,
            payload: request.payload,
          },
        }),
      );
      const registered = await Effect.runPromise(reader.read);
      const registeredBody = registered.body as unknown as OperationReplyBody;
      if (
        registered.kind !== "Ready" ||
        registered.daemonInstanceId !== request.daemonInstanceId ||
        registered.runnerInstanceId !== request.runnerInstanceId ||
        registeredBody.operationRequestId !== registerRequestId ||
        registeredBody.state !== "committed" ||
        registeredBody.result === undefined
      ) {
        throw new Error("the Project Runner did not commit exact revision registration");
      }
      const inspectShutdown = async (): Promise<void> => {
        await Effect.runPromise(
          writeRunnerFrame(socket as Socket, {
            version: 1,
            kind: "Shutdown",
            requestId: crypto.randomUUID(),
            daemonInstanceId: request.daemonInstanceId,
            runnerInstanceId: request.runnerInstanceId,
            body: null,
          }),
        );
        const stopped = await Effect.runPromise(reader.read);
        if (
          stopped.kind !== "Stopped" ||
          stopped.daemonInstanceId !== request.daemonInstanceId ||
          stopped.runnerInstanceId !== request.runnerInstanceId
        ) {
          throw new Error("the Project Runner did not stop cleanly");
        }
        socket?.end();
        const exit = await child?.exited;
        processExitConfirmed = true;
        const [standardOutput, standardError] = await Promise.all([output, error]);
        if (exit !== 0)
          throw new Error(
            `Project Runner exited ${exit}: ${standardError.trim()}${standardOutput.trim()}`,
          );
      };
      if (mode === "inspect") {
        await inspectShutdown();
        return registeredBody.result as A;
      }
      if (authority === undefined || !("runId" in request))
        throw new Error("Runner execution requires current authority");

      const pending = new Map<
        string,
        { readonly resolve: (value: JsonValue) => void; readonly reject: (cause: unknown) => void }
      >();
      let stoppedRequestId: string | undefined;
      const readerDone = (async () => {
        while (true) {
          const frame = await Effect.runPromise(reader.read);
          if (
            frame.daemonInstanceId !== request.daemonInstanceId ||
            frame.runnerInstanceId !== request.runnerInstanceId
          ) {
            throw new Error("the Project Runner reply escaped its private binding");
          }
          const body = frame.body as unknown as {
            readonly operationRequestId?: string;
            readonly state?: string;
            readonly result?: JsonValue;
            readonly message?: string;
          };
          const selected =
            typeof body.operationRequestId === "string"
              ? pending.get(body.operationRequestId)
              : undefined;
          if (frame.kind === "Ready" && selected !== undefined && body.state === "committed") {
            pending.delete(body.operationRequestId as string);
            selected.resolve(body.result ?? null);
            continue;
          }
          if (frame.kind === "Fault" && selected !== undefined) {
            pending.delete(body.operationRequestId as string);
            selected.reject(new Error(body.message ?? "the Project Runner reported a fault"));
            continue;
          }
          if (frame.kind === "Stopped") {
            stoppedRequestId = body.operationRequestId;
            if (selected !== undefined) {
              pending.delete(body.operationRequestId as string);
              selected.resolve({ stopped: true });
            }
            return;
          }
          throw new Error(`the Project Runner sent unexpected ${frame.kind}`);
        }
      })().catch((cause) => {
        for (const selected of pending.values()) selected.reject(cause);
        pending.clear();
      });
      const command = async (
        kind: "ExecuteRun" | "CancelRun" | "Shutdown",
        body: JsonValue,
      ): Promise<JsonValue> => {
        const requestId = crypto.randomUUID();
        const result = new Promise<JsonValue>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
        });
        await Effect.runPromise(
          writeRunnerFrame(
            socket as Socket,
            {
              version: 1,
              kind,
              requestId,
              daemonInstanceId: request.daemonInstanceId,
              runnerInstanceId: request.runnerInstanceId,
              ...(kind === "Shutdown"
                ? {}
                : {
                    runId: authority.runId,
                    revisionId: authority.revisionId,
                    claimGeneration: authority.generation,
                  }),
              body,
            } as RunnerFrame,
          ),
        ).catch((cause) => {
          pending.delete(requestId);
          throw cause;
        });
        return result;
      };
      const forceProcessGroup = async (): Promise<void> => {
        if (child === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        await child.exited;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            process.kill(-child.pid, 0);
            await Bun.sleep(10);
          } catch {
            return;
          }
        }
        throw new Error("the owned Project Runner process group did not terminate");
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopping: Promise<void> | undefined;
      let executionState: "starting" | "running" | "finished" | "committed" = "starting";
      let releaseCommit: (() => void) | undefined;
      const commitSettled = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      const processGroupExists = (): boolean => {
        if (child === undefined) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const confirmRevisionReaderExit = async (): Promise<void> => {
        if (!revisionReaderAcquired || !processExitConfirmed) return;
        await Effect.runPromise(
          this.#revisions.confirmProcessExit(
            request.runnerInstanceId,
            new Date(this.#now()).toISOString(),
          ),
        );
        revisionReaderAcquired = false;
      };
      const stop = (): Promise<void> => {
        stopping ??= (async () => {
          if (timer !== undefined) clearTimeout(timer);
          if (child !== undefined && child.exitCode === null) {
            const graceful = await Promise.race([
              command("Shutdown", null).then(() => true),
              Bun.sleep(1_000).then(() => false),
            ]).catch(() => false);
            if (!graceful || stoppedRequestId === undefined) await forceProcessGroup();
          }
          await child?.exited;
          if (processGroupExists()) await forceProcessGroup();
          processExitConfirmed = true;
          await readerDone.catch(() => undefined);
          await Promise.all([output, error]);
          await confirmRevisionReaderExit();
        })().then(
          () => {
            cleanup();
            this.#runnerSupervisor.detach(request.projectId, request.runnerInstanceId);
            this.#activeExecutions.delete(authority.runId);
          },
          (cause) => {
            stopping = undefined;
            throw cause;
          },
        );
        return stopping;
      };
      const control: ActiveExecutionControl = {
        projectId: request.projectId,
        authority,
        cancelAndStop: async (deadlineMillis) => {
          if (executionState === "finished") await commitSettled;
          if (executionState !== "running") {
            await stop();
            return;
          }
          const cooperative = await Promise.race([
            command("CancelRun", {
              cancellationVersion: 1,
              deadlineAt: new Date(this.#now() + deadlineMillis).toISOString(),
            }).then(() => true),
            Bun.sleep(deadlineMillis).then(() => false),
          ]).catch(() => false);
          if (!cooperative) {
            if (timer !== undefined) clearTimeout(timer);
            await forceProcessGroup();
            processExitConfirmed = true;
            await confirmRevisionReaderExit();
            stopping ??= Promise.resolve().then(() => {
              cleanup();
              this.#runnerSupervisor.detach(request.projectId, request.runnerInstanceId);
              this.#activeExecutions.delete(authority.runId);
            });
            await stopping;
            return;
          }
          await stop();
        },
        settleCommit: () => {
          releaseCommit?.();
          releaseCommit = undefined;
          if (executionState === "finished") {
            executionState = "committed";
            timer = setTimeout(() => void stop().catch(() => undefined), this.#runnerIdleMillis);
          }
        },
      };
      this.#activeExecutions.set(authority.runId, control);
      await Effect.runPromise(
        this.#runnerSupervisor.attach(request.projectId, {
          instanceId: request.runnerInstanceId,
          packageGraphId: request.packageGraphId,
          purpose: "execution",
          stop: Effect.tryPromise({ try: stop, catch: runnerError }),
        }),
      );
      detached = true;
      const beforeExecution = await Effect.runPromise(this.#runs.read(authority.runId));
      if (beforeExecution?.cancellation?.state === "requested") {
        await control.cancelAndStop(this.#runnerCleanupMillis);
        await Effect.runPromise(
          this.#runs.confirmProjectRunnerStopped(
            request.projectId,
            [authority.runId],
            new Date(this.#now()).toISOString(),
            { state: "confirmed" },
          ),
        );
        throw new Error("the Run was cancelled before Workflow execution started");
      }
      executionState = "running";
      try {
        const result = await command("ExecuteRun", {
          executionVersion: 1,
          workflowName: request.workflowName,
          payload: request.payload,
          recordedResults: request.recordedResults,
          deferredResults: request.deferredResults,
          scheduledWakeups: request.scheduledWakeups,
        });
        executionState = "finished";
        return result as A;
      } catch (cause) {
        executionState = "finished";
        releaseCommit?.();
        releaseCommit = undefined;
        await stop().catch(() => undefined);
        throw cause;
      }
    } finally {
      if (!detached) {
        if (child !== undefined) {
          if (child.exitCode === null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          await child.exited.catch(() => undefined);
          processExitConfirmed = true;
        }
        if (revisionReaderAcquired && processExitConfirmed) {
          await Effect.runPromise(
            this.#revisions.confirmProcessExit(
              request.runnerInstanceId,
              new Date(this.#now()).toISOString(),
            ),
          ).catch(() => undefined);
          revisionReaderAcquired = false;
        }
        cleanup();
        if (authority !== undefined) this.#activeExecutions.delete(authority.runId);
      }
    }
  }
}
