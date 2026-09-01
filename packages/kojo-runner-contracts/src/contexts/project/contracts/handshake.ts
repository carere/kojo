import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeString,
  decodeStringArray,
  decodeSuccess,
} from "../../shared/codecs/json.ts";
import { decodeRunnerIdentity, decodeSha256 } from "../../shared/models/identity.ts";

export interface HelloBody {
  readonly helloVersion: 1;
  readonly connectionSecret: string;
  readonly packageGraphId: string;
  readonly projectId: string;
  readonly supportedProtocols: ReadonlyArray<1>;
  readonly requiredFeatures: ReadonlyArray<string>;
}

export interface WelcomeBody {
  readonly welcomeVersion: 1;
  readonly packageGraphId: string;
  readonly projectId: string;
  readonly selectedProtocol: 1;
  readonly features: ReadonlyArray<string>;
}

const decodeProtocolList = (
  input: unknown,
  path: ReadonlyArray<number | string>,
): DecodeResult<ReadonlyArray<1>> => {
  if (!Array.isArray(input) || input.length !== 1) {
    return decodeFailure(path, "Expected the supported protocol list [1]");
  }
  const version = decodeInteger(input[0], [...path, 0], { minimum: 1 });
  return version.ok && version.value === 1
    ? decodeSuccess([1])
    : decodeFailure([...path, 0], "Expected Runner protocol 1");
};

export const decodeHelloBody = (input: unknown): DecodeResult<HelloBody> => {
  const record = decodeClosedRecord(input, [
    "helloVersion",
    "connectionSecret",
    "packageGraphId",
    "projectId",
    "supportedProtocols",
    "requiredFeatures",
  ]);
  if (!record.ok) return record;
  if (record.value.helloVersion !== 1) {
    return decodeFailure(["helloVersion"], "Expected Hello body version 1");
  }
  const connectionSecret = decodeString(record.value.connectionSecret, ["connectionSecret"], {
    minLength: 64,
    pattern: /^[a-f0-9]+$/,
  });
  if (!connectionSecret.ok) return connectionSecret;
  const packageGraphId = decodeSha256(record.value.packageGraphId, ["packageGraphId"]);
  if (!packageGraphId.ok) return packageGraphId;
  const projectId = decodeRunnerIdentity(record.value.projectId, ["projectId"]);
  if (!projectId.ok) return projectId;
  const supportedProtocols = decodeProtocolList(record.value.supportedProtocols, [
    "supportedProtocols",
  ]);
  if (!supportedProtocols.ok) return supportedProtocols;
  const requiredFeatures = decodeStringArray(record.value.requiredFeatures, ["requiredFeatures"]);
  if (!requiredFeatures.ok) return requiredFeatures;
  return decodeSuccess({
    helloVersion: 1,
    connectionSecret: connectionSecret.value,
    packageGraphId: packageGraphId.value,
    projectId: projectId.value,
    supportedProtocols: supportedProtocols.value,
    requiredFeatures: requiredFeatures.value,
  });
};

export const decodeWelcomeBody = (input: unknown): DecodeResult<WelcomeBody> => {
  const record = decodeClosedRecord(input, [
    "welcomeVersion",
    "packageGraphId",
    "projectId",
    "selectedProtocol",
    "features",
  ]);
  if (!record.ok) return record;
  if (record.value.welcomeVersion !== 1) {
    return decodeFailure(["welcomeVersion"], "Expected Welcome body version 1");
  }
  const packageGraphId = decodeSha256(record.value.packageGraphId, ["packageGraphId"]);
  if (!packageGraphId.ok) return packageGraphId;
  const projectId = decodeRunnerIdentity(record.value.projectId, ["projectId"]);
  if (!projectId.ok) return projectId;
  if (record.value.selectedProtocol !== 1) {
    return decodeFailure(["selectedProtocol"], "Expected Runner protocol 1");
  }
  const features = decodeStringArray(record.value.features, ["features"]);
  if (!features.ok) return features;
  return decodeSuccess({
    welcomeVersion: 1,
    packageGraphId: packageGraphId.value,
    projectId: projectId.value,
    selectedProtocol: 1,
    features: features.value,
  });
};
