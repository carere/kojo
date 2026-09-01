import type { Socket } from "node:net";
import {
  decodeFrameLength,
  decodeLengthPrefixedFrame,
  encodeLengthPrefixedFrame,
} from "@carere/kojo-runner-contracts/contexts/project/codecs/framing";
import type { RunnerFrame } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import { Data, Effect } from "effect";

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
};

const failureText = (
  issues: ReadonlyArray<{
    readonly message: string;
    readonly path: ReadonlyArray<number | string>;
  }>,
): string =>
  issues.map((issue) => `${issue.path.join(".") || "frame"}: ${issue.message}`).join("; ");

export class RunnerChannelError extends Data.TaggedError("RunnerChannelError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const channelError = (cause: unknown): RunnerChannelError =>
  new RunnerChannelError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

class SocketFrameReader {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #waiting:
    | {
        readonly resolve: (frame: RunnerFrame) => void;
        readonly reject: (cause: Error) => void;
      }
    | undefined;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = concat(this.#buffer, chunk);
      this.#drain();
    });
    socket.on("error", (cause) => this.#fail(cause));
    socket.on("close", () => this.#fail(new Error("the private Runner channel closed")));
  }

  read(): Promise<RunnerFrame> {
    if (this.#waiting !== undefined)
      return Promise.reject(new Error("only one Runner frame read can be pending"));
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#waiting === undefined || this.#buffer.byteLength < 4) return;
    const length = decodeFrameLength(this.#buffer.subarray(0, 4));
    if (!length.ok) {
      this.#fail(new Error(failureText(length.issues)));
      return;
    }
    const total = 4 + length.value;
    if (this.#buffer.byteLength < total) return;
    const encoded = this.#buffer.slice(0, total);
    this.#buffer = this.#buffer.slice(total);
    const decoded = decodeLengthPrefixedFrame(encoded);
    if (!decoded.ok) {
      this.#fail(new Error(failureText(decoded.issues)));
      return;
    }
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting.resolve(decoded.value);
  }

  #fail(cause: Error): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.reject(cause);
  }
}

export interface RunnerFrameReader {
  readonly read: Effect.Effect<RunnerFrame, RunnerChannelError>;
}

export const makeRunnerFrameReader = (socket: Socket): RunnerFrameReader => {
  const reader = new SocketFrameReader(socket);
  return {
    read: Effect.tryPromise({
      try: () => reader.read(),
      catch: channelError,
    }),
  };
};

export const writeRunnerFrame = (
  socket: Socket,
  frame: RunnerFrame,
): Effect.Effect<void, RunnerChannelError> => {
  const encoded = encodeLengthPrefixedFrame(frame);
  if (!encoded.ok) return Effect.fail(channelError(new Error(failureText(encoded.issues))));
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        socket.write(encoded.value, (cause) => (cause == null ? resolve() : reject(cause)));
      }),
    catch: channelError,
  });
};
