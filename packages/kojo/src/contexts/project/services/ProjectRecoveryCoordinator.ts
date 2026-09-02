import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Cause, Duration, Effect, Exit, Option } from "effect";
import type {
  ReservedRun,
  RunAuthority,
  RunExecutionFault,
} from "../../workflow/models/DaemonRun.ts";
import type { ExternalActionRepository } from "../../workflow/ports/ExternalActionRepository.ts";
import type { RunRepository } from "../../workflow/ports/RunRepository.ts";
import type { ProjectRecovery } from "../models/ProjectRecovery.ts";
import type { ProjectRecoveryRepository } from "../ports/ProjectRecoveryRepository.ts";
import type { ResourceLeaseRepository } from "../ports/ResourceLeaseRepository.ts";
import type { ProjectRunnerSupervisor } from "./ProjectRunnerSupervisor.ts";
import {
  RESOURCE_RECOVERY_LIMIT,
  terminatedResourceObservations,
} from "./reconcileTerminatedResources.ts";

/** Owns persisted Project Runner recovery, safety reconciliation, delay, and repair. */
export class ProjectRecoveryCoordinator {
  readonly #now: () => number;
  readonly #recovery: ProjectRecoveryRepository["Service"];
  readonly #resources: ResourceLeaseRepository["Service"];
  readonly #actions: ExternalActionRepository["Service"];
  readonly #runs: RunRepository["Service"];
  readonly #runnerSupervisor: ProjectRunnerSupervisor;
  readonly #resourceRecoveryBoundary?: (() => Effect.Effect<void>) | undefined;
  readonly #shutdownSignal: AbortSignal;
  readonly #isStopping: () => boolean;
  readonly #onRecoveryReady: (projectId: string) => Promise<void>;
  readonly #waits = new Set<{
    readonly timer: ReturnType<typeof setTimeout>;
    readonly resolve: (continueRecovery: boolean) => void;
  }>();

  constructor(options: {
    readonly now: () => number;
    readonly recovery: ProjectRecoveryRepository["Service"];
    readonly resources: ResourceLeaseRepository["Service"];
    readonly actions: ExternalActionRepository["Service"];
    readonly runs: RunRepository["Service"];
    readonly runnerSupervisor: ProjectRunnerSupervisor;
    readonly resourceRecoveryBoundary?: (() => Effect.Effect<void>) | undefined;
    readonly shutdownSignal: AbortSignal;
    readonly isStopping: () => boolean;
    readonly onRecoveryReady: (projectId: string) => Promise<void>;
  }) {
    this.#now = options.now;
    this.#recovery = options.recovery;
    this.#resources = options.resources;
    this.#actions = options.actions;
    this.#runs = options.runs;
    this.#runnerSupervisor = options.runnerSupervisor;
    this.#resourceRecoveryBoundary = options.resourceRecoveryBoundary;
    this.#shutdownSignal = options.shutdownSignal;
    this.#isStopping = options.isStopping;
    this.#onRecoveryReady = options.onRecoveryReady;
  }

  readonly read = (projectId: string) => this.#recovery.read(projectId);

  readonly fault = (recovery: ProjectRecovery): Omit<RunExecutionFault, "scope"> => ({
    code: "PROJECT_RECOVERY_REQUIRED",
    detail: recovery.lastFault ?? "Project Runner recovery needs explicit repair",
    remedy: `Run \`kojo project repair ${recovery.projectId}\` after Project safety can be established.`,
    retry: "after-repair",
  });

  async reconcileTerminatedResources(
    projectId: string,
    priorRunnerInstanceId: string,
    terminationConfirmedAt: string,
  ): Promise<boolean> {
    const authority = { projectId, priorRunnerInstanceId, terminationConfirmedAt };
    const pending = await Effect.runPromise(
      this.#resources.pendingForTerminatedRunner(authority, RESOURCE_RECOVERY_LIMIT),
    );
    const observations = terminatedResourceObservations(
      pending,
      (lease) => {
        try {
          const record = JSON.parse(readFileSync(lease.inspectionLocator, "utf8")) as Record<
            string,
            unknown
          >;
          if (
            record.registryVersion !== 1 ||
            record.acquisitionKey !== lease.acquisitionKey ||
            record.providerIdentity !== lease.providerIdentity ||
            record.kind !== lease.kind ||
            (record.state !== "creating" &&
              record.state !== "acquired" &&
              record.state !== "release-intent" &&
              record.state !== "released")
          ) {
            return undefined;
          }
          return {
            state: record.state,
            ...(typeof record.locator === "string" ? { locator: record.locator } : {}),
          };
        } catch {
          return undefined;
        }
      },
      (locator) => {
        if (!existsSync(locator)) return "absent";
        const status = spawnSync("git", ["status", "--porcelain"], {
          cwd: locator,
          encoding: "utf8",
          env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(locator) },
        });
        if (status.status !== 0) return "unreadable";
        return status.stdout.trim() === "" ? "clean" : "dirty";
      },
    );
    const reconciled = await Effect.runPromise(
      this.#resources.reconcileTerminatedRunner(authority, observations),
    );
    return reconciled.every((lease) => lease.state === "released");
  }

  wait(nextAttemptAt?: string): Promise<boolean> {
    const delay = Math.max(
      0,
      Date.parse(nextAttemptAt ?? new Date(this.#now()).toISOString()) - this.#now(),
    );
    if (delay === 0) return Promise.resolve(!this.#isStopping());
    return new Promise((resolve) => {
      let wait: {
        readonly timer: ReturnType<typeof setTimeout>;
        readonly resolve: (continueRecovery: boolean) => void;
      };
      const complete = (continueRecovery: boolean): void => {
        this.#waits.delete(wait);
        resolve(continueRecovery);
      };
      wait = { timer: setTimeout(() => complete(!this.#isStopping()), delay), resolve: complete };
      this.#waits.add(wait);
    });
  }

  shutdown(): void {
    for (const wait of [...this.#waits]) {
      clearTimeout(wait.timer);
      this.#waits.delete(wait);
      wait.resolve(false);
    }
  }

  async runResourceBoundary(timeoutMillis: number): Promise<void> {
    if (this.#resourceRecoveryBoundary === undefined) return;
    const exit = await Effect.runPromiseExit(
      this.#resourceRecoveryBoundary().pipe(Effect.timeoutOption(Duration.millis(timeoutMillis))),
      { signal: this.#shutdownSignal },
    );
    if (Exit.isFailure(exit)) {
      if (this.#shutdownSignal.aborted && Cause.hasInterruptsOnly(exit.cause)) return;
      throw Cause.squash(exit.cause);
    }
    if (Option.isNone(exit.value)) {
      throw new Error(`Project Runner recovery check exceeded ${timeoutMillis} milliseconds`);
    }
  }

  async recoverRunnerLoss(options: {
    readonly run: ReservedRun["run"];
    readonly authority: RunAuthority;
    readonly cause: unknown;
    readonly recoveryCheckMs: number;
  }): Promise<void> {
    const failedAt = new Date(this.#now()).toISOString();
    const uncertainActions = await Effect.runPromise(
      this.#actions.holdOpen(
        options.run.runId,
        "The external process ended without a committed action result. Missing output, process replacement, timeout, and Trace absence do not prove that the action did not occur.",
        failedAt,
      ),
    ).catch(() => []);
    let recovery = await Effect.runPromise(
      this.#recovery.recordFailure({
        projectId: options.run.projectId,
        runnerInstanceId: options.authority.runnerInstanceId,
        failedAt,
        fault: options.cause instanceof Error ? options.cause.message : String(options.cause),
        operationFailed: true,
      }),
    );
    try {
      await Effect.runPromise(this.#runnerSupervisor.stop(options.run.projectId));
      const confirmedAt = new Date(this.#now()).toISOString();
      await Effect.runPromise(
        this.#recovery.confirmTermination(
          options.run.projectId,
          options.authority.runnerInstanceId,
          confirmedAt,
        ),
      );
      await this.runResourceBoundary(options.recoveryCheckMs);
      await Effect.runPromise(
        this.#resources.confirmRunnerTermination({
          projectId: options.run.projectId,
          priorRunnerInstanceId: options.authority.runnerInstanceId,
          terminationConfirmedAt: confirmedAt,
        }),
      );
      const safe = await this.reconcileTerminatedResources(
        options.run.projectId,
        options.authority.runnerInstanceId,
        confirmedAt,
      );
      recovery = safe
        ? await Effect.runPromise(
            this.#recovery.confirmSafety(
              options.run.projectId,
              options.authority.runnerInstanceId,
              confirmedAt,
            ),
          )
        : await Effect.runPromise(
            this.#recovery.holdUncertain(
              options.run.projectId,
              options.authority.runnerInstanceId,
              "The old Runner stopped, but provider cleanup is preserved or unresolved.",
            ),
          );
    } catch (cause) {
      recovery = await Effect.runPromise(
        this.#recovery.holdUncertain(
          options.run.projectId,
          options.authority.runnerInstanceId,
          `Project Runner termination is not confirmed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
    if (recovery.state === "held" || recovery.safety !== "safe") {
      await Effect.runPromise(
        this.#runs.holdProjectRunnerAfterRestart(
          options.run.projectId,
          this.fault(recovery),
          new Date(this.#now()).toISOString(),
        ),
      );
      return;
    }
    if (!(await this.wait(recovery.nextAttemptAt))) return;
    if (uncertainActions.length === 0) {
      await Effect.runPromise(
        this.#runs.recoverProjectRunnerFailure(
          options.authority,
          new Date(this.#now()).toISOString(),
          "The Project Runner connection was lost. The same Run will recover under a new fenced Claim.",
        ),
      );
      return;
    }
    await Effect.runPromise(
      this.#actions.settleAfterRunnerTermination(
        options.authority,
        new Date(this.#now()).toISOString(),
      ),
    );
  }

  async restore(): Promise<ReadonlyArray<ProjectRecovery>> {
    const restoredAt = new Date(this.#now()).toISOString();
    const recoveries = await Effect.runPromise(this.#recovery.recoveries);
    const deferredProjects = new Set(
      recoveries
        .filter((recovery) => recovery.state !== "healthy")
        .map((recovery) => recovery.projectId),
    );
    await Effect.runPromise(this.#runs.recoverInterruptedExecutions(restoredAt, deferredProjects));
    for (const recovery of recoveries) {
      if (recovery.state === "healthy") continue;
      if (recovery.state === "recovering" && recovery.safety === "safe") {
        void this.#resumePersisted(recovery).catch(() => undefined);
        continue;
      }
      let held = recovery;
      if (recovery.safety === "pending" && recovery.priorRunnerInstanceId !== undefined) {
        if (recovery.terminationConfirmedAt === undefined) {
          held = await Effect.runPromise(
            this.#recovery.holdUncertain(
              recovery.projectId,
              recovery.priorRunnerInstanceId,
              "The Daemon restarted before it confirmed the old Project Runner process group stopped.",
            ),
          );
        } else {
          try {
            await Effect.runPromise(
              this.#resources.confirmRunnerTermination({
                projectId: recovery.projectId,
                priorRunnerInstanceId: recovery.priorRunnerInstanceId,
                terminationConfirmedAt: recovery.terminationConfirmedAt,
              }),
            );
            const safe = await this.reconcileTerminatedResources(
              recovery.projectId,
              recovery.priorRunnerInstanceId,
              recovery.terminationConfirmedAt,
            );
            held = safe
              ? await Effect.runPromise(
                  this.#recovery.confirmSafety(
                    recovery.projectId,
                    recovery.priorRunnerInstanceId,
                    recovery.terminationConfirmedAt,
                  ),
                )
              : await Effect.runPromise(
                  this.#recovery.holdUncertain(
                    recovery.projectId,
                    recovery.priorRunnerInstanceId,
                    "The old Runner stopped, but provider cleanup is preserved or unresolved.",
                  ),
                );
          } catch (cause) {
            held = await Effect.runPromise(
              this.#recovery.holdUncertain(
                recovery.projectId,
                recovery.priorRunnerInstanceId,
                `Resource recovery could not complete its bounded inspection: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            );
          }
          if (held.safety === "safe") {
            void this.#resumePersisted(held).catch(() => undefined);
            continue;
          }
        }
      }
      await Effect.runPromise(
        this.#runs.holdProjectRunnerAfterRestart(held.projectId, this.fault(held), restoredAt),
      );
    }
    return recoveries;
  }

  async repair(projectId: string): Promise<ProjectRecovery> {
    const requestedAt = new Date(this.#now()).toISOString();
    const recovery = await Effect.runPromise(this.#recovery.repair(projectId, requestedAt));
    if (recovery.state === "recovering" && recovery.safety === "safe") {
      await Effect.runPromise(this.#runs.repairProjectRecoveryHolds(projectId, requestedAt));
      await this.#onRecoveryReady(projectId);
    }
    return recovery;
  }

  async #resumePersisted(recovery: ProjectRecovery): Promise<void> {
    if (!(await this.wait(recovery.nextAttemptAt))) return;
    if (recovery.priorRunnerInstanceId !== undefined) {
      const waiting = await Effect.runPromise(
        this.#actions.awaitingRunnerTermination(recovery.projectId, recovery.priorRunnerInstanceId),
      );
      for (const authority of waiting) {
        await Effect.runPromise(
          this.#actions.settleAfterRunnerTermination(
            authority,
            new Date(this.#now()).toISOString(),
          ),
        );
      }
    }
    await Effect.runPromise(
      this.#runs.recoverProjectRunnerAfterRestart(
        recovery.projectId,
        new Date(this.#now()).toISOString(),
      ),
    );
    await this.#onRecoveryReady(recovery.projectId);
  }
}
