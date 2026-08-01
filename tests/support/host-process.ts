import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KojoHostProcessFixture {
  /** Terminates the Host without running graceful shutdown handlers. */
  readonly crash: () => Promise<void>;
  readonly diagnosticPath: string;
  readonly processId: number;
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

export interface KojoHostProcessOptions {
  readonly deletionClockPath?: string;
  readonly deletionCrashPhase?: string;
  readonly deletionLateFilePath?: string;
  readonly storePath?: string;
}

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const hostMainPath = join(workspaceRoot, "apps/host/tests/process-main.ts");
const hostStartupTimeoutMs = 15_000;
const socketPollIntervalMs = 25;

export const startKojoHostProcess = async (
  options: KojoHostProcessOptions = {},
): Promise<KojoHostProcessFixture> => {
  const ownsDirectory = options.storePath === undefined;
  const directory = options.storePath ?? (await mkdtemp(join(tmpdir(), "kojo-host-process-")));
  const socketPath = join(directory, "host.sock");
  const processHandle = Bun.spawn([process.execPath, hostMainPath], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      KOJO_HOST_SOCKET: socketPath,
      KOJO_HOST_STORE: directory,
      ...(options.deletionClockPath === undefined
        ? {}
        : { KOJO_TEST_DELETION_CLOCK_FILE: options.deletionClockPath }),
      ...(options.deletionCrashPhase === undefined
        ? {}
        : { KOJO_TEST_DELETION_CRASH_PHASE: options.deletionCrashPhase }),
      ...(options.deletionLateFilePath === undefined
        ? {}
        : { KOJO_TEST_DELETION_LATE_FILE: options.deletionLateFilePath }),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = readStderr(processHandle);

  try {
    await waitForSocket(socketPath, processHandle);
  } catch (error) {
    if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
    await processHandle.exited;
    if (ownsDirectory) await rm(directory, { recursive: true });
    throw withStderr(error, await stderr);
  }

  return {
    crash: async () => {
      if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
      await processHandle.exited;
      await rm(socketPath, { force: true });
      await stderr;
      if (ownsDirectory) await rm(directory, { force: true, recursive: true });
    },
    diagnosticPath: join(directory, "diagnostics.jsonl"),
    processId: processHandle.pid,
    socketPath,
    stop: async () => {
      if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
      await processHandle.exited;
      await stderr;
      if (ownsDirectory) await rm(directory, { force: true, recursive: true });
    },
  };
};

const waitForSocket = async (socketPath: string, processHandle: Bun.Subprocess) => {
  const deadline = Date.now() + hostStartupTimeoutMs;

  while (Date.now() < deadline) {
    try {
      await stat(socketPath);
      return;
    } catch {
      if (processHandle.exitCode !== null) {
        throw new Error("Kojo Host fixture exited before opening its socket.");
      }
      await Bun.sleep(socketPollIntervalMs);
    }
  }
  throw new Error("Timed out while starting the Kojo Host fixture.");
};

const readStderr = (processHandle: Bun.Subprocess) => {
  const stderr = processHandle.stderr;
  return stderr instanceof ReadableStream
    ? (async () => {
        const reader = stderr.getReader();
        const chunks: Array<string> = [];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = new TextDecoder().decode(next.value);
          chunks.push(chunk);
        }
        return chunks.join("");
      })()
    : Promise.resolve("");
};

const withStderr = (error: unknown, stderr: string) => {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = stderr.trim();

  return new Error(
    diagnostic.length === 0 ? message : `${message}\nKojo Host stderr:\n${diagnostic}`,
    { cause: error },
  );
};
