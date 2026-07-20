import { randomUUID } from "node:crypto";
import { chmod, link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeProjectService, type Project, ProjectOperationError } from "./projects";
import { openSystemStore } from "./storage";

export interface ProcessDetails {
  readonly endpoint: string;
  readonly pid: number;
}

interface LockRecord {
  readonly endpoint?: string;
  readonly phase: "ready" | "starting";
  readonly pid: number;
  readonly token: string;
}

export const systemPaths = (home: string) => ({
  launchLock: join(home, "launch.lock"),
  lock: join(home, "system.lock"),
  log: join(home, "system.log"),
  endpoint: join(home, "system.sock"),
  startupError: join(home, "startup-error.json"),
});

export const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const decodeLockRecord = (value: string): LockRecord | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<LockRecord>;
    if (
      !Number.isInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      (parsed.phase !== "ready" && parsed.phase !== "starting") ||
      (parsed.phase === "ready" &&
        (typeof parsed.endpoint !== "string" || parsed.endpoint.length === 0)) ||
      (parsed.phase === "starting" && parsed.endpoint !== undefined)
    ) {
      throw new Error("Kojo Home lock record is invalid");
    }
    return parsed as LockRecord;
  } catch (error) {
    if (error instanceof Error && error.message === "Kojo Home lock record is invalid") {
      throw error;
    }
    throw new Error("Kojo Home lock record is invalid");
  }
};

export const readLockRecord = async (home: string): Promise<LockRecord | undefined> => {
  try {
    return decodeLockRecord(await readFile(systemPaths(home).lock, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

export const pingSystem = async (details: ProcessDetails): Promise<boolean> => {
  try {
    const response = await fetch("http://localhost/status", {
      signal: AbortSignal.timeout(500),
      unix: details.endpoint,
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const inspectSystem = async (home: string): Promise<ProcessDetails | undefined> => {
  const record = await readLockRecord(home);
  if (record?.phase !== "ready" || record.endpoint === undefined || !isProcessAlive(record.pid)) {
    return undefined;
  }
  const details = { endpoint: record.endpoint, pid: record.pid };
  return (await pingSystem(details)) ? details : undefined;
};

const writeExclusiveLockRecord = async (path: string, record: LockRecord) => {
  const candidate = `${path}.${record.pid}.${record.token}.tmp`;
  await writeFile(candidate, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  try {
    await link(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
};

const replaceLockRecord = async (path: string, record: LockRecord) => {
  const candidate = `${path}.${record.pid}.${record.token}.next`;
  await writeFile(candidate, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  try {
    await rename(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
};

const releaseSystemLock = async (home: string, token: string) => {
  const owner = await readLockRecord(home).catch(() => undefined);
  if (owner?.token === token) {
    await rm(systemPaths(home).lock, { force: true });
  }
};

const acquireSystemLock = async (home: string) => {
  const lockPath = systemPaths(home).lock;
  const record = {
    phase: "starting",
    pid: process.pid,
    token: randomUUID(),
  } satisfies LockRecord;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusiveLockRecord(lockPath, record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = await readLockRecord(home);
      if (owner === undefined) {
        throw new Error("Kojo Home lock exists but its owner cannot be read");
      }
      if (isProcessAlive(owner.pid)) {
        throw new Error(`Kojo Home is locked by System Process ${owner.pid}`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("Kojo Home lock could not be acquired");
};

export const runSystemProcess = async (home: string): Promise<void> => {
  const paths = systemPaths(home);
  let ownsLock = false;
  let store: Awaited<ReturnType<typeof openSystemStore>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let endpointReady = false;
  let lockToken: string | undefined;
  let projectService: ReturnType<typeof makeProjectService> | undefined;
  let resolveStopped: (() => void) | undefined;

  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const cleanup = async () => {
    server?.stop(true);
    try {
      store?.close();
    } finally {
      await rm(paths.endpoint, { force: true });
      if (lockToken !== undefined) {
        await releaseSystemLock(home, lockToken);
      }
    }
  };

  try {
    const authority = await acquireSystemLock(home);
    lockToken = authority.token;
    ownsLock = true;
    try {
      store = await openSystemStore(home);
      projectService = makeProjectService(store);
    } catch (error) {
      throw new Error(
        `state.sqlite initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (paths.endpoint.length > 100) {
      throw new Error("Kojo Home path is too long for its private local endpoint");
    }
    await rm(paths.endpoint, { force: true });
    server = Bun.serve({
      async fetch(request) {
        if (!endpointReady) {
          return Response.json({ status: "starting" }, { status: 503 });
        }
        const url = new URL(request.url);
        if (url.pathname === "/status") {
          return Response.json({ service: "kojo", status: "ok" });
        }
        if (url.pathname === "/stop" && request.method === "POST") {
          setTimeout(() => resolveStopped?.(), 10);
          return Response.json({ status: "stopping" });
        }
        const projectMatch = url.pathname.match(
          /^\/v1\/projects\/([^/]+)\/(enable|disable|relink|archive)$/,
        );
        if (url.pathname === "/v1/projects" && request.method === "GET") {
          const projects = await projectService?.list();
          return Response.json({
            command: "project.list",
            projects: projects ?? [],
            schemaVersion: 1,
            status: "succeeded",
          });
        }
        if (url.pathname === "/v1/projects" && request.method === "POST") {
          try {
            const body = (await request.json()) as { path?: unknown };
            if (typeof body.path !== "string" || body.path.length === 0) {
              return Response.json(
                {
                  command: "project.add",
                  error: { code: "INVALID_REQUEST", message: "Project path is required" },
                  schemaVersion: 1,
                  status: "failed",
                },
                { status: 400 },
              );
            }
            const project = await projectService?.add(body.path);
            return Response.json({
              command: "project.add",
              project,
              schemaVersion: 1,
              status: "created",
            });
          } catch (error) {
            return projectFailure("project.add", error);
          }
        }
        if (projectMatch !== null && request.method === "POST") {
          const [, encodedId, operation] = projectMatch;
          const id = decodeURIComponent(encodedId ?? "");
          const command = `project.${operation}`;
          try {
            const service = projectService;
            if (service === undefined) {
              throw new Error("Project service is unavailable");
            }
            let project: Project;
            if (operation === "relink") {
              const body = (await request.json()) as { path?: unknown };
              if (typeof body.path !== "string" || body.path.length === 0) {
                return Response.json(
                  {
                    command,
                    error: { code: "INVALID_REQUEST", message: "Project path is required" },
                    schemaVersion: 1,
                    status: "failed",
                  },
                  { status: 400 },
                );
              }
              project = await service.relink(id, body.path);
            } else if (operation === "enable") {
              project = await service.enable(id);
            } else if (operation === "disable") {
              project = await service.disable(id);
            } else {
              project = await service.archive(id);
            }
            return Response.json({
              command,
              project,
              schemaVersion: 1,
              status:
                operation === "enable"
                  ? "enabled"
                  : operation === "relink"
                    ? "relinked"
                    : `${operation}d`,
            });
          } catch (error) {
            return projectFailure(command, error);
          }
        }
        return new Response("Not found", { status: 404 });
      },
      unix: paths.endpoint,
    });
    await chmod(paths.endpoint, 0o600);
    const details = {
      endpoint: paths.endpoint,
      phase: "ready",
      pid: process.pid,
      token: authority.token,
    } satisfies LockRecord;
    await replaceLockRecord(paths.lock, details);
    await rm(paths.startupError, { force: true });
    endpointReady = true;
    console.log(
      JSON.stringify({
        endpoint: details.endpoint,
        event: "system-ready",
        phase: details.phase,
        pid: details.pid,
      }),
    );

    const requestStop = () => resolveStopped?.();
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    await stopped;
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  } catch (error) {
    const failure = {
      code: "SYSTEM_STARTUP_FAILED",
      message: error instanceof Error ? error.message : String(error),
      schemaVersion: 1,
    };
    await writeFile(paths.startupError, JSON.stringify(failure), { mode: 0o600 });
    console.error(JSON.stringify(failure));
    throw error;
  } finally {
    if (ownsLock) {
      await cleanup();
    }
  }
};

const projectFailure = (command: string, error: unknown) => {
  const operationError = error instanceof ProjectOperationError ? error : undefined;
  const code = operationError?.code ?? "PROJECT_COMMAND_FAILED";
  const status =
    code === "PROJECT_NOT_FOUND" ? 404 : code === "PROJECT_ALREADY_REGISTERED" ? 409 : 400;
  return Response.json(
    {
      command,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(operationError?.reasons === undefined ? {} : { reasons: operationError.reasons }),
      },
      schemaVersion: 1,
      status: "failed",
    },
    { status },
  );
};
