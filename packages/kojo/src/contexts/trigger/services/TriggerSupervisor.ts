import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  decodeJsonValue,
  type JsonValue,
} from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { OperationReplyBody } from "@carere/kojo-runner-contracts/contexts/project/contracts/execution";
import type { RunnerFrame } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import { Cause, Duration, Effect, Exit, Option } from "effect";
import type {
  DaemonProjectRepository,
  ExecutionRevision,
} from "../../project/ports/DaemonProjectRepository.ts";
import type { ProjectRecoveryRepository } from "../../project/ports/ProjectRecoveryRepository.ts";
import type { ResourceLeaseRepository } from "../../project/ports/ResourceLeaseRepository.ts";
import {
  type MaterializedRevision,
  materializeRevision,
} from "../../project/services/materializeRevision.ts";
import {
  ProjectRunnerError,
  type ProjectRunnerSupervisor,
} from "../../project/services/ProjectRunnerSupervisor.ts";
import { makeRunnerFrameReader, writeRunnerFrame } from "../../project/services/runnerChannel.ts";
import type { TriggerRepository } from "../../trigger/ports/TriggerRepository.ts";
import type { RevisionRepository } from "../../workflow/ports/RevisionRepository.ts";

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

interface TriggerRunnerSettings {
  readonly handshakeMs: number;
  readonly heartbeatMs: number;
  readonly unhealthyMs: number;
  readonly cleanupMs: number;
  readonly recoveryCheckMs: number;
}

/** Owns Trigger Runner groups, polling lifecycle, transport, and bounded recovery. */
export class TriggerSupervisor {
  readonly #dataRoot: string;
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #projects: DaemonProjectRepository;
  readonly #projectRecovery: ProjectRecoveryRepository["Service"];
  readonly #resources: ResourceLeaseRepository["Service"];
  readonly #revisions: RevisionRepository["Service"];
  readonly #triggers: TriggerRepository["Service"];
  readonly #runnerSupervisor: ProjectRunnerSupervisor;
  readonly #runnerSettings: () => TriggerRunnerSettings;
  readonly #resourceRecoveryBoundary?: (() => Effect.Effect<void>) | undefined;
  readonly #reconcileTerminatedResources: (
    projectId: string,
    runnerInstanceId: string,
    terminationConfirmedAt: string,
  ) => Promise<boolean>;
  readonly #waitForRecovery: (nextAttemptAt?: string) => Promise<boolean>;
  readonly #daemonDispatchHeld: () => boolean;
  readonly #isStopping: () => boolean;
  readonly #pumpRuns: () => void;
  readonly #shutdownSignal: AbortSignal;
  readonly #triggerProcesses = new Map<string, { readonly stop: () => Promise<void> }>();
  readonly #triggerGroups = new Map<string, ProjectTriggerGroup>();

  constructor(options: {
    readonly dataRoot: string;
    readonly instanceId: string;
    readonly now: () => number;
    readonly projects: DaemonProjectRepository;
    readonly projectRecovery: ProjectRecoveryRepository["Service"];
    readonly resources: ResourceLeaseRepository["Service"];
    readonly revisions: RevisionRepository["Service"];
    readonly triggers: TriggerRepository["Service"];
    readonly runnerSupervisor: ProjectRunnerSupervisor;
    readonly runnerSettings: () => TriggerRunnerSettings;
    readonly resourceRecoveryBoundary?: (() => Effect.Effect<void>) | undefined;
    readonly reconcileTerminatedResources: (
      projectId: string,
      runnerInstanceId: string,
      terminationConfirmedAt: string,
    ) => Promise<boolean>;
    readonly waitForRecovery: (nextAttemptAt?: string) => Promise<boolean>;
    readonly daemonDispatchHeld: () => boolean;
    readonly isStopping: () => boolean;
    readonly pumpRuns: () => void;
    readonly shutdownSignal: AbortSignal;
  }) {
    this.#dataRoot = options.dataRoot;
    this.#instanceId = options.instanceId;
    this.#now = options.now;
    this.#projects = options.projects;
    this.#projectRecovery = options.projectRecovery;
    this.#resources = options.resources;
    this.#revisions = options.revisions;
    this.#triggers = options.triggers;
    this.#runnerSupervisor = options.runnerSupervisor;
    this.#runnerSettings = options.runnerSettings;
    this.#resourceRecoveryBoundary = options.resourceRecoveryBoundary;
    this.#reconcileTerminatedResources = options.reconcileTerminatedResources;
    this.#waitForRecovery = options.waitForRecovery;
    this.#daemonDispatchHeld = options.daemonDispatchHeld;
    this.#isStopping = options.isStopping;
    this.#pumpRuns = options.pumpRuns;
    this.#shutdownSignal = options.shutdownSignal;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.#triggerProcesses.values(), (process) => process.stop()),
    );
  }
  #pollerKey(projectId: string, workflowName: string): string {
    return JSON.stringify([projectId, workflowName]);
  }

  async stopPoller(projectId: string, workflowName: string): Promise<void> {
    const process = this.#triggerProcesses.get(this.#pollerKey(projectId, workflowName));
    if (process !== undefined) await process.stop();
  }

  async stopProject(projectId: string, detail: string): Promise<void> {
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
      await this.stopPoller(poller.projectId, poller.workflowName);
    }
  }

  async restoreProject(projectId: string): Promise<void> {
    const pollers = (await Effect.runPromise(this.#projects.triggerPollers)).filter(
      (poller) => poller.projectId === projectId,
    );
    for (const poller of pollers) {
      await this.ensure(poller.projectId, poller.workflowName, poller.pollerId).catch(
        () => undefined,
      );
    }
  }

  async #recoverFailedTriggerRunner(options: {
    readonly projectId: string;
    readonly runnerInstanceId: string;
    readonly pollers: ReadonlyArray<{
      readonly projectId: string;
      readonly workflowName: string;
      readonly pollerId: string;
    }>;
    readonly stop: () => Promise<void>;
    readonly cause: unknown;
    readonly recoveryCheckMs: number;
  }): Promise<void> {
    const failedAt = new Date(this.#now()).toISOString();
    let recovery = await Effect.runPromise(
      this.#projectRecovery.recordFailure({
        projectId: options.projectId,
        runnerInstanceId: options.runnerInstanceId,
        failedAt,
        fault: options.cause instanceof Error ? options.cause.message : String(options.cause),
        operationFailed: true,
      }),
    );
    try {
      await options.stop();
      const confirmedAt = new Date(this.#now()).toISOString();
      await Effect.runPromise(
        this.#projectRecovery.confirmTermination(
          options.projectId,
          options.runnerInstanceId,
          confirmedAt,
        ),
      );
      await this.#runResourceRecoveryBoundary(options.recoveryCheckMs);
      await Effect.runPromise(
        this.#resources.confirmRunnerTermination({
          projectId: options.projectId,
          priorRunnerInstanceId: options.runnerInstanceId,
          terminationConfirmedAt: confirmedAt,
        }),
      );
      const resourcesSafe = await this.#reconcileTerminatedResources(
        options.projectId,
        options.runnerInstanceId,
        confirmedAt,
      );
      recovery = resourcesSafe
        ? await Effect.runPromise(
            this.#projectRecovery.confirmSafety(
              options.projectId,
              options.runnerInstanceId,
              confirmedAt,
            ),
          )
        : await Effect.runPromise(
            this.#projectRecovery.holdUncertain(
              options.projectId,
              options.runnerInstanceId,
              "The old Runner stopped, but provider cleanup is preserved or unresolved.",
            ),
          );
    } catch (terminationCause) {
      recovery = await Effect.runPromise(
        this.#projectRecovery.holdUncertain(
          options.projectId,
          options.runnerInstanceId,
          `Project Runner termination is not confirmed: ${terminationCause instanceof Error ? terminationCause.message : String(terminationCause)}`,
        ),
      );
    }
    if (recovery.state === "held" || recovery.safety !== "safe" || this.#isStopping()) return;
    if (!(await this.#waitForRecovery(recovery.nextAttemptAt))) return;
    for (const poller of options.pollers) {
      await this.ensure(poller.projectId, poller.workflowName, poller.pollerId).catch(
        () => undefined,
      );
    }
  }

  async ensure(projectId: string, workflowName: string, pollerId: string): Promise<void> {
    const project = (await Effect.runPromise(this.#projects.projects)).find(
      (candidate) => candidate.projectId === projectId,
    );
    if (
      this.#daemonDispatchHeld() ||
      project === undefined ||
      project.projectState !== "available" ||
      !project.locationActive ||
      !project.locationConfirmed ||
      project.locationChange.state === "draining"
    ) {
      return;
    }
    const key = this.#pollerKey(projectId, workflowName);
    if (this.#triggerProcesses.has(key)) return;
    const recovery = await Effect.runPromise(this.#projectRecovery.read(projectId));
    if (
      recovery !== undefined &&
      (recovery.state === "held" ||
        recovery.safety !== "safe" ||
        (recovery.nextAttemptAt !== undefined && Date.parse(recovery.nextAttemptAt) > this.#now()))
    ) {
      await Effect.runPromise(
        this.#projects.observeTrigger({
          projectId,
          workflowName,
          state: "delayed",
          detail: "Project Runner recovery must finish before Trigger polling can start",
          observedAt: new Date(this.#now()).toISOString(),
        }),
      );
      return;
    }
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

  async #runResourceRecoveryBoundary(timeoutMillis: number): Promise<void> {
    if (this.#resourceRecoveryBoundary === undefined) return;
    const exit = await Effect.runPromiseExit(
      this.#resourceRecoveryBoundary().pipe(Effect.timeoutOption(Duration.millis(timeoutMillis))),
      { signal: this.#shutdownSignal },
    );
    if (Exit.isFailure(exit)) {
      if (this.#shutdownSignal.aborted && Cause.hasInterruptsOnly(exit.cause)) return;
      throw Cause.squash(exit.cause);
    }
    const outcome = exit.value;
    if (Option.isNone(outcome)) {
      throw new Error(`Project Runner recovery check exceeded ${timeoutMillis} milliseconds`);
    }
  }

  async #createTriggerGroup(
    bootstrap: ExecutionRevision,
    bootstrapMaterialized: MaterializedRevision,
  ): Promise<ProjectTriggerGroup> {
    const settings = this.#runnerSettings();
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
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      socket?.destroy();
      server?.close();
      if (healthTimer !== undefined) clearInterval(healthTimer);
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
      kind:
        | "Health"
        | "RegisterRevision"
        | "DisposeRevision"
        | "StartTrigger"
        | "StopTrigger"
        | "Shutdown",
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
        if (state === "polling") void this.#pumpRuns();
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
          detached: true,
        },
      );
      const output = new Response(child.stdout as ReadableStream<Uint8Array>).text();
      const error = new Response(child.stderr as ReadableStream<Uint8Array>).text();
      const processGroupExists = (): boolean => {
        if (child === undefined) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
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
          if (!processGroupExists()) return;
          await Bun.sleep(10);
        }
        throw new Error("the owned Trigger Runner process group did not terminate");
      };
      socket = await Promise.race([
        accepted,
        child.exited.then((exit) =>
          Promise.reject(new Error(`Project Runner exited ${exit} before Trigger binding`)),
        ),
        Bun.sleep(settings.handshakeMs).then(() =>
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
            if (frame.kind === "Stopped") {
              const stopped = new Error(
                "the Project Runner stopped before all pending Trigger commands replied",
              );
              for (const command of pending.values()) command.reject(stopped);
              pending.clear();
              return;
            }
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
        if (stopping === undefined && !this.#isStopping()) {
          const failedPollers = Array.from(registrations.values(), (registered) => ({
            projectId: registered.revision.projectId,
            workflowName: registered.revision.workflowName,
            pollerId: registered.pollerId,
          }));
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
          if (stopGroup !== undefined) {
            void this.#recoverFailedTriggerRunner({
              projectId: bootstrap.projectId,
              runnerInstanceId,
              pollers: failedPollers,
              stop: stopGroup,
              cause,
              recoveryCheckMs: settings.recoveryCheckMs,
            }).catch(() => undefined);
          }
        }
        throw cause;
      });
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
                bootstrap.projectId,
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

      let group: ProjectTriggerGroup;
      const stop = (): Promise<void> => {
        stopping ??= (async () => {
          try {
            if (child !== undefined && child.exitCode === null) {
              const stopped = await Promise.race([
                command("Shutdown", null),
                Bun.sleep(settings.cleanupMs).then(() => undefined),
              ]).catch(() => undefined);
              if (stopped?.kind !== "Stopped") await forceProcessGroup();
            }
            await child?.exited;
            if (processGroupExists()) await forceProcessGroup();
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
}
