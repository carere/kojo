import { Effect, Layer } from "effect";
import {
  DEFAULT_RUNNER_HEALTHY_RESET_MILLIS,
  DEFAULT_RUNNER_REPLACEMENT_DELAYS_MILLIS,
  type ProjectRecovery,
} from "../models/ProjectRecovery.ts";
import { ProjectRecoveryStoreError } from "../models/ProjectRecoveryStoreError.ts";
import { ProjectRecoveryRepository } from "../ports/ProjectRecoveryRepository.ts";

export class InMemoryProjectRecoveryRepository {
  readonly #recoveries = new Map<string, ProjectRecovery>();
  readonly #delays: ReadonlyArray<number>;
  readonly #healthyResetMillis: number;

  constructor(
    options: {
      readonly replacementDelaysMillis?: ReadonlyArray<number>;
      readonly healthyResetMillis?: number;
    } = {},
  ) {
    this.#delays = options.replacementDelaysMillis ?? DEFAULT_RUNNER_REPLACEMENT_DELAYS_MILLIS;
    this.#healthyResetMillis = options.healthyResetMillis ?? DEFAULT_RUNNER_HEALTHY_RESET_MILLIS;
  }

  readonly layer = Layer.succeed(ProjectRecoveryRepository, {
    read: (projectId) => Effect.sync(() => this.#recoveries.get(projectId)),
    recordFailure: (failure) =>
      Effect.sync(() => {
        const prior = this.#recoveries.get(failure.projectId);
        const attempts = (prior?.attempts ?? 0) + 1;
        const exhausted = attempts > this.#delays.length;
        const delay = this.#delays[Math.min(attempts, this.#delays.length) - 1] ?? 0;
        const recovery: ProjectRecovery = {
          projectId: failure.projectId,
          cycle: prior?.cycle ?? 1,
          attempts: Math.min(attempts, this.#delays.length),
          state: exhausted ? "held" : "recovering",
          safety: "pending",
          failedOperationPending:
            failure.operationFailed || (prior?.failedOperationPending ?? false),
          nextAttemptAt: new Date(Date.parse(failure.failedAt) + delay).toISOString(),
          priorRunnerInstanceId: failure.runnerInstanceId,
          lastFault: failure.fault,
        };
        this.#recoveries.set(failure.projectId, recovery);
        return recovery;
      }),
    confirmSafety: (projectId, runnerInstanceId) =>
      this.#update(projectId, (prior) => {
        if (prior.priorRunnerInstanceId !== runnerInstanceId) {
          throw new ProjectRecoveryStoreError({
            message: "termination evidence does not name the failed Project Runner instance",
          });
        }
        return { ...prior, safety: "safe" };
      }),
    holdUncertain: (projectId, runnerInstanceId, detail) =>
      this.#update(projectId, (prior) => {
        if (prior.priorRunnerInstanceId !== runnerInstanceId) {
          throw new ProjectRecoveryStoreError({
            message: "uncertain termination does not name the failed Project Runner instance",
          });
        }
        return { ...prior, state: "held", safety: "uncertain", lastFault: detail };
      }),
    observeHealthy: (projectId, observedAt, operationSucceeded) =>
      this.#update(projectId, (prior) => {
        if (prior.state === "held" || prior.safety !== "safe") return prior;
        const healthySince = prior.healthySince ?? observedAt;
        const operationPending = operationSucceeded ? false : prior.failedOperationPending;
        if (
          Date.parse(observedAt) - Date.parse(healthySince) >= this.#healthyResetMillis &&
          !operationPending
        ) {
          return {
            projectId,
            cycle: prior.cycle,
            attempts: 0,
            state: "healthy",
            safety: "safe",
            failedOperationPending: false,
            healthySince: observedAt,
          };
        }
        return { ...prior, healthySince, failedOperationPending: operationPending };
      }),
    repair: (projectId) =>
      Effect.sync(() => {
        const prior = this.#recoveries.get(projectId);
        if (prior === undefined) {
          return {
            projectId,
            cycle: 1,
            attempts: 0,
            state: "healthy",
            safety: "safe",
            failedOperationPending: false,
          };
        }
        const recovery: ProjectRecovery = {
          projectId,
          cycle: prior.cycle + 1,
          attempts: 0,
          state: "recovering",
          safety: prior.safety === "uncertain" ? "pending" : prior.safety,
          failedOperationPending: prior.failedOperationPending,
          ...(prior.priorRunnerInstanceId === undefined
            ? {}
            : { priorRunnerInstanceId: prior.priorRunnerInstanceId }),
          ...(prior.lastFault === undefined ? {} : { lastFault: prior.lastFault }),
        };
        this.#recoveries.set(projectId, recovery);
        return recovery;
      }),
  });

  #update(
    projectId: string,
    update: (prior: ProjectRecovery) => ProjectRecovery,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> {
    return Effect.try({
      try: () => {
        const prior = this.#recoveries.get(projectId);
        if (prior === undefined)
          throw new ProjectRecoveryStoreError({ message: "Project recovery was not started" });
        const recovery = update(prior);
        this.#recoveries.set(projectId, recovery);
        return recovery;
      },
      catch: (cause) =>
        cause instanceof ProjectRecoveryStoreError
          ? cause
          : new ProjectRecoveryStoreError({ message: String(cause), cause }),
    });
  }
}
