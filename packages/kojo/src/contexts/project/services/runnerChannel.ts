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

/** Read bounded length-prefixed Runner frames without losing coalesced socket bytes. */
class SocketFrameReader {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #failure: Error | undefined;
  #waiting:
    | {
        readonly resolve: (frame: RunnerFrame) => void;
        readonly reject: (cause: Error) => void;
      }
    | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = concat(this.#buffer, chunk);
      this.#drain();
    });
    socket.on("error", (cause) => this.#fail(cause));
    socket.on("close", () => this.#fail(new Error("the private Runner channel closed")));
  }

  read(): Promise<RunnerFrame> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
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
    if (this.#failure !== undefined) return;
    this.#failure = cause;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.reject(cause);
    this.socket.destroy();
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

const writeRawRunnerFrame = (
  socket: Socket,
  encoded: Uint8Array,
): Effect.Effect<void, RunnerChannelError> => {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        socket.write(encoded, (cause) => (cause == null ? resolve() : reject(cause)));
      }),
    catch: channelError,
  });
};

export const MAX_ORDINARY_REQUESTS = 64;
export const MAX_ORDINARY_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_CRITICAL_REQUESTS = 8;
export const MAX_CRITICAL_BUFFER_BYTES = 1024 * 1024;

const critical = (frame: RunnerFrame): boolean =>
  frame.kind === "Health" ||
  frame.kind === "CancelRun" ||
  frame.kind === "Shutdown" ||
  frame.kind === "Stopped";

class CapacityPool {
  #requests = 0;
  #bytes = 0;
  #failure: Error | undefined;
  readonly #waiters: Array<{
    readonly bytes: number;
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
  }> = [];

  constructor(
    private readonly requestLimit: number,
    private readonly byteLimit: number,
  ) {}

  async acquire(bytes: number): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (bytes > this.byteLimit)
      throw new Error("the Runner frame exceeds its channel buffer class");
    if (this.#waiters.length === 0 && this.#available(bytes)) {
      this.#requests += 1;
      this.#bytes += bytes;
      return;
    }
    await new Promise<void>((resolve, reject) => this.#waiters.push({ bytes, resolve, reject }));
  }

  release(bytes: number): void {
    this.#requests -= 1;
    this.#bytes -= bytes;
    this.#drain();
  }

  fail(cause: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = cause;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(cause);
  }

  #available(bytes: number): boolean {
    return this.#requests < this.requestLimit && this.#bytes + bytes <= this.byteLimit;
  }

  #drain(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (waiter === undefined || !this.#available(waiter.bytes)) return;
      this.#waiters.shift();
      this.#requests += 1;
      this.#bytes += waiter.bytes;
      waiter.resolve();
    }
  }
}

export interface RunnerFrameWriter {
  readonly write: (frame: RunnerFrame) => Effect.Effect<void, RunnerChannelError>;
}

const writers = new WeakMap<Socket, RunnerFrameWriter>();

export const writeRunnerFrame = (
  socket: Socket,
  frame: RunnerFrame,
): Effect.Effect<void, RunnerChannelError> => {
  let writer = writers.get(socket);
  if (writer === undefined) {
    writer = makeRunnerFrameWriter(socket);
    writers.set(socket, writer);
  }
  return writer.write(frame);
};

/**
 * Apply backpressure to ordinary traffic without taking capacity from health, cancellation, and
 * shutdown. Capacity is released only after the socket accepts the complete frame.
 */
export const makeRunnerFrameWriter = (socket: Socket): RunnerFrameWriter => {
  const ordinary = new CapacityPool(MAX_ORDINARY_REQUESTS, MAX_ORDINARY_BUFFER_BYTES);
  const control = new CapacityPool(MAX_CRITICAL_REQUESTS, MAX_CRITICAL_BUFFER_BYTES);
  const fail = (cause: Error): void => {
    ordinary.fail(cause);
    control.fail(cause);
  };
  socket.once("error", fail);
  socket.once("close", () => fail(new Error("the private Runner channel closed")));
  return {
    write: (frame) => {
      const encoded = encodeLengthPrefixedFrame(frame);
      if (!encoded.ok) return Effect.fail(channelError(new Error(failureText(encoded.issues))));
      const pool = critical(frame) ? control : ordinary;
      const payloadBytes = encoded.value.byteLength - 4;
      return Effect.tryPromise({
        try: async () => {
          await pool.acquire(payloadBytes);
          try {
            await Effect.runPromise(writeRawRunnerFrame(socket, encoded.value));
          } finally {
            pool.release(payloadBytes);
          }
        },
        catch: channelError,
      });
    },
  };
};
