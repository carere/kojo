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
import { extname, join } from "node:path";
import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import type {
  BrowserSessionRequest,
  BrowserSessionResponse,
  DaemonDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import { activeConsoleRelease } from "../services/activeConsoleRelease.ts";
import { browserAuthority } from "../services/browserAuthority.ts";
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

  const lockLibrary =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : undefined;
  if (lockLibrary === undefined) {
    closeSync(descriptor);
    throw new LifecycleError("UNSUPPORTED_HOST", "the Host has no supported advisory file lock");
  }
  const library = dlopen(lockLibrary, {
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

export interface StartDaemonOptions {
  readonly consolePort?: number;
  readonly now?: () => number;
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

const noStoreJson = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

const problem = (status: number, code: string, message: string): Response =>
  noStoreJson({ code, message }, status);

const isJson = (request: Request): boolean =>
  request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
  "application/json";

const contentType = (path: string): string => {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
};

const consoleAsset = async (assets: string, pathname: string): Promise<Response> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return problem(400, "invalid-path", "the requested path is invalid");
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return problem(400, "invalid-path", "the requested path is invalid");
  }
  const requested = segments.length === 0 ? "index.html" : join(...segments);
  const selected = extname(requested).length === 0 ? "index.html" : requested;
  const file = Bun.file(join(assets, selected));
  if (!(await file.exists())) return problem(404, "not-found", "the requested asset was not found");
  return new Response(file, {
    headers: {
      "content-type": contentType(selected),
      "x-content-type-options": "nosniff",
    },
  });
};

export const startDaemon = (
  paths: DaemonPaths,
  options: StartDaemonOptions = {},
): RunningDaemon => {
  const release = activeConsoleRelease(paths);
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  ensurePrivateDirectory(paths.dataRoot);
  for (const directory of retainedDirectories)
    ensurePrivateDirectory(join(paths.dataRoot, directory));
  const lock = acquireLock(join(paths.dataRoot, "daemon.lock"));
  const databasePath = join(paths.dataRoot, "kojo.db");
  const runtimeEndpoint = join(paths.runtimeRoot, "endpoint.json");
  const socketPath = join(paths.runtimeRoot, "daemon.sock");
  let database: Database | undefined;
  let socketServer: Bun.Server<unknown> | undefined;
  let consoleServer: Bun.Server<unknown> | undefined;

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

    const instanceId = crypto.randomUUID();
    const authority = browserAuthority({ now });
    consoleServer = Bun.serve({
      hostname: "127.0.0.1",
      port: options.consolePort ?? 0,
      async fetch(request) {
        const expectedHost = `127.0.0.1:${consoleServer?.port ?? 0}`;
        const origin = `http://${expectedHost}`;
        if (request.headers.get("host") !== expectedHost) {
          return problem(421, "wrong-host", "the request Host does not match this Console");
        }

        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/_kojo/compat") {
          const body: BootstrapResponse = {
            bootstrapVersion: 1,
            instanceId,
            dataIdentity,
            clientApiVersions: [1],
            features: ["browser-session", "empty-daemon"],
            packageVersion: release.packageVersion,
          };
          return noStoreJson(body);
        }

        if (url.pathname === "/_kojo/session") {
          if (request.method !== "POST") {
            return problem(405, "method-not-allowed", "the session exchange requires POST");
          }
          if (request.headers.get("origin") !== origin) {
            return problem(403, "wrong-origin", "the request Origin does not match this Console");
          }
          if (!isJson(request)) {
            return problem(415, "json-required", "the session exchange requires JSON");
          }
          let body: BrowserSessionRequest;
          try {
            const bytes = new Uint8Array(await request.arrayBuffer());
            if (bytes.byteLength > 4_096) {
              return problem(413, "request-too-large", "the session exchange is too large");
            }
            const input = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
            if (
              Object.keys(input).length !== 1 ||
              typeof input.grant !== "string" ||
              input.grant.length === 0
            ) {
              throw new Error("invalid grant request");
            }
            body = { grant: input.grant };
          } catch {
            return problem(400, "invalid-json", "the session exchange body is invalid");
          }
          const session = authority.exchange(body.grant, origin);
          if (session === undefined) {
            return problem(401, "grant-refused", "the launch grant is invalid or expired");
          }
          const response: BrowserSessionResponse = {
            formatVersion: 1,
            credential: session.secret,
            expiresAt: new Date(session.expiresAt).toISOString(),
            instanceId,
          };
          return noStoreJson(response);
        }

        if (url.pathname.startsWith("/api/v1/")) {
          const requestOrigin = request.headers.get("origin");
          if (requestOrigin !== null && requestOrigin !== origin) {
            return problem(403, "wrong-origin", "the request Origin does not match this Console");
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            if (requestOrigin !== origin) {
              return problem(403, "origin-required", "a mutation requires this Console Origin");
            }
            if (!isJson(request)) {
              return problem(415, "json-required", "a mutation requires JSON");
            }
            if (Number(request.headers.get("content-length") ?? "0") > 1_048_576) {
              return problem(413, "request-too-large", "the mutation body is too large");
            }
            try {
              const bytes = new Uint8Array(await request.clone().arrayBuffer());
              if (bytes.byteLength > 1_048_576) {
                return problem(413, "request-too-large", "the mutation body is too large");
              }
              JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              return problem(400, "invalid-json", "the mutation body is invalid");
            }
          }
          const session = authority.authenticate(request.headers.get("authorization"));
          if (session === undefined) {
            return problem(401, "session-refused", "Console access is invalid or expired");
          }
          if (request.method === "GET" && url.pathname === "/api/v1/daemon") {
            const body: DaemonDocument = {
              formatVersion: 1,
              instanceId,
              dataIdentity,
              releaseId: release.releaseId,
              packageVersion: release.packageVersion,
              bunVersion: release.bunVersion,
              platform: process.platform,
              architecture: process.arch,
              startedAt,
              accessExpiresAt: new Date(session.expiresAt).toISOString(),
              projectCount: 0,
            };
            return noStoreJson(body);
          }
          return problem(404, "not-found", "the requested API resource was not found");
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return problem(405, "method-not-allowed", "static Console content is read-only");
        }
        return consoleAsset(release.assets, url.pathname);
      },
    });
    const consoleOrigin = `http://127.0.0.1:${consoleServer.port}`;
    const endpoint: DaemonEndpoint = {
      formatVersion: 1,
      consoleOrigin,
      dataIdentity,
      instanceId,
      socketPath,
      ready: true,
    };
    socketServer = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/ready") {
          return Response.json(endpoint);
        }
        if (request.method === "POST" && url.pathname === "/ui-grants") {
          const grant = authority.issue(consoleOrigin);
          return noStoreJson({
            expiresAt: new Date(grant.expiresAt).toISOString(),
            launchUrl: `${consoleOrigin}/daemon#grant=${encodeURIComponent(grant.secret)}`,
          });
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
        socketServer?.stop(true);
        consoleServer?.stop(true);
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
    socketServer?.stop(true);
    consoleServer?.stop(true);
    database?.close(false);
    lock.unlock();
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError("DAEMON_START_FAILED", "the Daemon could not become ready", cause);
  }
};
