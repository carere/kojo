import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { inspectSystem, isProcessAlive, readLockRecord, systemPaths } from "./process";

const schemaVersion = 1 as const;
const pollInterval = 25;

const pause = (milliseconds: number) =>
  new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));

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

  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        return await effect();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for another Kojo launcher");
      }
      await pause(pollInterval);
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
      const failure = JSON.parse(await readFile(systemPaths(home).startupError, "utf8")) as {
        message?: unknown;
      };
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
    if ((await inspectSystem(home)) === undefined) {
      return {
        command: "stop" as const,
        home,
        process: null,
        schemaVersion,
        status: "stopped",
      };
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
