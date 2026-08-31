import type { JsonValue } from "../../shared/codecs/json.ts";
import type { HelloBody, WelcomeBody } from "./handshake.ts";
import type { ExecutionMutationKind, RunnerOperationKind } from "./operations.ts";

export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

interface FrameAddress {
  readonly version: 1;
  readonly requestId: string;
  readonly daemonInstanceId: string;
  readonly runnerInstanceId: string;
}

export interface OperationFrame extends FrameAddress {
  readonly kind: Exclude<RunnerOperationKind, ExecutionMutationKind | "Hello" | "Welcome">;
  readonly body: JsonValue;
}

export interface HelloFrame extends FrameAddress {
  readonly kind: "Hello";
  readonly body: HelloBody;
}

export interface WelcomeFrame extends FrameAddress {
  readonly kind: "Welcome";
  readonly body: WelcomeBody;
}

export interface ExecutionMutationFrame extends FrameAddress {
  readonly kind: ExecutionMutationKind;
  readonly runId: string;
  readonly revisionId: string;
  readonly claimGeneration: number;
  readonly body: JsonValue;
}

export type RunnerFrame = ExecutionMutationFrame | HelloFrame | OperationFrame | WelcomeFrame;
