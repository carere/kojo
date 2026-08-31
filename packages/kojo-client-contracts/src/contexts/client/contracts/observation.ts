import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeJsonValue,
  decodeString,
  decodeSuccess,
  type JsonValue,
} from "../../shared/codecs/json.ts";
import { decodeOpaqueIdentity } from "../../shared/models/identity.ts";

export interface ObservationSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly snapshotVersion: number;
  readonly observedAt: string;
  readonly data: JsonValue;
}

export const decodeObservationSnapshot = (input: unknown): DecodeResult<ObservationSnapshot> => {
  const record = decodeClosedRecord(input, [
    "observationVersion",
    "instanceId",
    "dataIdentity",
    "snapshotVersion",
    "observedAt",
    "data",
  ]);
  if (!record.ok) return record;
  if (record.value.observationVersion !== 1) {
    return decodeFailure(["observationVersion"], "Expected observation version 1");
  }
  const instanceId = decodeOpaqueIdentity(record.value.instanceId, ["instanceId"]);
  if (!instanceId.ok) return instanceId;
  const dataIdentity = decodeOpaqueIdentity(record.value.dataIdentity, ["dataIdentity"]);
  if (!dataIdentity.ok) return dataIdentity;
  const snapshotVersion = decodeInteger(record.value.snapshotVersion, ["snapshotVersion"], {
    minimum: 0,
  });
  if (!snapshotVersion.ok) return snapshotVersion;
  const observedAt = decodeString(record.value.observedAt, ["observedAt"], {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  });
  if (!observedAt.ok || Number.isNaN(Date.parse(observedAt.value))) {
    return decodeFailure(["observedAt"], "Expected an ISO 8601 UTC instant");
  }
  const data = decodeJsonValue(record.value.data);
  if (!data.ok) {
    return {
      ok: false,
      issues: data.issues.map((issue) => ({ ...issue, path: ["data", ...issue.path] })),
    };
  }
  return decodeSuccess({
    observationVersion: 1,
    instanceId: instanceId.value,
    dataIdentity: dataIdentity.value,
    snapshotVersion: snapshotVersion.value,
    observedAt: observedAt.value,
    data: data.value,
  });
};
