import { chmod, mkdir, unlink } from "node:fs/promises";
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

export interface KojoHostServer {
  readonly diagnosticPath: string;
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

export interface KojoHostOptions {
  readonly diagnosticPath: string;
  readonly serverLayer: Layer.Layer<never, unknown>;
  readonly socketPath: string;
}

const withHostRequestDiagnostic = <A, E, R>(
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

const KojoControlHandlers = KojoControl.toLayer(
  KojoControl.of({
    Negotiate: (_payload, options) =>
      withHostRequestDiagnostic("Negotiate", String(options.requestId), getHostInformation),
    ListProjects: (_payload, options) =>
      withHostRequestDiagnostic("ListProjects", String(options.requestId), listProjects),
  }),
);

const removeStaleSocket = async (socketPath: string) => {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const makeKojoControlServerLayer = <ProtocolError, ProtocolRequirements>(
  protocol: Layer.Layer<RpcServer.Protocol, ProtocolError, ProtocolRequirements>,
  diagnosticLogger: Layer.Layer<HostDiagnosticLogger>,
) =>
  RpcServer.layer(KojoControl).pipe(
    Layer.provide([KojoControlHandlers.pipe(Layer.provide(diagnosticLogger)), protocol]),
  );

export const startKojoHost = async (options: KojoHostOptions): Promise<KojoHostServer> => {
  const socketDirectory = dirname(options.socketPath);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await chmod(socketDirectory, 0o700);
  await removeStaleSocket(options.socketPath);
  const scope = Effect.runSync(Scope.make());
  const previousUmask = process.umask(0o077);
  try {
    await Effect.runPromise(Layer.buildWithScope(options.serverLayer, scope));
  } finally {
    process.umask(previousUmask);
  }
  await chmod(options.socketPath, 0o600);

  return {
    diagnosticPath: options.diagnosticPath,
    socketPath: options.socketPath,
    stop: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await removeStaleSocket(options.socketPath);
    },
  };
};
