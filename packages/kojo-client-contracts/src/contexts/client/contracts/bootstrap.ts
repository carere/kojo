import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeString,
  decodeStringArray,
  decodeSuccess,
} from "../../shared/codecs/json.ts";
import { decodeOpaqueIdentity } from "../../shared/models/identity.ts";

export interface BootstrapResponse {
  readonly bootstrapVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly clientApiVersions: ReadonlyArray<number>;
  readonly features: ReadonlyArray<string>;
  readonly packageVersion: string;
}

export interface ClientNegotiation {
  readonly negotiationVersion: 1;
  readonly clientApiVersions: ReadonlyArray<number>;
  readonly requiredFeatures: ReadonlyArray<string>;
}

const decodeVersions = (
  input: unknown,
  path: ReadonlyArray<number | string>,
): DecodeResult<ReadonlyArray<number>> => {
  if (!Array.isArray(input) || input.length === 0) {
    return decodeFailure(path, "Expected a non-empty API version array");
  }
  const versions: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const decoded = decodeInteger(input[index], [...path, index], { minimum: 1 });
    if (!decoded.ok) return decoded;
    if (versions.includes(decoded.value))
      return decodeFailure([...path, index], "Expected a unique version");
    versions.push(decoded.value);
  }
  return decodeSuccess(versions);
};

export const decodeBootstrapResponse = (input: unknown): DecodeResult<BootstrapResponse> => {
  const record = decodeClosedRecord(input, [
    "bootstrapVersion",
    "instanceId",
    "dataIdentity",
    "clientApiVersions",
    "features",
    "packageVersion",
  ]);
  if (!record.ok) return record;
  if (record.value.bootstrapVersion !== 1) {
    return decodeFailure(["bootstrapVersion"], "Expected bootstrap version 1");
  }
  const instanceId = decodeOpaqueIdentity(record.value.instanceId, ["instanceId"]);
  if (!instanceId.ok) return instanceId;
  const dataIdentity = decodeOpaqueIdentity(record.value.dataIdentity, ["dataIdentity"]);
  if (!dataIdentity.ok) return dataIdentity;
  const clientApiVersions = decodeVersions(record.value.clientApiVersions, ["clientApiVersions"]);
  if (!clientApiVersions.ok) return clientApiVersions;
  const features = decodeStringArray(record.value.features, ["features"], { unique: true });
  if (!features.ok) return features;
  const packageVersion = decodeString(record.value.packageVersion, ["packageVersion"], {
    minLength: 1,
  });
  if (!packageVersion.ok) return packageVersion;
  return decodeSuccess({
    bootstrapVersion: 1,
    instanceId: instanceId.value,
    dataIdentity: dataIdentity.value,
    clientApiVersions: clientApiVersions.value,
    features: features.value,
    packageVersion: packageVersion.value,
  });
};

/** @public */
export const decodeClientNegotiation = (input: unknown): DecodeResult<ClientNegotiation> => {
  const record = decodeClosedRecord(input, [
    "negotiationVersion",
    "clientApiVersions",
    "requiredFeatures",
  ]);
  if (!record.ok) return record;
  if (record.value.negotiationVersion !== 1) {
    return decodeFailure(["negotiationVersion"], "Expected negotiation version 1");
  }
  const clientApiVersions = decodeVersions(record.value.clientApiVersions, ["clientApiVersions"]);
  if (!clientApiVersions.ok) return clientApiVersions;
  const requiredFeatures = decodeStringArray(record.value.requiredFeatures, ["requiredFeatures"], {
    unique: true,
  });
  if (!requiredFeatures.ok) return requiredFeatures;
  return decodeSuccess({
    negotiationVersion: 1,
    clientApiVersions: clientApiVersions.value,
    requiredFeatures: requiredFeatures.value,
  });
};
