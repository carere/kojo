import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { CheckedManagedReleaseManifest } from "../models/ManagedRelease.ts";
import type {
  UpgradeCheckReport,
  UpgradeCheckResult,
  UpgradeCompatibilityFault,
  UpgradeEvidence,
  UpgradeExistingFault,
  UpgradeRequirement,
  UpgradeRevisionEvidence,
} from "../models/ManagedUpgrade.ts";
import type { UpgradePreflightRepository } from "../ports/UpgradePreflightRepository.ts";

const PLAN_MILLIS = 10 * 60 * 1_000;

const hash = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

const scopeFor = (
  requirements: ReadonlyArray<UpgradeRequirement>,
  revisionId: string,
): ReadonlyArray<string> =>
  requirements
    .filter((entry) => entry.revisionId === revisionId)
    .map((entry) => `${entry.kind}:${entry.ownerId}`)
    .sort();

const candidateFault = (
  evidence: UpgradeEvidence,
  revision: UpgradeRevisionEvidence,
  candidate: CheckedManagedReleaseManifest,
): ReadonlyArray<UpgradeCompatibilityFault> => {
  const affectedScope = scopeFor(evidence.requirements, revision.revisionId);
  const manifest = revision.manifest;
  if (manifest === undefined) {
    return [
      {
        code: "COMPATIBILITY_UNKNOWN",
        revisionId: revision.revisionId,
        affectedScope,
        detail: revision.inspectionFault ?? "the retained manifest cannot be inspected",
        remedy: "Repair the exact retained manifest, then repeat the managed upgrade check.",
      },
    ];
  }
  const faults: UpgradeCompatibilityFault[] = [];
  if (!candidate.compatibility.revisionFormats.includes(manifest.formatVersion)) {
    faults.push({
      code: "REVISION_FORMAT_UNKNOWN",
      revisionId: revision.revisionId,
      affectedScope,
      detail: `the candidate does not read Workflow Revision format ${manifest.formatVersion}`,
      remedy: "Use a candidate that declares this exact retained revision format.",
    });
  }
  if (
    candidate.host.os !== manifest.compatibility.os ||
    candidate.host.arch !== manifest.compatibility.arch
  ) {
    faults.push({
      code: "HOST_REGRESSION",
      revisionId: revision.revisionId,
      affectedScope,
      detail: `the retained revision requires ${manifest.compatibility.os}/${manifest.compatibility.arch}, but the candidate records ${candidate.host.os}/${candidate.host.arch}`,
      remedy: "Stage the candidate artifact for the recorded Host and architecture.",
    });
  }
  try {
    if (!Bun.semver.satisfies(candidate.bunVersion, `>=${manifest.compatibility.bun}`)) {
      faults.push({
        code: "BUN_REGRESSION",
        revisionId: revision.revisionId,
        affectedScope,
        detail: `the retained revision requires Bun ${manifest.compatibility.bun}, but the candidate retains ${candidate.bunVersion}`,
        remedy: "Stage a candidate with a compatible managed Bun. Kojo will not substitute one.",
      });
    }
  } catch {
    faults.push({
      code: "COMPATIBILITY_UNKNOWN",
      revisionId: revision.revisionId,
      affectedScope,
      detail: "the retained Bun requirement is not a valid compatibility value",
      remedy: "Repair the exact retained evidence before upgrade.",
    });
  }
  if (
    !manifest.runtime.protocols.some((protocol) =>
      candidate.compatibility.runnerProtocols.includes(protocol),
    )
  ) {
    faults.push({
      code: "RUNNER_PROTOCOL_REGRESSION",
      revisionId: revision.revisionId,
      affectedScope,
      detail: `the candidate and retained revision have no shared Runner protocol (${manifest.runtime.protocols.join(", ")})`,
      remedy: "Use a candidate that retains one recorded Runner protocol.",
    });
  }
  const missingFeatures = manifest.runtime.requiredFeatures.filter(
    (feature) => !candidate.compatibility.requiredFeatures.includes(feature),
  );
  if (missingFeatures.length > 0) {
    faults.push({
      code: "RUNNER_FEATURE_REGRESSION",
      revisionId: revision.revisionId,
      affectedScope,
      detail: `the candidate does not provide retained Runner features: ${missingFeatures.join(", ")}`,
      remedy: "Use a candidate that declares every recorded required feature.",
    });
  }
  return faults;
};

const existingFaults = (evidence: UpgradeEvidence): ReadonlyArray<UpgradeExistingFault> => [
  ...evidence.currentWorkflowFaults.map((fault) => ({
    code: "CURRENT_WORKFLOW_FAULT",
    affectedScope: [`current-workflow:${fault.ownerId}`],
    detail: fault.detail,
    remedy: fault.remedy,
  })),
  ...evidence.revisions.flatMap((revision) =>
    revision.faults
      .filter((fault) =>
        ["CONTENT_MISSING", "CONTENT_CORRUPT", "COLLECTION_INTERRUPTED"].includes(fault.code),
      )
      .map((fault) => ({
        code: fault.code,
        revisionId: revision.revisionId,
        affectedScope: scopeFor(evidence.requirements, revision.revisionId),
        detail: fault.detail,
        remedy: fault.remedy,
      })),
  ),
];

const counts = (evidence: UpgradeEvidence): UpgradeCheckReport["checked"] => ({
  currentWorkflows: evidence.requirements.filter((entry) => entry.kind === "current-workflow")
    .length,
  retainedRuns: evidence.requirements.filter((entry) => entry.kind === "retained-run").length,
  terminalRuns: evidence.requirements.filter(
    (entry) =>
      entry.kind === "retained-run" &&
      entry.state !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(entry.state),
  ).length,
  validations: evidence.requirements.filter((entry) => entry.kind === "validation").length,
  readers: evidence.requirements.filter(
    (entry) => entry.kind === "active-reader" || entry.kind === "loaded-registration",
  ).length,
  revisions: evidence.revisions.length,
});

export class ManagedUpgradePreflight {
  readonly #repository: UpgradePreflightRepository;
  readonly #now: () => number;
  readonly latest: Effect.Effect<UpgradeCheckReport | undefined, LifecycleError>;

  constructor(repository: UpgradePreflightRepository, now: () => number = Date.now) {
    this.#repository = repository;
    this.#now = now;
    this.latest = repository.latest;
  }

  readonly check = (request: {
    readonly candidate: CheckedManagedReleaseManifest;
    readonly sourceReleaseId: string;
    readonly approvalToken?: string;
    readonly mutation?: MutationEnvelope;
  }): Effect.Effect<UpgradeCheckResult, LifecycleError> => {
    const service = this;
    return Effect.gen(function* () {
      const checkedAt = new Date(service.#now()).toISOString();
      const first = yield* service.#repository.capture(checkedAt);
      const second = yield* service.#repository.capture(checkedAt);
      return yield* service.checkEvidence(request, { checkedAt, first, second });
    });
  };

  /** Evaluate two real retained-state snapshots taken across the preflight window. */
  readonly checkEvidence = (
    request: {
      readonly candidate: CheckedManagedReleaseManifest;
      readonly sourceReleaseId: string;
      readonly approvalToken?: string;
      readonly mutation?: MutationEnvelope;
    },
    evidence: {
      readonly checkedAt: string;
      readonly first: UpgradeEvidence;
      readonly second: UpgradeEvidence;
    },
  ): Effect.Effect<UpgradeCheckResult, LifecycleError> => {
    const service = this;
    return Effect.gen(function* () {
      const { checkedAt, first, second } = evidence;
      const compatibilityFaults: UpgradeCompatibilityFault[] = [];
      const migration = request.candidate.migration;
      if (!request.candidate.compatibility.dataFormats.includes(first.dataFormat)) {
        if (
          migration === undefined ||
          migration.fromDataFormat !== first.dataFormat ||
          !request.candidate.compatibility.dataFormats.includes(migration.toDataFormat)
        ) {
          compatibilityFaults.push({
            code: "DATA_FORMAT_UNSUPPORTED",
            affectedScope: ["daemon-data"],
            detail: `the candidate does not read Daemon data format ${first.dataFormat} and declares no exact migration`,
            remedy: "Use a candidate that reads this data format or declares its exact migration.",
          });
        }
      }
      compatibilityFaults.push(
        ...first.revisions.flatMap((revision) =>
          candidateFault(first, revision, request.candidate),
        ),
      );
      const existing = existingFaults(first);
      if (second.retainedSetHash !== first.retainedSetHash) {
        compatibilityFaults.push({
          code: "RETAINED_SET_CHANGED",
          affectedScope: ["daemon-data"],
          detail: "the required retained set changed while preflight inspected it",
          remedy: "Repeat the check against the new complete retained set before drain.",
        });
      }

      const needsApproval =
        migration !== undefined &&
        migration.fromDataFormat === first.dataFormat &&
        migration.toDataFormat !== first.dataFormat &&
        migration.rollback === "lost";
      let approval: UpgradeCheckReport["rollbackApproval"] = needsApproval
        ? "required"
        : "not-required";
      let plan: UpgradeCheckReport["plan"];
      let approvalToken: string | undefined;
      if (needsApproval && compatibilityFaults.length === 0 && existing.length === 0) {
        const migrationPlan = {
          fromDataFormat: migration.fromDataFormat,
          toDataFormat: migration.toDataFormat,
          description: migration.description,
        };
        if (request.approvalToken === undefined) {
          const issued = yield* service.#repository.issueNoRollbackPlan({
            dataIdentity: first.dataIdentity,
            candidateReleaseId: request.candidate.releaseId,
            requestHash: hash({
              operation: "managed-upgrade-check",
              candidateReleaseId: request.candidate.releaseId,
              migration: migrationPlan,
            }),
            affectedScope: [
              "daemon-data",
              ...first.requirements.map((entry) => `${entry.kind}:${entry.ownerId}`),
            ].sort(),
            expectedStateVersion: first.retainedSetHash,
            issuedAt: checkedAt,
            expiresAt: new Date(service.#now() + PLAN_MILLIS).toISOString(),
            migration: migrationPlan,
          });
          plan = issued.plan;
          approvalToken = issued.token;
          if (plan.approvedAt !== undefined) approval = "approved";
        } else {
          plan = yield* service.#repository.approveNoRollbackPlan({
            token: request.approvalToken,
            dataIdentity: first.dataIdentity,
            candidateReleaseId: request.candidate.releaseId,
            expectedStateVersion: first.retainedSetHash,
            approvedAt: checkedAt,
          });
          approval = "approved";
        }
      } else if (request.approvalToken !== undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "NO_ROLLBACK_APPROVAL_REFUSED",
            "the candidate does not currently require this no-rollback approval",
          ),
        );
      }

      const outcome: UpgradeCheckReport["outcome"] =
        compatibilityFaults.length > 0
          ? "incompatible"
          : existing.length > 0
            ? "existing-fault"
            : needsApproval && approval !== "approved"
              ? "approval-required"
              : "staged";
      const remedy =
        outcome === "staged"
          ? "The candidate is checked. Activation needs a separate managed upgrade operation."
          : outcome === "approval-required"
            ? "Review the disclosed migration and approve this exact plan before drain."
            : outcome === "existing-fault"
              ? "Repair the named retained evidence, then repeat the candidate check."
              : "Use the named compatibility remedy and repeat the candidate check.";
      const report: UpgradeCheckReport = {
        formatVersion: 1,
        outcome,
        candidateReleaseId: request.candidate.releaseId,
        sourceReleaseId: request.sourceReleaseId,
        dataIdentity: first.dataIdentity,
        retainedSetHash: first.retainedSetHash,
        checkedAt,
        checked: counts(first),
        compatibilityFaults,
        existingFaults: existing,
        rollbackApproval: approval,
        ...(plan === undefined ? {} : { plan }),
        remedy,
      };
      const result: UpgradeCheckResult = {
        report,
        ...(approvalToken === undefined ? {} : { approvalToken }),
      };
      if (request.mutation === undefined) yield* service.#repository.record(report);
      else yield* service.#repository.record(report, request.mutation, result);
      return result;
    });
  };
}
