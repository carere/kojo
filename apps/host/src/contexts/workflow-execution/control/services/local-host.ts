import { randomUUID } from "node:crypto";
import { chmod, open, readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { KojoControl } from "@kojo/control";
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import {
  HostDiagnosticLogger,
  type HostRequestDiagnosticEvent,
} from "../../../shared/services/host-diagnostic-logger";
import { HOST_INFORMATION } from "../models/host-information";
import { getHostInformation } from "../use-cases/get-host-information";
import { listProjects } from "../use-cases/list-projects";
import { prepareHostStoreDirectory } from "./host-store";

export { UnsafeHostStoreError } from "./host-store";

export interface KojoHostServer {
  readonly diagnosticPath: string;
  readonly lockPath: string;
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

export interface KojoHostOptions {
  readonly diagnosticPath: string;
  readonly lockPath?: string;
  readonly serverLayer: Layer.Layer<never, unknown>;
  readonly socketPath: string;
}

export class KojoHostAlreadyRunningError extends Error {
  override readonly name = "KojoHostAlreadyRunningError";
}

const withHostRequestDiagnostic = <A, E, R>(
  hostIdentity: string,
  operation: HostRequestDiagnosticEvent["operation"],
  requestId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const exit = yield* Effect.exit(effect);
    const logger = yield* HostDiagnosticLogger;
    yield* logger
      .emit({
        eventVersion: 1,
        eventKind: "host-request.completed",
        hostIdentity,
        requestId,
        operation,
        outcome: Exit.isSuccess(exit) ? "success" : "error",
        durationMs: Math.max(0, Date.now() - startedAt),
        hostVersion: HOST_INFORMATION.hostVersion,
        protocolMajor: HOST_INFORMATION.protocol.major,
        protocolMinor: HOST_INFORMATION.protocol.minor,
        timestamp: new Date().toISOString(),
      })
      .pipe(Effect.ignore);
    return yield* exit;
  });

const makeKojoControlHandlers = (hostIdentity: string) =>
  KojoControl.toLayer(
    KojoControl.of({
      Negotiate: (_payload, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "Negotiate",
          String(options.requestId),
          getHostInformation,
        ),
      ListProjects: (_payload, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListProjects",
          String(options.requestId),
          listProjects,
        ),
    }),
  );

const removeStaleSocket = async (socketPath: string) => {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const isProcessRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const socketAcceptsConnections = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (active: boolean) => {
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

const acquireHostLock = async (lockPath: string) => {
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      await chmod(lockPath, 0o600);
      return async () => {
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8"));
          if (owner.token === token) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (typeof owner.pid === "number" && isProcessRunning(owner.pid)) {
          throw new KojoHostAlreadyRunningError("Kojo Host is already running or starting.");
        }
        await unlink(lockPath);
      } catch (lockError) {
        if (lockError instanceof KojoHostAlreadyRunningError) throw lockError;
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new KojoHostAlreadyRunningError("Kojo Host ownership cannot be established.");
        }
      }
    }
  }
};

export const makeKojoControlServerLayer = <ProtocolError, ProtocolRequirements>(
  protocol: Layer.Layer<RpcServer.Protocol, ProtocolError, ProtocolRequirements>,
  diagnosticLogger: Layer.Layer<HostDiagnosticLogger>,
  hostIdentity: string,
) =>
  RpcServer.layer(KojoControl).pipe(
    Layer.provide([
      makeKojoControlHandlers(hostIdentity).pipe(Layer.provide(diagnosticLogger)),
      protocol,
    ]),
  );

export const startKojoHost = async (options: KojoHostOptions): Promise<KojoHostServer> => {
  const socketDirectory = dirname(options.socketPath);
  const lockPath = options.lockPath ?? `${options.socketPath}.lock`;
  await prepareHostStoreDirectory(socketDirectory);
  if (dirname(lockPath) !== socketDirectory) await prepareHostStoreDirectory(dirname(lockPath));
  const releaseLock = await acquireHostLock(lockPath);
  let scope: Scope.Closeable | undefined;
  let mayOwnSocket = false;
  try {
    if (await socketAcceptsConnections(options.socketPath)) {
      throw new KojoHostAlreadyRunningError("Kojo Host is already running.");
    }
    await removeStaleSocket(options.socketPath);
    mayOwnSocket = true;
    scope = Effect.runSync(Scope.make());
    const previousUmask = process.umask(0o077);
    try {
      await Effect.runPromise(Layer.buildWithScope(options.serverLayer, scope));
    } finally {
      process.umask(previousUmask);
    }
    await chmod(options.socketPath, 0o600);
    const serverScope = scope;

    return {
      diagnosticPath: options.diagnosticPath,
      lockPath,
      socketPath: options.socketPath,
      stop: async () => {
        try {
          await Effect.runPromise(Scope.close(serverScope, Exit.void));
        } finally {
          try {
            await removeStaleSocket(options.socketPath);
          } finally {
            await releaseLock();
          }
        }
      },
    };
  } catch (error) {
    if (scope !== undefined) {
      await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    }
    if (mayOwnSocket) await removeStaleSocket(options.socketPath);
    await releaseLock();
    throw error;
  }
};
