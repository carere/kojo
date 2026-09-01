import type { RevisionFault } from "../../workflow/models/RevisionMaintenance.ts";
import type { RevisionManifest } from "../../workflow/models/RevisionManifest.ts";

export type UpgradeRequirementKind =
  | "current-workflow"
  | "retained-run"
  | "validation"
  | "active-reader"
  | "loaded-registration";

export interface UpgradeRequirement {
  readonly kind: UpgradeRequirementKind;
  readonly ownerId: string;
  readonly revisionId: string;
  readonly state?: string;
}

export interface UpgradeRevisionEvidence {
  readonly revisionId: string;
  readonly packageGraphId?: string;
  readonly manifest?: RevisionManifest;
  readonly faults: ReadonlyArray<RevisionFault>;
  readonly inspectionFault?: string;
}

/** One read-only view of all content that a replacement Daemon must still understand. */
export interface UpgradeEvidence {
  readonly dataIdentity: string;
  readonly dataFormat: number;
  readonly retainedSetHash: string;
  readonly requirements: ReadonlyArray<UpgradeRequirement>;
  readonly revisions: ReadonlyArray<UpgradeRevisionEvidence>;
  readonly currentWorkflowFaults: ReadonlyArray<{
    readonly ownerId: string;
    readonly detail: string;
    readonly remedy: string;
  }>;
}

export interface UpgradeCompatibilityFault {
  readonly code:
    | "DATA_FORMAT_UNSUPPORTED"
    | "REVISION_FORMAT_UNKNOWN"
    | "HOST_REGRESSION"
    | "BUN_REGRESSION"
    | "RUNNER_PROTOCOL_REGRESSION"
    | "RUNNER_FEATURE_REGRESSION"
    | "RETAINED_SET_CHANGED"
    | "COMPATIBILITY_UNKNOWN";
  readonly revisionId?: string;
  readonly affectedScope: ReadonlyArray<string>;
  readonly detail: string;
  readonly remedy: string;
}

export interface UpgradeExistingFault {
  readonly code: string;
  readonly revisionId?: string;
  readonly affectedScope: ReadonlyArray<string>;
  readonly detail: string;
  readonly remedy: string;
}

export interface NoRollbackPlan {
  readonly formatVersion: 1;
  readonly planId: string;
  readonly kind: "approve-no-rollback";
  readonly dataIdentity: string;
  readonly candidateReleaseId: string;
  readonly requestHash: string;
  readonly affectedScope: ReadonlyArray<string>;
  readonly expectedStateVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly migration: {
    readonly fromDataFormat: number;
    readonly toDataFormat: number;
    readonly description: string;
  };
  readonly approvedAt?: string;
}

export type UpgradeCheckOutcome =
  | "staged"
  | "incompatible"
  | "existing-fault"
  | "approval-required";

export interface UpgradeCheckReport {
  readonly formatVersion: 1;
  readonly outcome: UpgradeCheckOutcome;
  readonly candidateReleaseId: string;
  readonly sourceReleaseId: string;
  readonly dataIdentity: string;
  readonly retainedSetHash: string;
  readonly checkedAt: string;
  readonly checked: {
    readonly currentWorkflows: number;
    readonly retainedRuns: number;
    readonly terminalRuns: number;
    readonly validations: number;
    readonly readers: number;
    readonly revisions: number;
  };
  readonly compatibilityFaults: ReadonlyArray<UpgradeCompatibilityFault>;
  readonly existingFaults: ReadonlyArray<UpgradeExistingFault>;
  readonly rollbackApproval: "not-required" | "required" | "approved";
  readonly plan?: NoRollbackPlan;
  readonly remedy: string;
}

export interface UpgradeCheckResult {
  readonly report: UpgradeCheckReport;
  /** Returned only when a human must approve the exact disclosed plan. */
  readonly approvalToken?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isNonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isFault = (value: unknown, compatibility: boolean): boolean => {
  if (!isRecord(value)) return false;
  const allowedCodes: ReadonlyArray<UpgradeCompatibilityFault["code"]> = [
    "DATA_FORMAT_UNSUPPORTED",
    "REVISION_FORMAT_UNKNOWN",
    "HOST_REGRESSION",
    "BUN_REGRESSION",
    "RUNNER_PROTOCOL_REGRESSION",
    "RUNNER_FEATURE_REGRESSION",
    "RETAINED_SET_CHANGED",
    "COMPATIBILITY_UNKNOWN",
  ];
  return (
    hasOnlyKeys(value, ["code", "revisionId", "affectedScope", "detail", "remedy"]) &&
    typeof value.code === "string" &&
    (!compatibility || allowedCodes.includes(value.code as UpgradeCompatibilityFault["code"])) &&
    (value.revisionId === undefined || typeof value.revisionId === "string") &&
    isStringArray(value.affectedScope) &&
    typeof value.detail === "string" &&
    typeof value.remedy === "string"
  );
};

const isPlan = (value: unknown): value is NoRollbackPlan => {
  if (!isRecord(value) || !isRecord(value.migration)) return false;
  return (
    hasOnlyKeys(value, [
      "formatVersion",
      "planId",
      "kind",
      "dataIdentity",
      "candidateReleaseId",
      "requestHash",
      "affectedScope",
      "expectedStateVersion",
      "issuedAt",
      "expiresAt",
      "migration",
      "approvedAt",
    ]) &&
    value.formatVersion === 1 &&
    typeof value.planId === "string" &&
    value.kind === "approve-no-rollback" &&
    typeof value.dataIdentity === "string" &&
    typeof value.candidateReleaseId === "string" &&
    typeof value.requestHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.requestHash) &&
    isStringArray(value.affectedScope) &&
    typeof value.expectedStateVersion === "string" &&
    /^[a-f0-9]{64}$/.test(value.expectedStateVersion) &&
    typeof value.issuedAt === "string" &&
    Number.isFinite(Date.parse(value.issuedAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    (value.approvedAt === undefined ||
      (typeof value.approvedAt === "string" && Number.isFinite(Date.parse(value.approvedAt)))) &&
    hasOnlyKeys(value.migration, ["fromDataFormat", "toDataFormat", "description"]) &&
    Number.isSafeInteger(value.migration.fromDataFormat) &&
    Number.isSafeInteger(value.migration.toDataFormat) &&
    typeof value.migration.description === "string"
  );
};

/** Decode one private Daemon response without trusting a same-user socket peer. */
export const decodeUpgradeCheckReport = (value: unknown): UpgradeCheckReport => {
  if (!isRecord(value) || !isRecord(value.checked)) {
    throw new Error("the Daemon returned an invalid managed upgrade report");
  }
  const outcomes: ReadonlyArray<UpgradeCheckOutcome> = [
    "staged",
    "incompatible",
    "existing-fault",
    "approval-required",
  ];
  if (
    !hasOnlyKeys(value, [
      "formatVersion",
      "outcome",
      "candidateReleaseId",
      "sourceReleaseId",
      "dataIdentity",
      "retainedSetHash",
      "checkedAt",
      "checked",
      "compatibilityFaults",
      "existingFaults",
      "rollbackApproval",
      "plan",
      "remedy",
    ]) ||
    value.formatVersion !== 1 ||
    typeof value.outcome !== "string" ||
    !outcomes.includes(value.outcome as UpgradeCheckOutcome) ||
    typeof value.candidateReleaseId !== "string" ||
    typeof value.sourceReleaseId !== "string" ||
    typeof value.dataIdentity !== "string" ||
    typeof value.retainedSetHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.retainedSetHash) ||
    typeof value.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    !hasOnlyKeys(value.checked, [
      "currentWorkflows",
      "retainedRuns",
      "terminalRuns",
      "validations",
      "readers",
      "revisions",
    ]) ||
    !isNonnegativeInteger(value.checked.currentWorkflows) ||
    !isNonnegativeInteger(value.checked.retainedRuns) ||
    !isNonnegativeInteger(value.checked.terminalRuns) ||
    !isNonnegativeInteger(value.checked.validations) ||
    !isNonnegativeInteger(value.checked.readers) ||
    !isNonnegativeInteger(value.checked.revisions) ||
    !Array.isArray(value.compatibilityFaults) ||
    !value.compatibilityFaults.every((fault) => isFault(fault, true)) ||
    !Array.isArray(value.existingFaults) ||
    !value.existingFaults.every((fault) => isFault(fault, false)) ||
    (value.rollbackApproval !== "not-required" &&
      value.rollbackApproval !== "required" &&
      value.rollbackApproval !== "approved") ||
    (value.plan !== undefined && !isPlan(value.plan)) ||
    typeof value.remedy !== "string"
  ) {
    throw new Error("the Daemon returned an invalid managed upgrade report");
  }
  return value as unknown as UpgradeCheckReport;
};

export const decodeUpgradeCheckResult = (value: unknown): UpgradeCheckResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["report", "approvalToken"]) ||
    (value.approvalToken !== undefined &&
      (typeof value.approvalToken !== "string" || value.approvalToken.length === 0))
  ) {
    throw new Error("the Daemon returned an invalid managed upgrade result");
  }
  return {
    report: decodeUpgradeCheckReport(value.report),
    ...(value.approvalToken === undefined ? {} : { approvalToken: value.approvalToken as string }),
  };
};
