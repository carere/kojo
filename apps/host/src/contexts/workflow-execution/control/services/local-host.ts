import { chmod, unlink } from "node:fs/promises";
import type { ControlRequest } from "@kojo/control";
import { Effect } from "effect";
import { getHostInformation } from "../use-cases/get-host-information";
import { listProjects } from "../use-cases/list-projects";

export interface KojoHostServer {
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

export interface KojoHostOptions {
  readonly socketPath: string;
}

const removeStaleSocket = async (socketPath: string) => {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const handleRequest = (request: ControlRequest): Promise<unknown> => {
  switch (request.operation) {
    case "negotiate":
      return Effect.runPromise(getHostInformation);
    case "projects.list":
      return Effect.runPromise(listProjects);
  }
};

const decodeRequest = (value: unknown): ControlRequest | undefined => {
  if (typeof value !== "object" || value === null || !("operation" in value)) {
    return undefined;
  }

  const operation = value.operation;
  return operation === "negotiate" || operation === "projects.list" ? { operation } : undefined;
};

export const startKojoHost = async (options: KojoHostOptions): Promise<KojoHostServer> => {
  await removeStaleSocket(options.socketPath);

  const server = Bun.listen<{ buffer: string }>({
    unix: options.socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      data(socket, bytes) {
        socket.data.buffer += new TextDecoder().decode(bytes);

        let newline = socket.data.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = socket.data.buffer.slice(0, newline);
          socket.data.buffer = socket.data.buffer.slice(newline + 1);
          void Promise.resolve()
            .then(() => decodeRequest(JSON.parse(line)))
            .then((request) => {
              if (request === undefined) throw new Error("Unsupported request");
              return handleRequest(request);
            })
            .then((response) => socket.write(`${JSON.stringify(response)}\n`))
            .catch(() =>
              socket.write(
                `${JSON.stringify({ error: { code: "invalid-request", message: "Invalid control request." } })}\n`,
              ),
            );
          newline = socket.data.buffer.indexOf("\n");
        }
      },
    },
  });

  await chmod(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    stop: async () => {
      server.stop(true);
      await removeStaleSocket(options.socketPath);
    },
  };
};
