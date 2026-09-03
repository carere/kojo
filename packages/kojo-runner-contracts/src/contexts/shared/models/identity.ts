import { type DecodeResult, decodeString } from "../codecs/json.ts";

export const decodeRunnerIdentity = (
  input: unknown,
  path: ReadonlyArray<number | string> = [],
): DecodeResult<string> => decodeString(input, path, { minLength: 1, pattern: /^[A-Za-z0-9_-]+$/ });

export const decodeSha256 = (
  input: unknown,
  path: ReadonlyArray<number | string> = [],
): DecodeResult<string> => decodeString(input, path, { pattern: /^[a-f0-9]{64}$/ });
