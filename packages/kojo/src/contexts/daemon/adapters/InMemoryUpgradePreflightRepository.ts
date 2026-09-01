import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  NoRollbackPlan,
  UpgradeCheckReport,
  UpgradeEvidence,
} from "../models/ManagedUpgrade.ts";
import type {
  IssueNoRollbackPlan,
  UpgradePreflightRepository,
} from "../ports/UpgradePreflightRepository.ts";

export class InMemoryUpgradePreflightRepository implements UpgradePreflightRepository {
  readonly #evidence: () => UpgradeEvidence;
  readonly #plans = new Map<string, { plan: NoRollbackPlan; token: string }>();
  #latest: UpgradeCheckReport | undefined;

  constructor(evidence: UpgradeEvidence | (() => UpgradeEvidence)) {
    this.#evidence = typeof evidence === "function" ? evidence : () => evidence;
  }

  readonly capture = (_observedAt: string) => Effect.sync(this.#evidence);

  readonly issueNoRollbackPlan = (request: IssueNoRollbackPlan) =>
    Effect.sync(() => {
      const approved = [...this.#plans.values()].find(
        (entry) =>
          entry.plan.dataIdentity === request.dataIdentity &&
          entry.plan.candidateReleaseId === request.candidateReleaseId &&
          entry.plan.expectedStateVersion === request.expectedStateVersion &&
          entry.plan.requestHash === request.requestHash &&
          JSON.stringify(entry.plan.affectedScope) === JSON.stringify(request.affectedScope) &&
          JSON.stringify(entry.plan.migration) === JSON.stringify(request.migration) &&
          entry.plan.approvedAt !== undefined,
      );
      if (approved !== undefined) return { plan: approved.plan };
      const planId = crypto.randomUUID();
      const token = `${planId}.test-secret`;
      const plan: NoRollbackPlan = {
        formatVersion: 1,
        planId,
        kind: "approve-no-rollback",
        dataIdentity: request.dataIdentity,
        candidateReleaseId: request.candidateReleaseId,
        requestHash: request.requestHash,
        affectedScope: request.affectedScope,
        expectedStateVersion: request.expectedStateVersion,
        issuedAt: request.issuedAt,
        expiresAt: request.expiresAt,
        migration: request.migration,
      };
      this.#plans.set(token, { plan, token });
      return { plan, token };
    });

  readonly approveNoRollbackPlan = (request: {
    readonly token: string;
    readonly dataIdentity: string;
    readonly candidateReleaseId: string;
    readonly expectedStateVersion: string;
    readonly approvedAt: string;
  }) => {
    const repository = this;
    return Effect.gen(function* () {
      const retained = repository.#plans.get(request.token);
      if (
        retained === undefined ||
        retained.plan.dataIdentity !== request.dataIdentity ||
        retained.plan.candidateReleaseId !== request.candidateReleaseId ||
        retained.plan.expectedStateVersion !== request.expectedStateVersion
      ) {
        return yield* Effect.fail(
          new LifecycleError(
            "NO_ROLLBACK_PLAN_STALE",
            "the no-rollback plan expired or the relevant Daemon state changed",
          ),
        );
      }
      if (retained.plan.approvedAt !== undefined) return retained.plan;
      if (Date.parse(retained.plan.expiresAt) <= Date.parse(request.approvedAt)) {
        return yield* Effect.fail(
          new LifecycleError(
            "NO_ROLLBACK_PLAN_STALE",
            "the no-rollback plan expired or the relevant Daemon state changed",
          ),
        );
      }
      const approved = { ...retained.plan, approvedAt: request.approvedAt };
      repository.#plans.set(request.token, { plan: approved, token: request.token });
      return approved;
    });
  };

  readonly record = (report: UpgradeCheckReport) =>
    Effect.sync(() => {
      this.#latest = report;
    });

  readonly latest = Effect.sync(() => this.#latest);
}
