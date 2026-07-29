import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KojoHostProcessFixture {
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export const startKojoHostProcess = async (): Promise<KojoHostProcessFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-host-process-"));
  const socketPath = join(directory, "host.sock");
  const processHandle = Bun.spawn(["bun", "run", join(workspaceRoot, "apps/host/main.ts")], {
    cwd: workspaceRoot,
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath, KOJO_HOST_STORE: directory },
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    await waitForSocket(socketPath, processHandle);
  } catch (error) {
    processHandle.kill("SIGTERM");
    await processHandle.exited;
    await rm(directory, { recursive: true });
    throw error;
  }

  return {
    socketPath,
    stop: async () => {
      processHandle.kill("SIGTERM");
      await processHandle.exited;
      await rm(directory, { recursive: true });
    },
  };
};

const waitForSocket = async (socketPath: string, processHandle: Bun.Subprocess) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(socketPath);
      return;
    } catch {
      if (processHandle.exitCode !== null) {
        const stderr =
          processHandle.stderr instanceof ReadableStream
            ? await new Response(processHandle.stderr).text()
            : "";
        throw new Error(`Kojo Host fixture exited before opening its socket: ${stderr}`);
      }
      await Bun.sleep(10);
    }
  }
  throw new Error("Timed out while starting the Kojo Host fixture.");
};
