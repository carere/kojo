import { chmod, unlink } from "node:fs/promises";
import { BunSocketServer } from "@effect/platform-bun";
import { KojoControl } from "@kojo/control";
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { getHostInformation } from "../use-cases/get-host-information";
import { listProjects } from "../use-cases/list-projects";

export interface KojoHostServer {
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

export interface KojoHostOptions {
  readonly socketPath: string;
}

const KojoControlHandlers = KojoControl.toLayer(
  KojoControl.of({
    Negotiate: () => getHostInformation,
    ListProjects: () => listProjects,
  }),
);

const removeStaleSocket = async (socketPath: string) => {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const makeKojoControlServerLayer = (socketPath: string) => {
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );

  return RpcServer.layer(KojoControl).pipe(Layer.provide([KojoControlHandlers, protocol]));
};

export const startKojoHost = async (options: KojoHostOptions): Promise<KojoHostServer> => {
  await removeStaleSocket(options.socketPath);
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Layer.buildWithScope(makeKojoControlServerLayer(options.socketPath), scope),
  );
  await chmod(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    stop: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await removeStaleSocket(options.socketPath);
    },
  };
};
