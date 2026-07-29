import { appendFile, chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";

export interface HostRequestDiagnosticEvent {
  readonly eventVersion: 1;
  readonly eventKind: "host-request.completed";
  readonly requestId: string;
  readonly operation: "Negotiate" | "ListProjects";
  readonly outcome: "success" | "error";
  readonly durationMs: number;
  readonly hostVersion: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly timestamp: string;
}

export interface HostDiagnosticLoggerShape {
  readonly emit: (event: HostRequestDiagnosticEvent) => Effect.Effect<void>;
}

export class HostDiagnosticLogger extends Context.Service<
  HostDiagnosticLogger,
  HostDiagnosticLoggerShape
>()("kojo/host/HostDiagnosticLogger") {}

const maximumFileSize = 10 * 1024 * 1024;

const removeIfPresent = async (path: string) => {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const rotateIfNeeded = async (path: string) => {
  try {
    if ((await stat(path)).size < maximumFileSize) return;
    const rotatedPath = join(dirname(path), "diagnostics.1.jsonl");
    await removeIfPresent(rotatedPath);
    await rename(path, rotatedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const makeHostDiagnosticLogger = (path: string): HostDiagnosticLoggerShape => ({
  emit: (event) =>
    Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      await rotateIfNeeded(path);
      await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    }).pipe(Effect.ignore),
});

export const makeHostDiagnosticLoggerLayer = (path: string) =>
  Layer.succeed(HostDiagnosticLogger, makeHostDiagnosticLogger(path));
