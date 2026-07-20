import { randomUUID } from "node:crypto";
import { chmod, link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeProjectService, type Project, ProjectOperationError } from "./projects";
import { openSystemStore } from "./storage";
import { makeWorkflowRunService, WorkflowStartError } from "./workflow-runs";
import { makeProjectWorkflowRuntime } from "./workflow-runtime";

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
  let workflowRunService: ReturnType<typeof makeWorkflowRunService> | undefined;
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
      store.workflowRuns.interruptRunning();
      projectService = makeProjectService(store);
      workflowRunService = makeWorkflowRunService(
        store,
        makeProjectWorkflowRuntime(store, paths.endpoint),
      );
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
        const workflowRunMatch = url.pathname.match(/^\/v1\/workflow-runs\/([^/]+)$/);
        const workflowBoundaryMatch = url.pathname.match(
          /^\/v1\/workflow-runs\/([^/]+)\/boundaries$/,
        );
        const workflowJournalReadMatch = url.pathname.match(
          /^\/v1\/workflow-runs\/([^/]+)\/journal\/read$/,
        );
        if (url.pathname === "/v1/workflow-runs" && request.method === "POST") {
          try {
            const body = (await request.json()) as {
              fromCheckout?: unknown;
              input?: unknown;
              projectId?: unknown;
              workflowName?: unknown;
            };
            if (
              typeof body.projectId !== "string" ||
              body.projectId.length === 0 ||
              typeof body.workflowName !== "string" ||
              body.workflowName.length === 0 ||
              typeof body.fromCheckout !== "boolean" ||
              !("input" in body)
            ) {
              return Response.json(
                {
                  command: "workflow.start",
                  error: {
                    code: "INVALID_REQUEST",
                    message: "A complete start request is required",
                  },
                  schemaVersion: 1,
                  status: "failed",
                },
                { status: 400 },
              );
            }
            const started = await workflowRunService?.start({
              fromCheckout: body.fromCheckout,
              input: body.input,
              projectId: body.projectId,
              workflowName: body.workflowName,
            });
            return Response.json({
              command: "workflow.start",
              run: started,
              schemaVersion: 1,
              status: "started",
            });
          } catch (error) {
            return workflowFailure("workflow.start", error);
          }
        }
        if (workflowRunMatch !== null && request.method === "GET") {
          const runId = decodeURIComponent(workflowRunMatch[1] ?? "");
          const run = workflowRunService?.inspect(runId);
          if (run === undefined) {
            return Response.json(
              {
                command: "workflow.inspect",
                error: { code: "RUN_NOT_FOUND", message: `Workflow Run ${runId} was not found` },
                schemaVersion: 1,
                status: "failed",
              },
              { status: 404 },
            );
          }
          return Response.json({
            command: "workflow.inspect",
            run,
            schemaVersion: 1,
            status: "succeeded",
          });
        }
        if (workflowBoundaryMatch !== null && request.method === "POST") {
          try {
            const runId = decodeURIComponent(workflowBoundaryMatch[1] ?? "");
            const body = (await request.json()) as {
              attempt?: unknown;
              completionIdempotencyKey?: unknown;
              idempotencyKey?: unknown;
              leaseGeneration?: unknown;
              leaseHolder?: unknown;
              operation?: unknown;
              payload?: unknown;
              projectId?: unknown;
              rootRunId?: unknown;
              subject?: unknown;
            };
            if (
              !Number.isInteger(body.attempt) ||
              (body.attempt as number) <= 0 ||
              !Number.isInteger(body.leaseGeneration) ||
              (body.leaseGeneration as number) <= 0 ||
              typeof body.leaseHolder !== "string" ||
              typeof body.idempotencyKey !== "string" ||
              typeof body.operation !== "string" ||
              typeof body.projectId !== "string" ||
              typeof body.rootRunId !== "string" ||
              typeof body.subject !== "string" ||
              !("payload" in body)
            ) {
              return Response.json({ error: "Invalid durable boundary" }, { status: 400 });
            }
            const scope = {
              attempt: body.attempt as number,
              idempotencyKey: body.idempotencyKey,
              leaseGeneration: body.leaseGeneration as number,
              leaseHolder: body.leaseHolder,
              payload: body.payload,
              projectId: body.projectId,
              rootRunId: body.rootRunId,
              runId,
              subject: body.subject,
            };
            if (body.operation === "Activity.Started") {
              if (typeof body.completionIdempotencyKey !== "string") {
                return Response.json({ error: "Invalid Activity claim" }, { status: 400 });
              }
              const claimed = workflowRunService?.claimActivity({
                ...scope,
                completionIdempotencyKey: body.completionIdempotencyKey,
              });
              return Response.json(claimed);
            }
            const event = workflowRunService?.recordBoundary({
              ...scope,
              operation: body.operation,
            });
            return Response.json({ event, status: "recorded" });
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 409 },
            );
          }
        }
        if (workflowJournalReadMatch !== null && request.method === "POST") {
          try {
            const runId = decodeURIComponent(workflowJournalReadMatch[1] ?? "");
            const body = (await request.json()) as {
              attempt?: unknown;
              idempotencyKey?: unknown;
              leaseGeneration?: unknown;
              leaseHolder?: unknown;
              projectId?: unknown;
              rootRunId?: unknown;
            };
            if (
              !Number.isInteger(body.attempt) ||
              (body.attempt as number) <= 0 ||
              !Number.isInteger(body.leaseGeneration) ||
              (body.leaseGeneration as number) <= 0 ||
              typeof body.leaseHolder !== "string" ||
              typeof body.idempotencyKey !== "string" ||
              typeof body.projectId !== "string" ||
              typeof body.rootRunId !== "string"
            ) {
              return Response.json({ error: "Invalid Workflow Journal read" }, { status: 400 });
            }
            const payload = workflowRunService?.readBoundary(
              {
                attempt: body.attempt as number,
                leaseGeneration: body.leaseGeneration as number,
                leaseHolder: body.leaseHolder,
                projectId: body.projectId,
                rootRunId: body.rootRunId,
                runId,
              },
              body.idempotencyKey,
            );
            return Response.json(
              payload === undefined ? { status: "missing" } : { payload, status: "found" },
            );
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 409 },
            );
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

const workflowFailure = (command: string, error: unknown) => {
  const startError = error instanceof WorkflowStartError ? error : undefined;
  const code = startError?.code ?? "WORKFLOW_START_FAILED";
  const status = code === "PROJECT_NOT_FOUND" || code === "WORKFLOW_NOT_FOUND" ? 404 : 400;
  return Response.json(
    {
      command,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(startError?.details === undefined ? {} : { details: startError.details }),
      },
      schemaVersion: 1,
      status: "failed",
    },
    { status },
  );
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
