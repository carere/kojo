import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  RunDocument,
  RunSnapshot,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { OperationReplyBody } from "@carere/kojo-runner-contracts/contexts/project/contracts/execution";
import { Data, Effect } from "effect";
import type { SqliteDaemonGateRepository } from "../../gate/adapters/SqliteDaemonGateRepository.ts";
import type { SqliteProjectRepository } from "../../project/adapters/SqliteProjectRepository.ts";
import { materializeRevision } from "../../project/services/materializeRevision.ts";
import { makeRunnerFrameReader, writeRunnerFrame } from "../../project/services/runnerChannel.ts";
import type { SqliteRunRepository } from "../adapters/SqliteRunRepository.ts";
import type { DaemonRun, PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
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

const terminal = (run: DaemonRun): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";

const documentOf = (run: DaemonRun, phases: ReadonlyArray<PhaseResult>): RunDocument => ({
  runId: run.runId,
  projectId: run.projectId,
  workflowName: run.workflowName,
  revisionId: run.revisionId,
  packageGraphId: run.packageGraphId,
  state: run.state,
  ...(!terminal(run) && run.state === "queued" ? { queueReason: "runner-starting" as const } : {}),
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
  readonly #gates: SqliteDaemonGateRepository;
  readonly #dispatching = new Set<string>();

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly dataRoot: string;
    readonly now: () => number;
    readonly projects: SqliteProjectRepository;
    readonly runs: SqliteRunRepository;
    readonly gates: SqliteDaemonGateRepository;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#instanceId = options.instanceId;
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#projects = options.projects;
    this.#runs = options.runs;
    this.#gates = options.gates;
  }

  readonly start = (options: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly payload: JsonValue;
  }): Effect.Effect<StartRunResult, RunApiFault> =>
    Effect.tryPromise({ try: () => this.#start(options), catch: runApiFault });

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
      if (!admission.duplicate) {
        const authority = await Effect.runPromise(
          this.#runs.claim(admission.run.runId, runnerInstanceId, admittedAt),
        );
        void this.#execute(revision.location, materialized.runner, registration, authority).finally(
          materialized.dispose,
        );
      } else {
        materialized.dispose();
      }
      return {
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
    Effect.tryPromise({ try: () => this.#continue(runId), catch: runApiFault });

  readonly resumeQueued = (): Effect.Effect<void, RunApiFault> =>
    Effect.tryPromise({
      try: async () => {
        const runs = await Effect.runPromise(this.#runs.list);
        await Promise.all(
          runs.filter((run) => run.state === "queued").map((run) => this.#continue(run.runId)),
        );
      },
      catch: runApiFault,
    });

  async #continue(runId: string): Promise<void> {
    if (this.#dispatching.has(runId)) return;
    this.#dispatching.add(runId);
    let authority: RunAuthority | undefined;
    try {
      const run = await Effect.runPromise(this.#runs.read(runId));
      if (run === undefined || run.state !== "queued") return;
      const revision = await Effect.runPromise(
        this.#projects.pinnedExecutionRevision(run.projectId, run.workflowName, run.revisionId),
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
        payload: run.payload,
        connectionSecret: crypto.getRandomValues(new Uint8Array(32)).toHex(),
      };
      try {
        authority = await Effect.runPromise(
          this.#runs.claim(run.runId, runnerInstanceId, new Date(this.#now()).toISOString()),
        );
        await this.#execute(revision.location, materialized.runner, registration, authority);
      } finally {
        materialized.dispose();
      }
    } catch (cause) {
      const failedAt = new Date(this.#now()).toISOString();
      if (authority === undefined) {
        await Effect.runPromise(this.#runs.failQueuedRun(runId, failedAt)).catch(() => undefined);
      } else {
        await Effect.runPromise(this.#runs.completeRun(authority, "failed", failedAt)).catch(
          () => undefined,
        );
      }
      await Effect.runPromise(this.#gates.reconcileTerminalInabilities()).catch(() => undefined);
      throw cause;
    } finally {
      this.#dispatching.delete(runId);
    }
  }

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
    const deferredResults = Object.fromEntries(
      applications.map((application) => [
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
              deferredResults: request.deferredResults,
              scheduledWakeups: request.scheduledWakeups,
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
