import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { inspectSystem, isProcessAlive, readLockRecord, systemPaths } from "./process";

const schemaVersion = 1 as const;
const pollInterval = 25;

const pause = (milliseconds: number) =>
  new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));

interface LaunchLockRecord {
  readonly pid: number;
  readonly token: string;
}

const decodeLaunchLockRecord = (value: string): LaunchLockRecord | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<LaunchLockRecord>;
    if (
      !Number.isInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0
    ) {
      return undefined;
    }
    return parsed as LaunchLockRecord;
  } catch {
    return undefined;
  }
};

const createLaunchLock = async (path: string, record: LaunchLockRecord) => {
  const candidate = `${path}.${record.pid}.${record.token}.tmp`;
  await writeFile(candidate, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  try {
    await link(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
};

export const resolveKojoHome = () => {
  const configured = process.env.KOJO_HOME;
  if (configured === undefined || configured.length === 0) {
    return join(homedir(), ".kojo");
  }
  if (!isAbsolute(configured)) {
    throw new Error("KOJO_HOME must be an absolute path");
  }
  return resolve(configured);
};

const withLaunchLock = async <A>(home: string, effect: () => Promise<A>): Promise<A> => {
  await mkdir(home, { mode: 0o700, recursive: true });
  await chmod(home, 0o700);
  const path = systemPaths(home).launchLock;
  const deadline = Date.now() + 10_000;
  const record = { pid: process.pid, token: randomUUID() } satisfies LaunchLockRecord;

  while (true) {
    try {
      await createLaunchLock(path, record);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = decodeLaunchLockRecord(await readFile(path, "utf8").catch(() => ""));
      if (owner === undefined || !isProcessAlive(owner.pid)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Kojo launcher ${owner.pid} to release its lock`);
      }
      await pause(pollInterval);
    }
  }

  try {
    return await effect();
  } finally {
    const owner = decodeLaunchLockRecord(await readFile(path, "utf8").catch(() => ""));
    if (owner?.token === record.token) {
      await rm(path, { force: true });
    }
  }
};

const waitForReady = async (home: string, timeoutSeconds: number) => {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const details = await inspectSystem(home);
    if (details !== undefined) {
      return details;
    }
    try {
      const encodedFailure = await readFile(systemPaths(home).startupError, "utf8");
      let failure: { message?: unknown };
      try {
        failure = JSON.parse(encodedFailure) as { message?: unknown };
      } catch {
        await pause(pollInterval);
        continue;
      }
      if (typeof failure.message === "string") {
        throw new Error(failure.message);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const record = await readLockRecord(home);
    if (record === undefined) {
      await pause(pollInterval);
      continue;
    }
    await pause(pollInterval);
  }
  throw new Error(`System Process did not become available within ${timeoutSeconds} seconds`);
};

const startLocked = async (home: string, command: "restart" | "start") => {
  const running = await inspectSystem(home);
  if (running !== undefined) {
    return {
      command,
      home,
      process: running,
      schemaVersion,
      status: command === "start" ? "already-running" : "restarted",
    };
  }

  const existingAuthority = await readLockRecord(home);
  if (existingAuthority !== undefined) {
    if (!isProcessAlive(existingAuthority.pid)) {
      await rm(systemPaths(home).lock, { force: true });
      return startLocked(home, command);
    }
    const details = await waitForReady(home, 10);
    return {
      command,
      home,
      process: details,
      schemaVersion,
      status: command === "start" ? "already-running" : "restarted",
    };
  }

  await rm(systemPaths(home).startupError, { force: true });
  const logDescriptor = openSync(systemPaths(home).log, "a", 0o600);
  await chmod(systemPaths(home).log, 0o600);
  const main = resolve(import.meta.dir, "../../main.ts");
  const child = spawn(process.execPath, ["run", main], {
    detached: true,
    env: { ...process.env, KOJO_INTERNAL_SYSTEM: "1", KOJO_HOME: home },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  child.unref();
  closeSync(logDescriptor);

  const details = await waitForReady(home, 10);
  return {
    command,
    home,
    process: details,
    schemaVersion,
    status: command === "restart" ? "restarted" : "started",
  };
};

export const startSystem = async () => {
  const home = resolveKojoHome();
  return withLaunchLock(home, () => startLocked(home, "start"));
};

const stopLocked = async (home: string, timeoutSeconds: number) => {
  let running = await inspectSystem(home);
  const authority = await readLockRecord(home);
  if (running === undefined && authority !== undefined && isProcessAlive(authority.pid)) {
    running = await waitForReady(home, timeoutSeconds);
  }
  if (running === undefined) {
    if (authority !== undefined) {
      await rm(systemPaths(home).lock, { force: true });
    }
    return {
      command: "stop" as const,
      home,
      process: null,
      schemaVersion,
      status: "already-stopped",
    };
  }

  const response = await fetch("http://localhost/stop", {
    method: "POST",
    unix: running.endpoint,
  });
  if (!response.ok) {
    throw new Error(`System Process ${running.pid} rejected the stop request`);
  }

  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const owner = await readLockRecord(home);
    if (owner === undefined) {
      return {
        command: "stop" as const,
        home,
        process: null,
        schemaVersion,
        status: "stopped",
      };
    }
    if (owner.pid !== running.pid) {
      throw new Error(
        `Kojo Home lock authority changed while stopping System Process ${running.pid}`,
      );
    }
    if (!isProcessAlive(owner.pid)) {
      await rm(systemPaths(home).lock, { force: true });
      continue;
    }
    await pause(pollInterval);
  }
  throw new Error(
    `System Process ${running.pid} did not stop within ${timeoutSeconds} seconds; retry with a longer --timeout`,
  );
};

export const stopSystem = async (timeoutSeconds: number) => {
  if (timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  const home = resolveKojoHome();
  return withLaunchLock(home, () => stopLocked(home, timeoutSeconds));
};

export const restartSystem = async (timeoutSeconds: number) => {
  if (timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  const home = resolveKojoHome();
  return withLaunchLock(home, async () => {
    await stopLocked(home, timeoutSeconds);
    return startLocked(home, "restart");
  });
};

export const systemStatus = async () => {
  const home = resolveKojoHome();
  const running = await inspectSystem(home);
  const authority = await readLockRecord(home);
  if (running === undefined && authority !== undefined && isProcessAlive(authority.pid)) {
    return {
      command: "status" as const,
      error: {
        action: "Inspect `kojo logs` and retry when startup completes.",
        code: "SYSTEM_UNAVAILABLE",
        message: `System Process ${authority.pid} owns this Kojo Home but is not available`,
      },
      home,
      process: null,
      schemaVersion,
      status: "unavailable",
    };
  }
  return {
    command: "status" as const,
    home,
    process: running ?? null,
    schemaVersion,
    status: running === undefined ? "stopped" : "running",
  };
};

export const systemLogs = async (lineCount: number) => {
  if (lineCount <= 0) {
    throw new Error("--lines must be a positive integer");
  }
  const home = resolveKojoHome();
  let contents = "";
  try {
    contents = await readFile(systemPaths(home).log, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const lines = contents
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-lineCount);
  return {
    command: "logs" as const,
    home,
    lines,
    process: (await inspectSystem(home)) ?? null,
    schemaVersion,
    status: contents.length === 0 ? "empty" : "available",
  };
};
