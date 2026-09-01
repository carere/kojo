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
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import type {
  BrowserSessionRequest,
  BrowserSessionResponse,
  DaemonDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import type { RecordVerdictRequest } from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import {
  decodeJsonValue,
  type JsonValue,
} from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Cause, Effect, Option } from "effect";
import { SqliteDaemonGateRepository } from "../../gate/adapters/SqliteDaemonGateRepository.ts";
import { GateApi } from "../../gate/services/GateApi.ts";
import { SqliteProjectRecoveryRepository } from "../../project/adapters/SqliteProjectRecoveryRepository.ts";
import { SqliteProjectRepository } from "../../project/adapters/SqliteProjectRepository.ts";
import { ProjectApi } from "../../project/services/ProjectApi.ts";
import { SqliteTriggerRepository } from "../../trigger/adapters/SqliteTriggerRepository.ts";
import { SqliteRevisionRepository } from "../../workflow/adapters/SqliteRevisionRepository.ts";
import { SqliteRunRepository } from "../../workflow/adapters/SqliteRunRepository.ts";
import { RevisionCaptureError } from "../../workflow/models/RevisionCaptureError.ts";
import { RunApi } from "../../workflow/services/RunApi.ts";
import { refreshFactory } from "../../workflow/services/refreshFactory.ts";
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
import { HostClientRequestJournal } from "./HostClientRequestJournal.ts";

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
  readonly stopped: Effect.Effect<void, LifecycleError>;
  readonly stop: Effect.Effect<void, LifecycleError>;
}

export interface StartDaemonOptions {
  readonly consolePort?: number;
  readonly now?: () => number;
  readonly automaticRefresh?: boolean;
  readonly runnerIdleMillis?: number;
  readonly runnerCleanupMillis?: number;
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

const requestJson = async (request: Request): Promise<unknown> => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 1_048_576) {
    throw new LifecycleError("REQUEST_TOO_LARGE", "the request body is too large");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

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
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
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
    const projectRepository = new SqliteProjectRepository(database);
    const projectRecoveryRepository = new SqliteProjectRecoveryRepository(database);
    const runRepository = new SqliteRunRepository(database);
    const revisionRepository = new SqliteRevisionRepository(database, paths.dataRoot);
    const triggerRepository = new SqliteTriggerRepository(database);
    const gateRepository = new SqliteDaemonGateRepository(database);
    const projectApi = new ProjectApi({
      dataIdentity,
      instanceId,
      journal: new HostClientRequestJournal(join(paths.dataRoot, "client-requests")),
      now,
      repository: projectRepository,
      dataRoot: paths.dataRoot,
    });
    const runApi = new RunApi({
      dataIdentity,
      instanceId,
      dataRoot: paths.dataRoot,
      now,
      projects: projectRepository,
      projectRecovery: projectRecoveryRepository,
      runs: runRepository,
      revisions: revisionRepository,
      triggers: triggerRepository,
      gates: gateRepository,
      ...(options.runnerIdleMillis === undefined
        ? {}
        : { runnerIdleMillis: options.runnerIdleMillis }),
      ...(options.runnerCleanupMillis === undefined
        ? {}
        : { runnerCleanupMillis: options.runnerCleanupMillis }),
    });
    void Effect.runPromise(runApi.restore()).catch(() => undefined);
    const gateApi = new GateApi({
      dataIdentity,
      instanceId,
      now,
      repository: gateRepository,
      runs: runApi,
    });
    const ownerDatabase = database;
    const revisionResponse = async (
      request: Request,
      url: URL,
      allowMaintenance: boolean,
    ): Promise<Response | undefined> => {
      const matched = url.pathname.match(
        /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})(\/actions\/(repair|collect))?$/,
      );
      if (matched === null) return undefined;
      const projectId = matched[1] ?? "invalid";
      const revisionId = matched[2] ?? "invalid";
      const registered = ownerDatabase
        .query<{ readonly found: number }, [string, string]>(
          `SELECT 1 AS found FROM workflow_revision_registrations
            WHERE project_id = ? AND revision_id = ? LIMIT 1`,
        )
        .get(projectId, revisionId);
      if (registered === null) {
        return problem(404, "revision-not-found", "the selected Workflow Revision was not found");
      }
      try {
        if (request.method === "GET" && matched[3] === undefined) {
          return noStoreJson(
            await Effect.runPromise(
              revisionRepository.details(revisionId, new Date(now()).toISOString()),
            ),
          );
        }
        if (!allowMaintenance) {
          return problem(
            405,
            "cli-maintenance-required",
            "exact-content repair and collection are available only through the private CLI",
          );
        }
        if (request.method === "POST" && matched[4] === "repair") {
          const body = await requestJson(request);
          if (
            body === null ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            typeof (body as { readonly from?: unknown }).from !== "string"
          ) {
            return problem(400, "invalid-repair", "exact revision repair requires one source path");
          }
          return noStoreJson(
            await Effect.runPromise(
              revisionRepository.repairExact(
                revisionId,
                (body as { readonly from: string }).from,
                new Date(now()).toISOString(),
              ),
            ),
          );
        }
        if (request.method === "POST" && matched[4] === "collect") {
          return noStoreJson(
            await Effect.runPromise(
              revisionRepository.collect(revisionId, new Date(now()).toISOString()),
            ),
          );
        }
        return problem(405, "method-not-allowed", "the revision action does not allow this method");
      } catch (cause) {
        return problem(
          409,
          "revision-maintenance-refused",
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    };
    const gateSnapshot = async (projectId?: string): Promise<Response> =>
      noStoreJson(await Effect.runPromise(gateApi.snapshot(projectId)));
    const answerGate = async (
      request: Request,
      clientSuppliesAnswerer: boolean,
    ): Promise<Response> => {
      let input: RecordVerdictRequest;
      try {
        const value = await requestJson(request);
        if (value === null || typeof value !== "object" || Array.isArray(value))
          return problem(400, "invalid-verdict", "the Verdict request must be a JSON object");
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) =>
              key !== "requestId" &&
              key !== "dataIdentity" &&
              key !== "token" &&
              key !== "choice" &&
              key !== "reason" &&
              key !== "answerer",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string" ||
          typeof record.token !== "string" ||
          typeof record.choice !== "string" ||
          typeof record.reason !== "string" ||
          (record.answerer !== undefined && typeof record.answerer !== "string")
        ) {
          return problem(400, "invalid-verdict", "the Verdict request has invalid fields");
        }
        input = {
          requestId: record.requestId,
          dataIdentity: record.dataIdentity,
          token: record.token,
          choice: record.choice,
          reason: record.reason,
          ...(clientSuppliesAnswerer && typeof record.answerer === "string"
            ? { answerer: record.answerer }
            : {}),
        };
      } catch {
        return problem(400, "invalid-json", "the Verdict request body is invalid");
      }
      const result = await Effect.runPromiseExit(gateApi.record(input));
      if (result._tag === "Success") return noStoreJson(result.value);
      const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause)) as
        | { readonly code?: string; readonly message?: string }
        | undefined;
      if (failure?.code === "DEADLINE_PASSED")
        return problem(409, "deadline-passed", "the Verdict was not recorded before the Deadline");
      if (failure?.code === "ASKING_NOT_FOUND")
        return problem(404, "asking-not-found", "the Gate token was not found");
      return problem(409, "verdict-refused", failure?.message ?? Cause.pretty(result.cause));
    };
    void Effect.runPromise(gateApi.expireDue()).catch(() => undefined);
    const gateDeadlineTimer = setInterval(() => {
      void Effect.runPromise(gateApi.expireDue()).catch(() => undefined);
    }, 100);
    const startRun = async (
      request: Request,
      projectId: string,
      workflowName: string,
    ): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-start", "the Start request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) => key !== "requestId" && key !== "dataIdentity" && key !== "payload",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string"
        ) {
          return problem(400, "invalid-start", "the Start request has invalid fields");
        }
        let payloadValue: JsonValue | undefined;
        if ("payload" in record) {
          const payload = decodeJsonValue(record.payload);
          if (!payload.ok) return problem(400, "invalid-payload", "the payload is not JSON");
          payloadValue = payload.value;
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.startWorkflow({
              projectId,
              workflowName,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
              ...(payloadValue === undefined ? {} : { payload: payloadValue }),
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "start-refused",
          cause instanceof Error ? cause.message : "the Run was not admitted",
        );
      }
    };
    const stopWorkflow = async (
      request: Request,
      projectId: string,
      workflowName: string,
    ): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-stop", "the Stop request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) => key !== "requestId" && key !== "dataIdentity" && key !== "force",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string" ||
          ("force" in record && typeof record.force !== "boolean")
        ) {
          return problem(400, "invalid-stop", "the Stop request has invalid fields");
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.stopWorkflow({
              projectId,
              workflowName,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
              ...(record.force === true ? { force: true } : {}),
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "stop-refused",
          cause instanceof Error ? cause.message : "the Workflow was not stopped",
        );
      }
    };
    const cancelRun = async (request: Request, runId: string): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-cancel", "the cancellation request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => key !== "requestId" && key !== "dataIdentity") ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string"
        ) {
          return problem(400, "invalid-cancel", "the cancellation request has invalid fields");
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.cancelRun({
              runId,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "cancel-refused",
          cause instanceof Error ? cause.message : "the Run cancellation was refused",
        );
      }
    };
    const repairProjectRunner = async (projectId: string): Promise<Response> => {
      const project = (await Effect.runPromise(projectRepository.projects)).find(
        (candidate) => candidate.projectId === projectId,
      );
      if (project === undefined) {
        return problem(404, "project-not-found", "the selected Project was not found");
      }
      try {
        return noStoreJson(await Effect.runPromise(runApi.repairProject(projectId)), 202);
      } catch (cause) {
        return problem(
          409,
          "project-repair-refused",
          cause instanceof Error ? cause.message : "Project repair was refused",
        );
      }
    };
    let refreshCoordinatorStopped = false;
    const refreshFingerprints = new Map<string, string>();
    const projectRefreshes = new Map<string, Promise<void>>();
    const inventoryFingerprint = (location: string): string => {
      const hasher = new Bun.CryptoHasher("sha256");
      const visit = (directory: string): void => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          const path = join(directory, entry.name);
          const stat = statSync(path);
          hasher.update(`${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\n`);
          if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
        }
      };
      visit(join(location, ".kojo"));
      for (const name of ["package.json", "bun.lock", "bun.lockb"]) {
        const path = join(location, name);
        if (existsSync(path)) {
          const stat = statSync(path);
          hasher.update(`${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\n`);
        }
      }
      return hasher.digest("hex");
    };
    const refreshProject = (project: {
      readonly projectId: string;
      readonly location: string;
    }): Promise<void> => {
      const current = projectRefreshes.get(project.projectId);
      if (current !== undefined) return current;
      const running = (async () => {
        await Effect.runPromise(projectRepository.markRefreshPending(project.projectId));
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (refreshCoordinatorStopped) return;
        try {
          const refreshed = await Effect.runPromise(
            refreshFactory({
              project: project.location,
              dataRoot: paths.dataRoot,
            }),
          );
          await Effect.runPromise(
            projectRepository.refresh(
              project.projectId,
              refreshed,
              "current",
              new Date(now()).toISOString(),
            ),
          );
          refreshFingerprints.set(project.projectId, inventoryFingerprint(project.location));
        } catch (cause) {
          const error =
            cause instanceof RevisionCaptureError
              ? cause
              : new RevisionCaptureError({
                  code: "CAPTURE_FAILED",
                  message: cause instanceof Error ? cause.message : String(cause),
                  remedy: "Repair the operational fault, then retry Factory Refresh.",
                  cause,
                });
          await Effect.runPromise(
            projectRepository.refresh(
              project.projectId,
              {
                factoryState: existsSync(join(project.location, ".kojo")) ? "available" : "missing",
                workflows: [],
                fault: error.message,
                remedy: error.remedy,
              },
              error.code === "REFRESH_UNSTABLE" ? "pending" : "failed",
              new Date(now()).toISOString(),
            ),
          );
        }
      })().finally(() => projectRefreshes.delete(project.projectId));
      projectRefreshes.set(project.projectId, running);
      return running;
    };
    const inspectProjectInventories = async (force: boolean): Promise<void> => {
      const projects = await Effect.runPromise(projectRepository.activeProjects);
      await Promise.all(
        projects.map(async (project) => {
          let fingerprint: string;
          try {
            fingerprint = inventoryFingerprint(project.location);
          } catch {
            fingerprint = "unreadable";
          }
          if (force || refreshFingerprints.get(project.projectId) !== fingerprint) {
            await refreshProject(project);
          }
        }),
      );
    };
    if (options.automaticRefresh !== false) void inspectProjectInventories(true);
    const refreshInventoryTimer = setInterval(() => {
      if (!refreshCoordinatorStopped && options.automaticRefresh !== false)
        void inspectProjectInventories(false);
    }, 5_000);
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
            features: [
              "browser-session",
              "project-catalogue",
              "workflow-revisions",
              "no-trigger-runs",
              "trigger-scheduling",
              "gate-verdicts",
              "client-request-journal",
            ],
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
            const projects = await Effect.runPromise(projectRepository.projects);
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
              projectCount: projects.length,
            };
            return noStoreJson(body);
          }
          const revision = await revisionResponse(request, url, false);
          if (revision !== undefined) return revision;
          if (request.method === "GET" && url.pathname === "/api/v1/projects") {
            return Effect.runPromise(projectApi.snapshot());
          }
          if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
            return Effect.runPromise(projectApi.workflowSnapshot());
          }
          if (request.method === "GET" && url.pathname === "/api/v1/runs") {
            return noStoreJson(await Effect.runPromise(runApi.snapshot()));
          }
          if (request.method === "GET" && url.pathname === "/api/v1/askings") {
            return gateSnapshot();
          }
          if (request.method === "POST" && url.pathname === "/api/v1/gate-answers") {
            return answerGate(request, false);
          }
          const cancelOneRun = url.pathname.match(
            /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/cancel$/,
          );
          if (request.method === "POST" && cancelOneRun !== null) {
            return cancelRun(request, cancelOneRun[1] ?? "invalid");
          }
          const repairOneProject = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/repair$/,
          );
          if (request.method === "POST" && repairOneProject !== null) {
            return repairProjectRunner(repairOneProject[1] ?? "invalid");
          }
          const projectAskings = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/askings$/,
          );
          if (request.method === "GET" && projectAskings !== null) {
            return gateSnapshot(projectAskings[1]);
          }
          const oneRun = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)$/);
          if (request.method === "GET" && oneRun !== null) {
            const run = await Effect.runPromise(runApi.run(oneRun[1] ?? "invalid"));
            return run === undefined
              ? problem(404, "run-not-found", "the selected Run was not found")
              : noStoreJson(run);
          }
          const projectRuns = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/runs$/);
          if (request.method === "GET" && projectRuns !== null) {
            return noStoreJson(await Effect.runPromise(runApi.snapshot(projectRuns[1])));
          }
          const workflowStart = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/start$/,
          );
          if (request.method === "POST" && workflowStart !== null) {
            return startRun(
              request,
              workflowStart[1] ?? "invalid",
              decodeURIComponent(workflowStart[2] ?? "invalid"),
            );
          }
          const workflowStop = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/stop$/,
          );
          if (request.method === "POST" && workflowStop !== null) {
            return stopWorkflow(
              request,
              workflowStop[1] ?? "invalid",
              decodeURIComponent(workflowStop[2] ?? "invalid"),
            );
          }
          const projectWorkflows = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows$/,
          );
          if (request.method === "GET" && projectWorkflows !== null) {
            return Effect.runPromise(projectApi.workflowSnapshot(projectWorkflows[1]));
          }
          const clientRequest = url.pathname.match(
            /^\/api\/v1\/client-requests\/([A-Za-z0-9_-]+)(\/retry)?$/,
          );
          if (clientRequest !== null) {
            const requestId = clientRequest[1] ?? "invalid";
            if (request.method === "GET" && clientRequest[2] === undefined) {
              return Effect.runPromise(projectApi.lookup(requestId));
            }
            if (request.method === "PUT" && clientRequest[2] === undefined) {
              try {
                return Effect.runPromise(projectApi.prepare(requestId, await requestJson(request)));
              } catch {
                return problem(400, "invalid-json", "the mutation body is invalid");
              }
            }
            if (request.method === "POST" && clientRequest[2] === "/retry") {
              return Effect.runPromise(projectApi.retry(requestId));
            }
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
      async fetch(request) {
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
        const revision = await revisionResponse(request, url, true);
        if (revision !== undefined) return revision;
        if (request.method === "GET" && url.pathname === "/api/v1/projects") {
          return Effect.runPromise(projectApi.snapshot());
        }
        if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
          return Effect.runPromise(projectApi.workflowSnapshot());
        }
        if (request.method === "GET" && url.pathname === "/api/v1/runs") {
          return noStoreJson(await Effect.runPromise(runApi.snapshot()));
        }
        if (request.method === "GET" && url.pathname === "/api/v1/askings") {
          return gateSnapshot();
        }
        if (request.method === "POST" && url.pathname === "/api/v1/gate-answers") {
          if (!isJson(request)) return problem(415, "json-required", "Gate answer requires JSON");
          return answerGate(request, true);
        }
        const cancelOneRun = url.pathname.match(
          /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/cancel$/,
        );
        if (request.method === "POST" && cancelOneRun !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Cancel requires JSON");
          return cancelRun(request, cancelOneRun[1] ?? "invalid");
        }
        const repairOneProject = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/repair$/,
        );
        if (request.method === "POST" && repairOneProject !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Repair requires JSON");
          return repairProjectRunner(repairOneProject[1] ?? "invalid");
        }
        const projectAskings = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/askings$/,
        );
        if (request.method === "GET" && projectAskings !== null) {
          return gateSnapshot(projectAskings[1]);
        }
        const oneRun = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)$/);
        if (request.method === "GET" && oneRun !== null) {
          const run = await Effect.runPromise(runApi.run(oneRun[1] ?? "invalid"));
          return run === undefined
            ? problem(404, "run-not-found", "the selected Run was not found")
            : noStoreJson(run);
        }
        const projectRuns = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/runs$/);
        if (request.method === "GET" && projectRuns !== null) {
          return noStoreJson(await Effect.runPromise(runApi.snapshot(projectRuns[1])));
        }
        const workflowStart = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/start$/,
        );
        if (request.method === "POST" && workflowStart !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Start requires JSON");
          return startRun(
            request,
            workflowStart[1] ?? "invalid",
            decodeURIComponent(workflowStart[2] ?? "invalid"),
          );
        }
        const workflowStop = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/stop$/,
        );
        if (request.method === "POST" && workflowStop !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Stop requires JSON");
          return stopWorkflow(
            request,
            workflowStop[1] ?? "invalid",
            decodeURIComponent(workflowStop[2] ?? "invalid"),
          );
        }
        const projectWorkflows = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows$/,
        );
        if (request.method === "GET" && projectWorkflows !== null) {
          return Effect.runPromise(projectApi.workflowSnapshot(projectWorkflows[1]));
        }
        const clientRequest = url.pathname.match(
          /^\/api\/v1\/client-requests\/([A-Za-z0-9_-]+)(\/retry)?$/,
        );
        if (clientRequest !== null) {
          const requestId = clientRequest[1] ?? "invalid";
          if (request.method === "GET" && clientRequest[2] === undefined) {
            return Effect.runPromise(projectApi.lookup(requestId));
          }
          if (request.method === "PUT" && clientRequest[2] === undefined) {
            if (!isJson(request)) return problem(415, "json-required", "the request requires JSON");
            try {
              return Effect.runPromise(projectApi.prepare(requestId, await requestJson(request)));
            } catch {
              return problem(400, "invalid-json", "the mutation body is invalid");
            }
          }
          if (request.method === "POST" && clientRequest[2] === "/retry") {
            return Effect.runPromise(projectApi.retry(requestId));
          }
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
    const stopPromise = (): Promise<void> => {
      if (stopping !== undefined) return stopping;
      stopping = Promise.resolve().then(async () => {
        refreshCoordinatorStopped = true;
        clearInterval(refreshInventoryTimer);
        clearInterval(gateDeadlineTimer);
        socketServer?.stop(true);
        consoleServer?.stop(true);
        await Promise.allSettled([...projectRefreshes.values()]);
        await Effect.runPromise(runApi.shutdown());
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
    const surfaceFailure = (cause: unknown): LifecycleError =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "DAEMON_STOP_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          );
    return {
      endpoint,
      stopped: Effect.tryPromise({ try: () => stopped, catch: surfaceFailure }),
      stop: Effect.tryPromise({ try: stopPromise, catch: surfaceFailure }),
    };
  } catch (cause) {
    socketServer?.stop(true);
    consoleServer?.stop(true);
    database?.close(false);
    lock.unlock();
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError("DAEMON_START_FAILED", "the Daemon could not become ready", cause);
  }
};
