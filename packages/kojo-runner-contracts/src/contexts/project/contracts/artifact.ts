import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeString,
  decodeSuccess,
} from "../../shared/codecs/json.ts";
import { decodeRunnerIdentity, decodeSha256 } from "../../shared/models/identity.ts";

export const MAX_ARTIFACT_CHUNK_BYTES = 256 * 1024;

export interface ArtifactChunkBody {
  readonly artifactChunkVersion: 1;
  readonly transferId: string;
  readonly ordinal: number;
  readonly totalSize: number;
  readonly sha256: string;
  readonly data: string;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const decodedBase64ByteLength = (value: string): number => {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

export const decodeArtifactChunkBody = (input: unknown): DecodeResult<ArtifactChunkBody> => {
  const record = decodeClosedRecord(input, [
    "artifactChunkVersion",
    "transferId",
    "ordinal",
    "totalSize",
    "sha256",
    "data",
  ]);
  if (!record.ok) return record;
  if (record.value.artifactChunkVersion !== 1) {
    return decodeFailure(["artifactChunkVersion"], "Expected Artifact chunk version 1");
  }
  const transferId = decodeRunnerIdentity(record.value.transferId, ["transferId"]);
  if (!transferId.ok) return transferId;
  const ordinal = decodeInteger(record.value.ordinal, ["ordinal"], { minimum: 0 });
  if (!ordinal.ok) return ordinal;
  const totalSize = decodeInteger(record.value.totalSize, ["totalSize"], { minimum: 0 });
  if (!totalSize.ok) return totalSize;
  const sha256 = decodeSha256(record.value.sha256, ["sha256"]);
  if (!sha256.ok) return sha256;
  const data = decodeString(record.value.data, ["data"], { pattern: BASE64_PATTERN });
  if (!data.ok) return data;
  if (decodedBase64ByteLength(data.value) > MAX_ARTIFACT_CHUNK_BYTES) {
    return decodeFailure(
      ["data"],
      `Artifact chunks must not exceed ${MAX_ARTIFACT_CHUNK_BYTES} bytes`,
    );
  }
  return decodeSuccess({
    artifactChunkVersion: 1,
    transferId: transferId.value,
    ordinal: ordinal.value,
    totalSize: totalSize.value,
    sha256: sha256.value,
    data: data.value,
  });
};
