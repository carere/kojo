import { type DecodeResult, decodeFailure, decodeSuccess } from "../../shared/codecs/json.ts";
import { MAX_CONTROL_FRAME_BYTES, type RunnerFrame } from "../contracts/frame.ts";
import { decodeRunnerFrame } from "./frame.ts";

const PREFIX_BYTES = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const encodeLengthPrefixedFrame = (input: unknown): DecodeResult<Uint8Array> => {
  const frame = decodeRunnerFrame(input);
  if (!frame.ok) return frame;
  const payload = encoder.encode(JSON.stringify(frame.value));
  if (payload.byteLength > MAX_CONTROL_FRAME_BYTES) {
    return decodeFailure([], `Control frames must not exceed ${MAX_CONTROL_FRAME_BYTES} bytes`);
  }
  const bytes = new Uint8Array(PREFIX_BYTES + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, payload.byteLength, false);
  bytes.set(payload, PREFIX_BYTES);
  return decodeSuccess(bytes);
};

export const decodeFrameLength = (prefix: Uint8Array): DecodeResult<number> => {
  if (prefix.byteLength !== PREFIX_BYTES) {
    return decodeFailure([], "Expected a four-byte frame length prefix");
  }
  const length = new DataView(prefix.buffer, prefix.byteOffset, PREFIX_BYTES).getUint32(0, false);
  if (length > MAX_CONTROL_FRAME_BYTES) {
    return decodeFailure([], `Control frames must not exceed ${MAX_CONTROL_FRAME_BYTES} bytes`);
  }
  return decodeSuccess(length);
};

export const decodeLengthPrefixedFrame = (input: Uint8Array): DecodeResult<RunnerFrame> => {
  if (input.byteLength < PREFIX_BYTES)
    return decodeFailure([], "Frame length prefix is incomplete");
  const length = decodeFrameLength(input.subarray(0, PREFIX_BYTES));
  if (!length.ok) return length;
  if (input.byteLength !== PREFIX_BYTES + length.value) {
    return decodeFailure([], "Frame length does not match the payload length");
  }

  let text: string;
  try {
    text = decoder.decode(input.subarray(PREFIX_BYTES));
  } catch {
    return decodeFailure([], "Frame payload is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return decodeFailure([], "Frame payload is not valid JSON");
  }
  return decodeRunnerFrame(parsed);
};
