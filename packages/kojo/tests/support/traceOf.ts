import { Effect, type FileSystem, Layer, Option, Path } from "effect";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../src/contexts/shared/models/RunId.ts";
import * as SqliteTraceReader from "../../src/contexts/trace/adapters/SqliteTraceReader.ts";
import type { PhaseRecord } from "../../src/contexts/trace/models/PhaseRecord.ts";
import type { RunDocument } from "../../src/contexts/trace/models/RunDocument.ts";
import { TraceReader } from "../../src/contexts/trace/ports/TraceReader.ts";

/**
 * One run as the **durable** trace holds it, read back through the real reader.
 *
 * Not off stdout, and the difference is the point. The phase table a command prints is what *this
 * invocation* executed; the trace is what the factory recorded, and it is the only place
 * `Verification.corrections`, `SandboxRecord.environment` and `GateRecord.description` exist at all.
 * It is also the only channel a workflow's *result* survives on — `kojo run` prints where a run
 * stopped, never what it returned — so a test that wants to grade what a phase decided has to come
 * here for it.
 */
export const traceOf = (
  root: string,
  runId: string,
): Effect.Effect<RunDocument, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const document = yield* Effect.gen(function* () {
      const reader = yield* TraceReader;
      return yield* reader.run(runId as RunId);
    }).pipe(
      Effect.provide(
        SqliteTraceReader.layer.pipe(
          Layer.provide(SqliteDatabase.layer({ path: path.join(root, ".kojo", "kojo.db") })),
        ),
      ),
      Effect.orDie,
    );
    if (Option.isNone(document)) throw new Error(`the trace has no run ${runId}`);
    return document.value;
  });

/** One phase of a run, by the name its author gave it. */
export const phaseOf = (document: RunDocument, name: string): PhaseRecord | undefined =>
  document.phases.find((record) => record.name === name);

/** The run id, read off `kojo run`'s first line exactly as a person reads it. */
export const runIdOf = (stdout: string): string => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("run "));
  return (line ?? "").slice("run ".length).trim();
};

/** The gate token, read out of `kojo gate list` exactly as a person reads it. */
export const tokenOf = (listing: string, runId: string): string => {
  const row = listing.split("\n").find((candidate) => candidate.includes(runId));
  const cells = (row ?? "").trim().split(/\s+/);
  return cells[cells.length - 1] ?? "";
};
