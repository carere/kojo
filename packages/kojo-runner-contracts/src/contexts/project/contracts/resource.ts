import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeJsonValue,
  decodeString,
  decodeSuccess,
} from "../../shared/codecs/json.ts";
import { decodeRunnerIdentity } from "../../shared/models/identity.ts";

export type ResourceKind = "sandbox" | "worktree" | "agent";

export interface BeginResourceAcquisitionBody {
  readonly resourceVersion: 1;
  readonly leaseId: string;
  readonly kind: ResourceKind;
  readonly acquisitionKey: string;
  readonly requestedAt: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface ConfirmResourceAcquiredBody {
  readonly resourceVersion: 1;
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly providerIdentity: string;
  readonly locator: string;
}

export interface BeginResourceReleaseBody {
  readonly resourceVersion: 1;
  readonly leaseId: string;
  readonly requestedAt: string;
}

export interface ConfirmResourceReleasedBody {
  readonly resourceVersion: 1;
  readonly leaseId: string;
  readonly releasedAt: string;
  readonly evidence: string;
}

export interface PreserveResourceBody {
  readonly resourceVersion: 1;
  readonly leaseId: string;
  readonly observedAt: string;
  readonly reason: string;
}

export interface ReportRecoveryBody extends PreserveResourceBody {
  readonly outcome: "released" | "preserved" | "unresolved";
}

const instant = (input: unknown, path: ReadonlyArray<number | string>): DecodeResult<string> => {
  const decoded = decodeString(input, path, {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  });
  return decoded.ok && !Number.isNaN(Date.parse(decoded.value))
    ? decoded
    : decodeFailure(path, "Expected an ISO 8601 UTC instant");
};

const versionAndLease = (
  input: Record<string, unknown>,
): DecodeResult<{ readonly resourceVersion: 1; readonly leaseId: string }> => {
  if (input.resourceVersion !== 1)
    return decodeFailure(["resourceVersion"], "Expected Resource version 1");
  const leaseId = decodeRunnerIdentity(input.leaseId, ["leaseId"]);
  return leaseId.ok ? decodeSuccess({ resourceVersion: 1, leaseId: leaseId.value }) : leaseId;
};

export const decodeBeginResourceAcquisitionBody = (
  input: unknown,
): DecodeResult<BeginResourceAcquisitionBody> => {
  const record = decodeClosedRecord(input, [
    "resourceVersion",
    "leaseId",
    "kind",
    "acquisitionKey",
    "requestedAt",
    "detail",
  ]);
  if (!record.ok) return record;
  const base = versionAndLease(record.value);
  if (!base.ok) return base;
  if (
    record.value.kind !== "sandbox" &&
    record.value.kind !== "worktree" &&
    record.value.kind !== "agent"
  ) {
    return decodeFailure(["kind"], "Expected a controlled Resource kind");
  }
  const acquisitionKey = decodeString(record.value.acquisitionKey, ["acquisitionKey"], {
    minLength: 1,
  });
  if (!acquisitionKey.ok) return acquisitionKey;
  const requestedAt = instant(record.value.requestedAt, ["requestedAt"]);
  if (!requestedAt.ok) return requestedAt;
  const detail = decodeJsonValue(record.value.detail);
  if (
    !detail.ok ||
    detail.value === null ||
    Array.isArray(detail.value) ||
    typeof detail.value !== "object" ||
    Object.values(detail.value).some((value) => typeof value !== "string")
  ) {
    return decodeFailure(["detail"], "Expected a JSON object of Resource detail strings");
  }
  return decodeSuccess({
    ...base.value,
    kind: record.value.kind,
    acquisitionKey: acquisitionKey.value,
    requestedAt: requestedAt.value,
    detail: detail.value as Readonly<Record<string, string>>,
  });
};

export const decodeConfirmResourceAcquiredBody = (
  input: unknown,
): DecodeResult<ConfirmResourceAcquiredBody> => {
  const record = decodeClosedRecord(input, [
    "resourceVersion",
    "leaseId",
    "acquiredAt",
    "providerIdentity",
    "locator",
  ]);
  if (!record.ok) return record;
  const base = versionAndLease(record.value);
  if (!base.ok) return base;
  const acquiredAt = instant(record.value.acquiredAt, ["acquiredAt"]);
  if (!acquiredAt.ok) return acquiredAt;
  const providerIdentity = decodeString(record.value.providerIdentity, ["providerIdentity"], {
    minLength: 1,
  });
  if (!providerIdentity.ok) return providerIdentity;
  const locator = decodeString(record.value.locator, ["locator"], { minLength: 1 });
  return locator.ok
    ? decodeSuccess({
        ...base.value,
        acquiredAt: acquiredAt.value,
        providerIdentity: providerIdentity.value,
        locator: locator.value,
      })
    : locator;
};

export const decodeBeginResourceReleaseBody = (
  input: unknown,
): DecodeResult<BeginResourceReleaseBody> => {
  const record = decodeClosedRecord(input, ["resourceVersion", "leaseId", "requestedAt"]);
  if (!record.ok) return record;
  const base = versionAndLease(record.value);
  if (!base.ok) return base;
  const requestedAt = instant(record.value.requestedAt, ["requestedAt"]);
  return requestedAt.ok
    ? decodeSuccess({ ...base.value, requestedAt: requestedAt.value })
    : requestedAt;
};

export const decodeConfirmResourceReleasedBody = (
  input: unknown,
): DecodeResult<ConfirmResourceReleasedBody> => {
  const record = decodeClosedRecord(input, [
    "resourceVersion",
    "leaseId",
    "releasedAt",
    "evidence",
  ]);
  if (!record.ok) return record;
  const base = versionAndLease(record.value);
  if (!base.ok) return base;
  const releasedAt = instant(record.value.releasedAt, ["releasedAt"]);
  if (!releasedAt.ok) return releasedAt;
  const evidence = decodeString(record.value.evidence, ["evidence"], { minLength: 1 });
  return evidence.ok
    ? decodeSuccess({ ...base.value, releasedAt: releasedAt.value, evidence: evidence.value })
    : evidence;
};

export const decodePreserveResourceBody = (input: unknown): DecodeResult<PreserveResourceBody> => {
  const record = decodeClosedRecord(input, ["resourceVersion", "leaseId", "observedAt", "reason"]);
  if (!record.ok) return record;
  const base = versionAndLease(record.value);
  if (!base.ok) return base;
  const observedAt = instant(record.value.observedAt, ["observedAt"]);
  if (!observedAt.ok) return observedAt;
  const reason = decodeString(record.value.reason, ["reason"], { minLength: 1 });
  return reason.ok
    ? decodeSuccess({ ...base.value, observedAt: observedAt.value, reason: reason.value })
    : reason;
};

export const decodeReportRecoveryBody = (input: unknown): DecodeResult<ReportRecoveryBody> => {
  const record = decodeClosedRecord(input, [
    "resourceVersion",
    "leaseId",
    "observedAt",
    "reason",
    "outcome",
  ]);
  if (!record.ok) return record;
  const preserved = decodePreserveResourceBody({
    resourceVersion: record.value.resourceVersion,
    leaseId: record.value.leaseId,
    observedAt: record.value.observedAt,
    reason: record.value.reason,
  });
  if (!preserved.ok) return preserved;
  if (
    record.value.outcome !== "released" &&
    record.value.outcome !== "preserved" &&
    record.value.outcome !== "unresolved"
  ) {
    return decodeFailure(["outcome"], "Expected a Resource recovery outcome");
  }
  return decodeSuccess({ ...preserved.value, outcome: record.value.outcome });
};
