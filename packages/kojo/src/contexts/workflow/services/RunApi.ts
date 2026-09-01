import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  RunDocument,
  RunSnapshot,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Data, Effect } from "effect";
import type { SqliteProjectRepository } from "../../project/adapters/SqliteProjectRepository.ts";
import { materializeRevision } from "../../project/services/materializeRevision.ts";
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
  readonly outcome: "succeeded" | "failed";
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
}

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
  ...(!terminal(run) && run.state === "queued" ? { queueReason: "runner-starting" as const } : {}),
  admittedAt: run.admittedAt,
  ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  phases: phases.map((phase) => ({
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

const runnerEnvironment = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
});

/** Daemon-owned no-Trigger admission, dispatch, and observation service. */
export class RunApi {
  readonly #dataIdentity: string;
  readonly #instanceId: string;
  readonly #dataRoot: string;
  readonly #now: () => number;
  readonly #projects: SqliteProjectRepository;
  readonly #runs: SqliteRunRepository;

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
    const executed = await this.#runner<RunnerExecution>(project, runner, "execute", {
      ...registration,
      runId: authority.runId,
      recordedResults,
    });
    const endedAt = new Date(this.#now()).toISOString();
    for (const [key, result] of Object.entries(executed.recordedResults)) {
      if (key in recordedResults) continue;
      const tuple = JSON.parse(key) as [string, string, string, number];
      if (tuple[0] !== authority.runId || tuple[1] !== authority.revisionId) {
        throw new Error("the Runner returned a result outside its Run or revision");
      }
      await Effect.runPromise(
        this.#runs.completePhase(authority, {
          phasePath: tuple[2],
          attempt: tuple[3],
          kind: "code",
          outcome: "succeeded",
          description: tuple[2],
          startedAt: endedAt,
          endedAt,
          encodedResult: result,
        }),
      );
    }
    await Effect.runPromise(this.#runs.completeRun(authority, executed.outcome, endedAt));
  }

  async #runner<A>(
    project: string,
    runner: string,
    mode: "execute" | "inspect",
    request: unknown,
  ): Promise<A> {
    const child = Bun.spawn([process.execPath, runner, mode], {
      cwd: project,
      env: runnerEnvironment(),
      stdin: new Blob([JSON.stringify(request)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`Project Runner exited ${exit}: ${error.trim()}`);
    return JSON.parse(output) as A;
  }
}
