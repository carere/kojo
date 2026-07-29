import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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

export const makeHostDiagnosticLogger = (path: string): HostDiagnosticLoggerShape => ({
  emit: (event) =>
    Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      // Host-wide retention is a separate policy; this adapter must not invent per-file limits.
      await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    }).pipe(Effect.ignore),
});

export const makeHostDiagnosticLoggerLayer = (path: string) =>
  Layer.succeed(HostDiagnosticLogger, makeHostDiagnosticLogger(path));
