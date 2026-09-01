import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  RunDocument,
  RunSnapshot,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type {
  StartTriggerWorkflowResult,
  StopWorkflowResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { OperationReplyBody } from "@carere/kojo-runner-contracts/contexts/project/contracts/execution";
import { Data, Effect } from "effect";
import type { SqliteProjectRepository } from "../../project/adapters/SqliteProjectRepository.ts";
import { materializeRevision } from "../../project/services/materializeRevision.ts";
import { makeRunnerFrameReader, writeRunnerFrame } from "../../project/services/runnerChannel.ts";
import type { SqliteRunRepository } from "../adapters/SqliteRunRepository.ts";
import type { ClaimedRun, DaemonRun, PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
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
  readonly connectionSecret: string;
}

interface RunnerInspection {
  readonly idempotencyKey: string;
  readonly enginePayload: Record<string, unknown>;
}

interface RunnerExecution extends RunnerInspection {
  readonly runId: string;
  readonly outcome: "succeeded" | "failed";
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
  readonly phases: ReadonlyArray<PhaseResult>;
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

const terminal = (run: DaemonRun): boolean => run.state === "succeeded" || run.state === "failed";

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
): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  KOJO_RUNNER_CHANNEL: channel,
  KOJO_RUNNER_BINDING: JSON.stringify(binding),
});

/** Daemon-owned no-Trigger admission, dispatch, and observation service. */
export class RunApi {
  readonly #dataIdentity: string;
  readonly #instanceId: string;
  readonly #dataRoot: string;
  readonly #now: () => number;
  readonly #projects: SqliteProjectRepository;
  readonly #runs: SqliteRunRepository;
  #pumping = false;

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly dataRoot: string;
    readonly now: () => number;
    readonly projects: SqliteProjectRepository;
    readonly runs: SqliteRunRepository;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#instanceId = options.instanceId;
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#projects = options.projects;
    this.#runs = options.runs;
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
  }): Effect.Effect<StopWorkflowResult, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity)
          throw new Error("the Daemon data identity changed");
        const receipt = await Effect.runPromise(
          this.#projects.stopActivity({
            ...options,
            changedAt: new Date(this.#now()).toISOString(),
          }),
        );
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
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (true) {
        const runnerInstanceId = crypto.randomUUID();
        const claimed = await Effect.runPromise(
          this.#runs.claimNext(runnerInstanceId, new Date(this.#now()).toISOString()),
        );
        if (claimed === undefined) break;
        void this.#dispatch(claimed).finally(() => this.#pump());
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #dispatch(claimed: ClaimedRun): Promise<void> {
    const { run, authority } = claimed;
    try {
      const revision = await Effect.runPromise(
        this.#projects.retainedExecutionRevision(run.projectId, run.workflowName, run.revisionId),
      );
      const executionRoot = join(this.#dataRoot, "runner-materialized");
      mkdirSync(executionRoot, { recursive: true, mode: 0o700 });
      const materialized = materializeRevision({
        retainedRoot: revision.publishedPath,
        executionRoot,
        revisionId: revision.revisionId,
        packageGraphId: revision.packageGraphId,
      });
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
    } catch {
      await Effect.runPromise(
        this.#runs.completeRun(authority, "failed", new Date(this.#now()).toISOString()),
      ).catch(() => undefined);
    } finally {
      await Effect.runPromise(
        this.#projects.settleManualActivity(run.projectId, run.workflowName),
      ).catch(() => undefined);
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
    const executed = await this.#runner<RunnerExecution>(
      project,
      runner,
      "execute",
      {
        ...registration,
        runId: authority.runId,
        recordedResults,
      },
      authority,
    );
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
    await Effect.runPromise(this.#runs.completeRun(authority, executed.outcome, endedAt));
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
        }),
    authority?: RunAuthority,
  ): Promise<A> {
    const channelRoot = join(this.#dataRoot, "runner-channels", crypto.randomUUID());
    const channel = join(channelRoot, "runner.sock");
    mkdirSync(channelRoot, { recursive: true, mode: 0o700 });
    let server: Server | undefined;
    let socket: Socket | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
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
      child = Bun.spawn([process.execPath, runner], {
        cwd: project,
        env: runnerEnvironment(channel, {
          daemonInstanceId: request.daemonInstanceId,
          runnerInstanceId: request.runnerInstanceId,
          projectId: request.projectId,
          packageGraphId: request.packageGraphId,
        }),
        stdin: new Blob([request.connectionSecret]),
        stdout: "pipe",
        stderr: "pipe",
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
      let result = registeredBody.result;
      if (mode === "execute") {
        if (authority === undefined || !("runId" in request))
          throw new Error("Runner execution requires current authority");
        const executeRequestId = crypto.randomUUID();
        await Effect.runPromise(
          writeRunnerFrame(socket, {
            version: 1,
            kind: "ExecuteRun",
            requestId: executeRequestId,
            daemonInstanceId: request.daemonInstanceId,
            runnerInstanceId: request.runnerInstanceId,
            runId: authority.runId,
            revisionId: authority.revisionId,
            claimGeneration: authority.generation,
            body: {
              executionVersion: 1,
              workflowName: request.workflowName,
              payload: request.payload,
              recordedResults: request.recordedResults,
            },
          }),
        );
        const executed = await Effect.runPromise(reader.read);
        const executedBody = executed.body as unknown as OperationReplyBody;
        if (
          executed.kind !== "Ready" ||
          executed.daemonInstanceId !== request.daemonInstanceId ||
          executed.runnerInstanceId !== request.runnerInstanceId ||
          executedBody.operationRequestId !== executeRequestId ||
          executedBody.state !== "committed" ||
          executedBody.result === undefined
        ) {
          throw new Error("the Project Runner did not commit execution reply");
        }
        result = executedBody.result;
      }
      await Effect.runPromise(
        writeRunnerFrame(socket, {
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
      socket.end();
      const exit = await child.exited;
      const [standardOutput, standardError] = await Promise.all([output, error]);
      if (exit !== 0)
        throw new Error(
          `Project Runner exited ${exit}: ${standardError.trim()}${standardOutput.trim()}`,
        );
      return result as A;
    } finally {
      socket?.destroy();
      server?.close();
      child?.kill();
      rmSync(channelRoot, { recursive: true, force: true });
    }
  }
}
