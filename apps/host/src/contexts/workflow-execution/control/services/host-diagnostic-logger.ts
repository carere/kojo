import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { ProjectIdentity } from "@kojo/control";
import { Context, Effect, Layer, Schema } from "effect";
import { HostIdentity } from "../models/host-identity";

export const DEFAULT_DIAGNOSTIC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const DEFAULT_DIAGNOSTIC_MAX_PROJECT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_MAX_HOST_BYTES = 500 * 1024 * 1024;

export interface HostDiagnosticRetentionPolicy {
  readonly cleanupIntervalMs: number;
  readonly maxAgeMs: number;
  readonly maxHostBytes: number;
  readonly maxProjectBytes: number;
  readonly segmentBytes: number;
}

export interface HostDiagnosticLoggerOptions {
  readonly now?: () => number;
  readonly path: string;
  readonly retention?: Partial<HostDiagnosticRetentionPolicy>;
}

export const HostRequestDiagnosticEvent = Schema.Struct({
  eventVersion: Schema.Literal(1),
  eventKind: Schema.Literal("host-request.completed"),
  hostIdentity: HostIdentity,
  requestId: Schema.String,
  operation: Schema.Literals([
    "Negotiate",
    "ListProjects",
    "ShowProject",
    "RegisterProject",
    "ForgetProject",
  ]),
  outcome: Schema.Literals(["success", "error"]),
  durationMs: Schema.Number,
  hostVersion: Schema.String,
  protocolMajor: Schema.Number,
  protocolMinor: Schema.Number,
  projectIdentity: Schema.optionalKey(ProjectIdentity),
  timestamp: Schema.String,
});
export type HostRequestDiagnosticEvent = typeof HostRequestDiagnosticEvent.Type;

export interface HostDiagnosticLoggerShape {
  readonly cleanup: Effect.Effect<void>;
  readonly emit: (event: HostRequestDiagnosticEvent) => Effect.Effect<void>;
}

export class HostDiagnosticLogger extends Context.Service<
  HostDiagnosticLogger,
  HostDiagnosticLoggerShape
>()("kojo/host/HostDiagnosticLogger") {}

const defaultRetention: HostDiagnosticRetentionPolicy = {
  cleanupIntervalMs: 60 * 60 * 1_000,
  maxAgeMs: DEFAULT_DIAGNOSTIC_MAX_AGE_MS,
  maxHostBytes: DEFAULT_DIAGNOSTIC_MAX_HOST_BYTES,
  maxProjectBytes: DEFAULT_DIAGNOSTIC_MAX_PROJECT_BYTES,
  segmentBytes: DEFAULT_DIAGNOSTIC_MAX_PROJECT_BYTES,
};

const fileSize = async (path: string) => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};

interface StoredDiagnosticLine {
  readonly bytes: number;
  readonly event: HostRequestDiagnosticEvent;
  readonly line: string;
  readonly order: number;
  readonly timestamp: number;
}

const diagnosticFiles = async (path: string) => {
  const extension = extname(path);
  const stem = basename(path, extension);
  try {
    return (await readdir(dirname(path)))
      .filter((file) => file === basename(path) || file.startsWith(`${stem}.`))
      .filter((file) => file.endsWith(extension))
      .map((file) => join(dirname(path), file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const readStoredLines = async (paths: ReadonlyArray<string>) => {
  const stored: Array<StoredDiagnosticLine> = [];
  let malformed = false;
  let order = 0;
  for (const path of [...paths].sort()) {
    const contents = await readFile(path, "utf8");
    for (const value of contents.split("\n").filter(Boolean)) {
      try {
        const event = Schema.decodeUnknownSync(HostRequestDiagnosticEvent)(JSON.parse(value));
        const timestamp = Date.parse(event.timestamp);
        if (!Number.isFinite(timestamp)) {
          malformed = true;
          continue;
        }
        const line = `${value}\n`;
        stored.push({ bytes: Buffer.byteLength(line), event, line, order: order++, timestamp });
      } catch {
        // Diagnostic data is non-authoritative; malformed lines are discarded during cleanup.
        malformed = true;
      }
    }
  }
  return {
    lines: stored.sort(
      (left, right) => left.timestamp - right.timestamp || left.order - right.order,
    ),
    malformed,
  };
};

export const makeHostDiagnosticLogger = (
  input: string | HostDiagnosticLoggerOptions,
): HostDiagnosticLoggerShape => {
  const options = typeof input === "string" ? { path: input } : input;
  const now = options.now ?? Date.now;
  const retention = { ...defaultRetention, ...options.retention };
  let pending = Promise.resolve();
  const run = (task: () => Promise<void>) => {
    const result = pending.then(task);
    pending = result.catch(() => undefined);
    return Effect.promise(() => result).pipe(Effect.ignore);
  };

  const rotateIfNeeded = async (lineBytes: number) => {
    const size = await fileSize(options.path);
    if (size === 0 || size + lineBytes <= retention.segmentBytes) return false;
    const extension = extname(options.path);
    const stem = basename(options.path, extension);
    const rotatedPath = join(dirname(options.path), `${stem}.${now()}.${randomUUID()}${extension}`);
    await rename(options.path, rotatedPath);
    return true;
  };

  const rewriteStore = async (
    existingPaths: ReadonlyArray<string>,
    lines: ReadonlyArray<StoredDiagnosticLine>,
  ) => {
    const chunks: Array<Array<StoredDiagnosticLine>> = [];
    const chunkBytes: Array<number> = [];
    for (const line of lines) {
      const current = chunks.at(-1);
      const currentBytes = chunkBytes.at(-1) ?? 0;
      if (
        current === undefined ||
        (current.length > 0 && currentBytes + line.bytes > retention.segmentBytes)
      ) {
        chunks.push([line]);
        chunkBytes.push(line.bytes);
      } else {
        current.push(line);
        chunkBytes[chunkBytes.length - 1] = currentBytes + line.bytes;
      }
    }

    const temporaryPaths = await Promise.all(
      chunks.map(async (chunk, index) => {
        const temporaryPath = `${options.path}.next.${index}`;
        await writeFile(temporaryPath, chunk.map((line) => line.line).join(""), { mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        return temporaryPath;
      }),
    );
    await Promise.all(
      existingPaths.map((path) =>
        unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }),
      ),
    );
    const extension = extname(options.path);
    const stem = basename(options.path, extension);
    await Promise.all(
      temporaryPaths.map((temporaryPath, index) => {
        const destination =
          index === temporaryPaths.length - 1
            ? options.path
            : join(dirname(options.path), `${stem}.${now()}.retained-${index}${extension}`);
        return rename(temporaryPath, destination);
      }),
    );
  };

  const cleanupStore = async () => {
    const paths = await diagnosticFiles(options.path);
    if (paths.length === 0) return;
    const { lines, malformed } = await readStoredLines(paths);
    const minimumTimestamp = now() - retention.maxAgeMs;
    const ageEligible = lines.filter((line) => line.timestamp >= minimumTimestamp);
    const retained: Array<StoredDiagnosticLine> = [];
    const projectBytes = new Map<ProjectIdentity, number>();
    let hostBytes = 0;
    for (const line of ageEligible.toReversed()) {
      if (hostBytes + line.bytes > retention.maxHostBytes) continue;
      const projectIdentity = line.event.projectIdentity;
      if (projectIdentity !== undefined) {
        const bytes = projectBytes.get(projectIdentity) ?? 0;
        if (bytes + line.bytes > retention.maxProjectBytes) continue;
        projectBytes.set(projectIdentity, bytes + line.bytes);
      }
      retained.push(line);
      hostBytes += line.bytes;
    }
    retained.reverse();
    if (!malformed && retained.length === lines.length) return;
    await rewriteStore(paths, retained);
  };

  return {
    cleanup: Effect.suspend(() => run(cleanupStore)),
    emit: (event) => {
      const line = `${JSON.stringify(event)}\n`;
      return run(async () => {
        await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
        await chmod(dirname(options.path), 0o700);
        const rotated = await rotateIfNeeded(Buffer.byteLength(line));
        await appendFile(options.path, line, { encoding: "utf8", mode: 0o600 });
        await chmod(options.path, 0o600);
        if (rotated) await cleanupStore();
      });
    },
  };
};

export const makeHostDiagnosticLoggerLayer = (options: string | HostDiagnosticLoggerOptions) =>
  Layer.effect(
    HostDiagnosticLogger,
    Effect.gen(function* () {
      const logger = makeHostDiagnosticLogger(options);
      const configured = typeof options === "string" ? undefined : options.retention;
      const cleanupIntervalMs = configured?.cleanupIntervalMs ?? defaultRetention.cleanupIntervalMs;
      yield* logger.cleanup;
      yield* Effect.sleep(cleanupIntervalMs).pipe(
        Effect.andThen(logger.cleanup),
        Effect.forever,
        Effect.forkScoped,
      );
      return logger;
    }),
  );
