import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { OperationReplyBody } from "@carere/kojo-runner-contracts/contexts/project/contracts/execution";
import type { RunnerFrame } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import { decodeTraceMutation } from "@carere/kojo-runner-contracts/contexts/project/contracts/trace";
import { Data, Effect } from "effect";
import type { ProjectRecoveryRepository } from "../../project/ports/ProjectRecoveryRepository.ts";
import type { ResourceLeaseRepository } from "../../project/ports/ResourceLeaseRepository.ts";
import {
  ProjectRunnerError,
  type ProjectRunnerSupervisor,
} from "../../project/services/ProjectRunnerSupervisor.ts";
import {
  makeRunnerFrameReader,
  RunnerChannelError,
  writeRunnerFrame,
} from "../../project/services/runnerChannel.ts";
import type { ArtifactRepository } from "../../trace/ports/ArtifactRepository.ts";
import type { TraceRepository } from "../../trace/ports/TraceRepository.ts";
import type { PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
import type { RunnerMutationFault } from "../models/RunnerMutationFault.ts";
import type { ExternalActionRepository } from "../ports/ExternalActionRepository.ts";
import type { RevisionRepository } from "../ports/RevisionRepository.ts";
import type { RunRepository } from "../ports/RunRepository.ts";
export interface RunnerRegistration {
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

export interface RunnerInspection {
  readonly idempotencyKey: string;
  readonly enginePayload: Record<string, unknown>;
}

export interface RunnerExecution extends RunnerInspection {
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

export interface ActiveExecutionControl {
  readonly projectId: string;
  readonly authority: RunAuthority;
  readonly cancelAndStop: (deadlineMillis: number) => Promise<void>;
  readonly settleCommit: () => void;
}

export class ProjectRunnerConnectionLost extends Data.TaggedError("ProjectRunnerConnectionLost")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class ProjectRunnerProtocolFault extends Data.TaggedError("ProjectRunnerProtocolFault")<{
  readonly message: string;
}> {}

const projectRunnerProtocolFault = (message: string): ProjectRunnerProtocolFault =>
  new ProjectRunnerProtocolFault({ message });

const runnerError = (cause: unknown): ProjectRunnerError =>
  cause instanceof ProjectRunnerError
    ? cause
    : new ProjectRunnerError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
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

interface ProjectRunnerTransportOptions {
  readonly dataRoot: string;
  readonly now: () => number;
  readonly projectRecovery: ProjectRecoveryRepository["Service"];
  readonly runs: RunRepository["Service"];
  readonly actions: ExternalActionRepository["Service"];
  readonly revisions: RevisionRepository["Service"];
  readonly resources: ResourceLeaseRepository["Service"];
  readonly trace: TraceRepository;
  readonly artifacts: ArtifactRepository;
  readonly runnerSupervisor: ProjectRunnerSupervisor;
  readonly activeExecutions: Map<string, ActiveExecutionControl>;
  readonly runnerSettings: () => {
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
}

/** One private Runner process, its authenticated channel, mutations, health, and process stop. */
export class ProjectRunnerTransport {
  readonly #dataRoot: string;
  readonly #now: () => number;
  readonly #projectRecovery: ProjectRecoveryRepository["Service"];
  readonly #runs: RunRepository["Service"];
  readonly #actions: ExternalActionRepository["Service"];
  readonly #revisions: RevisionRepository["Service"];
  readonly #resources: ResourceLeaseRepository["Service"];
  readonly #trace: TraceRepository;
  readonly #artifacts: ArtifactRepository;
  readonly #runnerSupervisor: ProjectRunnerSupervisor;
  readonly #activeExecutions: Map<string, ActiveExecutionControl>;
  readonly #runnerSettings: ProjectRunnerTransportOptions["runnerSettings"];
  readonly #resourceMutationFault?: ProjectRunnerTransportOptions["resourceMutationFault"];

  constructor(options: ProjectRunnerTransportOptions) {
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#projectRecovery = options.projectRecovery;
    this.#runs = options.runs;
    this.#actions = options.actions;
    this.#revisions = options.revisions;
    this.#resources = options.resources;
    this.#trace = options.trace;
    this.#artifacts = options.artifacts;
    this.#runnerSupervisor = options.runnerSupervisor;
    this.#activeExecutions = options.activeExecutions;
    this.#runnerSettings = options.runnerSettings;
    this.#resourceMutationFault = options.resourceMutationFault;
  }

  readonly run = async <A>(
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
  ): Promise<A> => {
    const settings = this.#runnerSettings();
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
    let healthTimer: ReturnType<typeof setInterval> | undefined;
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
      if (healthTimer !== undefined) clearInterval(healthTimer);
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
        Bun.sleep(settings.handshakeMs).then(() =>
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
        throw projectRunnerProtocolFault(
          "the Project Runner Hello does not match its private binding",
        );
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
        throw projectRunnerProtocolFault(
          "the Project Runner did not commit exact revision registration",
        );
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
      const replyMutation = (frame: RunnerFrame, result: JsonValue): Promise<void> =>
        Effect.runPromise(
          writeRunnerFrame(socket as Socket, {
            version: 1,
            kind: "Ready",
            requestId: crypto.randomUUID(),
            daemonInstanceId: request.daemonInstanceId,
            runnerInstanceId: request.runnerInstanceId,
            body: {
              replyVersion: 1,
              operationRequestId: frame.requestId,
              state: "committed",
              result,
            },
          }),
        );
      const readerDone = (async () => {
        while (true) {
          const frame = await Effect.runPromise(reader.read);
          if (
            frame.daemonInstanceId !== request.daemonInstanceId ||
            frame.runnerInstanceId !== request.runnerInstanceId
          ) {
            throw projectRunnerProtocolFault(
              "the Project Runner reply escaped its private binding",
            );
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
          if (frame.kind === "BeginAction" || frame.kind === "CommitActionResult") {
            if (
              !("runId" in frame) ||
              frame.runId !== authority.runId ||
              frame.revisionId !== authority.revisionId ||
              frame.claimGeneration !== authority.generation
            ) {
              throw new Error("the external action mutation escaped current Run authority");
            }
            const action = frame.body as unknown as Record<string, unknown>;
            if (frame.kind === "BeginAction") {
              const decision = await Effect.runPromise(
                this.#actions.begin({
                  authority,
                  actionId: String(action.actionId),
                  phasePath: String(action.phasePath),
                  attempt: Number(action.attempt),
                  inputHash: String(action.inputHash),
                  recoveryPolicy: action.recoveryPolicy as
                    | "recover-result"
                    | "prove-not-performed"
                    | "safe-repetition"
                    | "unresolved",
                  intendedAt: String(action.intendedAt),
                }),
              );
              await replyMutation(
                frame,
                decision.kind === "reuse-result"
                  ? {
                      kind: decision.kind,
                      actionId: decision.action.actionId,
                      result: decision.result,
                    }
                  : { kind: decision.kind, actionId: decision.action.actionId },
              );
            } else {
              const phase = {
                phasePath: String(action.phasePath),
                attempt: Number(action.attempt),
                kind: action.kind as "actor" | "code" | "agent",
                outcome: action.outcome as "succeeded" | "failed" | "interrupted",
                description: String(action.description),
                startedAt: String(action.startedAt),
                endedAt: String(action.endedAt),
                encodedResult: action.encodedResult as JsonValue,
              };
              if (typeof action.actionId === "string") {
                await Effect.runPromise(
                  this.#actions.confirmResult(
                    authority,
                    action.actionId,
                    phase,
                    "The current fenced Project Runner returned the encoded original-contract result.",
                    String(action.endedAt),
                  ),
                );
              } else {
                await Effect.runPromise(this.#runs.completePhase(authority, phase));
              }
              await replyMutation(frame, {
                state: "result-confirmed",
                actionId: String(action.actionId),
              });
            }
            continue;
          }
          if (frame.kind === "WriteTrace") {
            if (
              !("runId" in frame) ||
              frame.runId !== authority.runId ||
              frame.revisionId !== authority.revisionId ||
              frame.claimGeneration !== authority.generation
            ) {
              throw new Error("the Trace mutation escaped current Run authority");
            }
            const mutation = decodeTraceMutation(frame.body);
            if (!mutation.ok) {
              throw new Error(
                `the Trace mutation is invalid: ${mutation.issues
                  .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
                  .join("; ")}`,
              );
            }
            await Effect.runPromise(this.#trace.write(authority, mutation.value));
            await replyMutation(frame, { state: "committed" });
            continue;
          }
          if (
            frame.kind === "BeginResourceAcquisition" ||
            frame.kind === "ConfirmResourceAcquired" ||
            frame.kind === "BeginResourceRelease" ||
            frame.kind === "ConfirmResourceReleased" ||
            frame.kind === "PreserveResource" ||
            frame.kind === "ReportRecovery"
          ) {
            if (
              !("runId" in frame) ||
              frame.runId !== authority.runId ||
              frame.revisionId !== authority.revisionId ||
              frame.claimGeneration !== authority.generation
            ) {
              throw new Error("the Resource mutation escaped current Run authority");
            }
            const resourceAuthority = {
              projectId: request.projectId,
              runId: authority.runId,
              revisionId: authority.revisionId,
              runnerInstanceId: authority.runnerInstanceId,
              claimGeneration: authority.generation,
            };
            const resource = frame.body as unknown as Record<string, unknown>;
            const leaseId = String(resource.leaseId ?? "");
            const injectedFault = this.#resourceMutationFault?.({
              kind: frame.kind,
              runId: authority.runId,
              leaseId,
            });
            if (injectedFault === "before-commit") {
              throw new Error("the test transport dropped the Resource mutation before commit");
            }
            if (frame.kind === "BeginResourceAcquisition") {
              const acquisitionKey = String(resource.acquisitionKey);
              const prior = await Effect.runPromise(
                this.#resources.inspectAcquisition(
                  request.projectId,
                  authority.runId,
                  acquisitionKey,
                ),
              );
              const providerIdentity =
                prior?.providerIdentity ?? `kojo-resource:${crypto.randomUUID()}`;
              const inspectionRoot = join(this.#dataRoot, "resource-inspections");
              mkdirSync(inspectionRoot, { recursive: true, mode: 0o700 });
              const inspectionLocator =
                prior?.inspectionLocator ??
                join(inspectionRoot, `${providerIdentity.slice("kojo-resource:".length)}.json`);
              const providerLocator =
                prior?.providerLocator ??
                (resource.kind === "worktree"
                  ? join(
                      this.#dataRoot,
                      "worktrees",
                      providerIdentity.slice("kojo-resource:".length),
                      ".sandcastle",
                      "worktrees",
                      String((resource.detail as Record<string, unknown>).branch).replaceAll(
                        "/",
                        "-",
                      ),
                    )
                  : undefined);
              const lease = await Effect.runPromise(
                this.#resources.beginAcquisition(
                  {
                    ...resourceAuthority,
                    leaseId,
                    kind: resource.kind as "agent" | "sandbox" | "worktree",
                    acquisitionKey,
                    requestedAt: String(resource.requestedAt),
                    detail: resource.detail as Readonly<Record<string, string>>,
                  },
                  {
                    providerIdentity,
                    inspectionLocator,
                    ...(providerLocator === undefined ? {} : { providerLocator }),
                  },
                ),
              );
              const inspected = await Effect.runPromise(
                this.#resources.inspectAcquisition(
                  request.projectId,
                  authority.runId,
                  acquisitionKey,
                ),
              );
              if (
                inspected?.leaseId !== leaseId ||
                inspected.providerIdentity !== lease.providerIdentity
              ) {
                throw new Error(
                  "the exact Resource acquisition could not be inspected after commit",
                );
              }
              if (injectedFault === "after-commit") {
                continue;
              }
              await replyMutation(frame, {
                state: "committed",
                acquisitionKey: inspected.acquisitionKey,
                providerIdentity: inspected.providerIdentity,
                inspectionLocator: inspected.inspectionLocator,
                ...(inspected.providerLocator === undefined
                  ? {}
                  : { providerLocator: inspected.providerLocator }),
              });
              continue;
            } else if (frame.kind === "ConfirmResourceAcquired") {
              await Effect.runPromise(
                this.#resources.confirmAcquired(
                  resourceAuthority,
                  leaseId,
                  String(resource.acquiredAt),
                  {
                    providerIdentity: String(resource.providerIdentity),
                    locator: String(resource.locator),
                  },
                ),
              );
            } else if (frame.kind === "BeginResourceRelease") {
              await Effect.runPromise(
                this.#resources.beginRelease(
                  resourceAuthority,
                  leaseId,
                  String(resource.requestedAt),
                ),
              );
            } else if (frame.kind === "ConfirmResourceReleased") {
              await Effect.runPromise(
                this.#resources.confirmReleased(
                  resourceAuthority,
                  leaseId,
                  String(resource.releasedAt),
                  String(resource.evidence),
                ),
              );
            } else if (frame.kind === "PreserveResource") {
              await Effect.runPromise(
                this.#resources.preserve(
                  resourceAuthority,
                  leaseId,
                  String(resource.observedAt),
                  String(resource.reason),
                ),
              );
            } else if (resource.outcome === "released") {
              await Effect.runPromise(
                this.#resources.confirmReleased(
                  resourceAuthority,
                  leaseId,
                  String(resource.observedAt),
                  String(resource.reason),
                ),
              );
            } else if (resource.outcome === "preserved") {
              await Effect.runPromise(
                this.#resources.preserve(
                  resourceAuthority,
                  leaseId,
                  String(resource.observedAt),
                  String(resource.reason),
                ),
              );
            } else {
              await Effect.runPromise(
                this.#resources.unresolved(
                  resourceAuthority,
                  leaseId,
                  String(resource.observedAt),
                  String(resource.reason),
                ),
              );
            }
            if (injectedFault === "after-commit") {
              continue;
            }
            await replyMutation(frame, { state: "committed" });
            continue;
          }
          if (
            frame.kind === "BeginArtifact" ||
            frame.kind === "WriteArtifactChunk" ||
            frame.kind === "FinishArtifact"
          ) {
            if (
              !("runId" in frame) ||
              frame.runId !== authority.runId ||
              frame.revisionId !== authority.revisionId ||
              frame.claimGeneration !== authority.generation
            ) {
              throw new Error("the Artifact mutation escaped current Run authority");
            }
            const artifact = frame.body as unknown as Record<string, unknown>;
            const transferId = String(artifact.transferId ?? "");
            if (frame.kind === "BeginArtifact") {
              this.#artifacts.begin({
                transferId,
                runId: authority.runId,
                name: String(artifact.name),
                mediaType: String(artifact.mediaType),
                totalSize: Number(artifact.totalSize),
                sha256: String(artifact.sha256),
              });
              await replyMutation(frame, { transferId });
            } else if (frame.kind === "WriteArtifactChunk") {
              this.#artifacts.write(
                transferId,
                Number(artifact.ordinal),
                Uint8Array.fromBase64(String(artifact.data)),
                {
                  totalSize: Number(artifact.totalSize),
                  sha256: String(artifact.sha256),
                },
              );
              await replyMutation(frame, { transferId, written: true });
            } else {
              const published = this.#artifacts.finish(
                transferId,
                new Date(this.#now()).toISOString(),
              );
              await replyMutation(frame, { artifactId: published.artifactId });
            }
            continue;
          }
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
            if (selected === undefined) {
              throw projectRunnerProtocolFault(
                "the Project Runner stop reply has no pending command",
              );
            }
            stoppedRequestId = body.operationRequestId;
            if (selected !== undefined) {
              pending.delete(body.operationRequestId as string);
              selected.resolve({ stopped: true });
            }
            return;
          }
          throw projectRunnerProtocolFault(`the Project Runner sent unexpected ${frame.kind}`);
        }
      })().catch((cause) => {
        for (const selected of pending.values()) selected.reject(cause);
        pending.clear();
      });
      const command = async (
        kind: "Health" | "ExecuteRun" | "CancelRun" | "Shutdown",
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
              ...(kind === "Shutdown" || kind === "Health"
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
      let healthPending = false;
      let lastHealthyAt = this.#now();
      healthTimer = setInterval(() => {
        if (healthPending) {
          if (this.#now() - lastHealthyAt >= settings.unhealthyMs) socket?.destroy();
          return;
        }
        healthPending = true;
        void command("Health", null).then(
          () => {
            lastHealthyAt = this.#now();
            healthPending = false;
            void Effect.runPromise(
              this.#projectRecovery.observeHealthy(
                request.projectId,
                new Date(lastHealthyAt).toISOString(),
                false,
              ),
            ).catch(() => undefined);
          },
          () => {
            healthPending = false;
            if (this.#now() - lastHealthyAt >= settings.unhealthyMs) socket?.destroy();
          },
        );
      }, settings.heartbeatMs);
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
            timer = setTimeout(() => void stop().catch(() => undefined), settings.idleMs);
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
        await control.cancelAndStop(this.#runnerSettings().cleanupMs);
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
    } catch (cause) {
      if (
        cause instanceof RunnerChannelError ||
        cause instanceof ProjectRunnerProtocolFault ||
        (cause instanceof Error &&
          (cause.message.includes("Project Runner exited") ||
            cause.message.includes("private binding timed out")))
      ) {
        throw new ProjectRunnerConnectionLost({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }
      throw cause;
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
  };
}
