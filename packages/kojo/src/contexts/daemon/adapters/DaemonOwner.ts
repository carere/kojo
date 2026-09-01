import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
  removeOwnedPlainFile,
  removeOwnedSocket,
} from "../services/secureHostPath.ts";

interface LockHandle {
  readonly unlock: () => void;
}

const acquireLock = (path: string): LockHandle => {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(descriptor, 0o600);
  const stat = fstatSync(descriptor);
  if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile()) {
    closeSync(descriptor);
    throw new LifecycleError("UNSAFE_SINGLETON", "the singleton lock has unsafe ownership");
  }

  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const locked = library.symbols.flock(descriptor, 2 | 4);
  if (locked !== 0) {
    library.close();
    closeSync(descriptor);
    throw new LifecycleError("DAEMON_ALREADY_RUNNING", "another Daemon owns this data root");
  }
  return {
    unlock: () => {
      library.symbols.flock(descriptor, 8);
      library.close();
      closeSync(descriptor);
    },
  };
};

export interface RunningDaemon {
  readonly endpoint: DaemonEndpoint;
  readonly stopped: Promise<void>;
  readonly stop: () => Promise<void>;
}

const retainedDirectories = [
  "revisions",
  "objects",
  "staging",
  "artifacts",
  "sessions",
  "worktrees",
  "client-requests",
  "lifecycle",
] as const;

const currentEndpointIs = (path: string, instanceId: string): boolean => {
  try {
    assertPrivateNode(path, "file");
    return (
      (JSON.parse(readFileSync(path, "utf8")) as { readonly instanceId?: string }).instanceId ===
      instanceId
    );
  } catch {
    return false;
  }
};

export const startDaemon = (paths: DaemonPaths): RunningDaemon => {
  ensurePrivateDirectory(paths.dataRoot);
  for (const directory of retainedDirectories)
    ensurePrivateDirectory(join(paths.dataRoot, directory));
  const lock = acquireLock(join(paths.dataRoot, "daemon.lock"));
  const databasePath = join(paths.dataRoot, "kojo.db");
  const runtimeEndpoint = join(paths.runtimeRoot, "endpoint.json");
  const socketPath = join(paths.runtimeRoot, "daemon.sock");
  let database: Database | undefined;
  let server: Bun.Server<unknown> | undefined;

  try {
    if (existsSync(databasePath)) assertPrivateNode(databasePath, "file");
    database = new Database(databasePath, { create: true, strict: true });
    chmodSync(databasePath, 0o600);
    database.run(
      "CREATE TABLE IF NOT EXISTS daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    );
    const existing = database
      .query<{ readonly value: string }, []>(
        "SELECT value FROM daemon_metadata WHERE name = 'data_identity'",
      )
      .get();
    const dataIdentity = existing?.value ?? crypto.randomUUID();
    if (existing === null) {
      database.run("INSERT INTO daemon_metadata (name, value) VALUES ('data_identity', ?)", [
        dataIdentity,
      ]);
    }

    ensurePrivateDirectory(paths.runtimeRoot);
    removeOwnedPlainFile(runtimeEndpoint);
    removeOwnedSocket(socketPath);

    const endpoint: DaemonEndpoint = {
      formatVersion: 1,
      dataIdentity,
      instanceId: crypto.randomUUID(),
      socketPath,
      ready: true,
    };
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/ready") {
          return Response.json(endpoint);
        }
        return new Response("not found", { status: 404 });
      },
    });
    chmodSync(socketPath, 0o600);
    atomicPrivateFile(runtimeEndpoint, `${JSON.stringify(endpoint)}\n`);

    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (stopping !== undefined) return stopping;
      stopping = Promise.resolve().then(() => {
        server?.stop(true);
        database?.close(false);
        if (currentEndpointIs(runtimeEndpoint, endpoint.instanceId)) {
          removeOwnedPlainFile(runtimeEndpoint);
          removeOwnedSocket(socketPath);
        }
        lock.unlock();
        resolveStopped?.();
      });
      return stopping;
    };
    return { endpoint, stopped, stop };
  } catch (cause) {
    server?.stop(true);
    database?.close(false);
    lock.unlock();
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError("DAEMON_START_FAILED", "the Daemon could not become ready", cause);
  }
};
