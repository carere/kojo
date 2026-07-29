import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectIdentity } from "@kojo/control";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HostIdentity } from "../../../../../src/contexts/workflow-execution/control/models/host-identity";
import {
  HostDiagnosticLogger,
  type HostRequestDiagnosticEvent,
  makeHostDiagnosticLogger,
  makeHostDiagnosticLoggerLayer,
} from "../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";

const cleanups: Array<() => Promise<void>> = [];
const TEST_HOST_IDENTITY = Schema.decodeUnknownSync(HostIdentity)(
  "host:00000000-0000-4000-8000-000000000000",
);
const projectIdentity = (value: string) => Schema.decodeUnknownSync(ProjectIdentity)(value);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Host Diagnostic Store", () => {
  it.effect("rotates JSON Lines before the active segment exceeds its size limit", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-rotation-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const first = diagnosticEvent("request-1", "2026-07-01T00:00:00.000Z");
      const segmentBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`) + 1;
      const logger = makeHostDiagnosticLogger({
        now: () => Date.parse("2026-07-01T00:00:01.000Z"),
        path,
        retention: { segmentBytes },
      });

      yield* logger.emit(first);
      yield* logger.emit(diagnosticEvent("request-2", "2026-07-01T00:00:01.000Z"));

      const segments = (yield* Effect.promise(() => readdir(directory))).filter((file) =>
        file.endsWith(".jsonl"),
      );
      expect(segments).toHaveLength(2);
    }),
  );

  it.effect("removes Diagnostic Events older than the retention age", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-age-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const now = Date.parse("2026-07-15T00:00:00.000Z");
      const logger = makeHostDiagnosticLogger({
        now: () => now,
        path,
        retention: { maxAgeMs: 1_000 },
      });

      yield* logger.emit(diagnosticEvent("expired", "2026-07-14T23:59:58.000Z"));
      yield* logger.emit(diagnosticEvent("retained", "2026-07-14T23:59:59.500Z"));
      yield* logger.cleanup;

      const events = yield* Effect.promise(() => readDiagnosticEvents(directory));
      expect(events.map((event) => event.requestId)).toEqual(["retained"]);
    }),
  );

  it.effect("discards stored Diagnostic Events with an invalid Host Identity", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-invalid-identity-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const event = {
        ...diagnosticEvent("invalid", "2026-07-15T00:00:00.000Z"),
        hostIdentity: "host:arbitrary",
      };
      yield* Effect.promise(() => writeFile(path, `${JSON.stringify(event)}\n`));
      const logger = makeHostDiagnosticLogger({
        now: () => Date.parse("2026-07-15T00:00:00.000Z"),
        path,
      });

      yield* logger.cleanup;

      expect(yield* Effect.promise(() => readDiagnosticEvents(directory))).toEqual([]);
    }),
  );

  it.effect("keeps the newest events within each Project byte limit", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-project-limit-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const timestamp = "2026-07-15T00:00:00.000Z";
      const projectA = projectIdentity("00000000-0000-4000-8000-00000000000a");
      const projectB = projectIdentity("00000000-0000-4000-8000-00000000000b");
      const projectEventBytes = Buffer.byteLength(
        `${JSON.stringify(diagnosticEvent("a-1", timestamp, projectA))}\n`,
      );
      const logger = makeHostDiagnosticLogger({
        now: () => Date.parse(timestamp),
        path,
        retention: {
          maxHostBytes: projectEventBytes * 10,
          maxProjectBytes: projectEventBytes * 2,
        },
      });

      yield* logger.emit(diagnosticEvent("a-1", timestamp, projectA));
      yield* logger.emit(diagnosticEvent("a-2", timestamp, projectA));
      yield* logger.emit(diagnosticEvent("a-3", timestamp, projectA));
      yield* logger.emit(diagnosticEvent("b-1", timestamp, projectB));
      yield* logger.cleanup;

      const events = yield* Effect.promise(() => readDiagnosticEvents(directory));
      expect(events.map((event) => event.requestId)).toEqual(["a-2", "a-3", "b-1"]);
    }),
  );

  it.effect("keeps the newest events within the Host-wide byte limit", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-host-limit-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const timestamp = "2026-07-15T00:00:00.000Z";
      const eventBytes = Buffer.byteLength(
        `${JSON.stringify(diagnosticEvent("h-1", timestamp))}\n`,
      );
      const logger = makeHostDiagnosticLogger({
        now: () => Date.parse(timestamp),
        path,
        retention: { maxHostBytes: eventBytes * 2 },
      });

      yield* logger.emit(diagnosticEvent("h-1", timestamp));
      yield* logger.emit(diagnosticEvent("h-2", timestamp));
      yield* logger.emit(diagnosticEvent("h-3", timestamp));
      yield* logger.cleanup;

      const events = yield* Effect.promise(() => readDiagnosticEvents(directory));
      expect(events.map((event) => event.requestId)).toEqual(["h-2", "h-3"]);
    }),
  );

  it.effect("applies retention immediately after a write rotates the active segment", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-large-write-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const timestamp = "2026-07-15T00:00:00.000Z";
      const eventBytes = Buffer.byteLength(
        `${JSON.stringify(diagnosticEvent("r-1", timestamp))}\n`,
      );
      const logger = makeHostDiagnosticLogger({
        now: () => Date.parse(timestamp),
        path,
        retention: { maxHostBytes: eventBytes, segmentBytes: eventBytes + 1 },
      });

      yield* logger.emit(diagnosticEvent("r-1", timestamp));
      yield* logger.emit(diagnosticEvent("r-2", timestamp));

      const events = yield* Effect.promise(() => readDiagnosticEvents(directory));
      expect(events.map((event) => event.requestId)).toEqual(["r-2"]);
    }),
  );

  it.effect("cleans at Host activation and on the configured periodic cadence", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-diagnostics-lifecycle-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const path = join(directory, "diagnostics.jsonl");
      const now = Date.parse("2026-07-15T00:00:00.000Z");
      const expired = diagnosticEvent("expired", "2026-07-14T23:59:58.000Z");
      yield* Effect.promise(() => writeFile(path, `${JSON.stringify(expired)}\n`));

      yield* Effect.gen(function* () {
        const logger = yield* HostDiagnosticLogger;
        expect(yield* Effect.promise(() => readDiagnosticEvents(directory))).toEqual([]);

        yield* logger.emit(expired);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 millis");
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));

        expect(yield* Effect.promise(() => readDiagnosticEvents(directory))).toEqual([]);
      }).pipe(
        Effect.provide(
          makeHostDiagnosticLoggerLayer({
            now: () => now,
            path,
            retention: { cleanupIntervalMs: 10, maxAgeMs: 1_000 },
          }),
        ),
      );
    }),
  );
});

const diagnosticEvent = (
  requestId: string,
  timestamp: string,
  projectIdentityValue?: ProjectIdentity,
) => ({
  eventVersion: 1 as const,
  eventKind: "host-request.completed" as const,
  hostIdentity: TEST_HOST_IDENTITY,
  requestId,
  operation: "Negotiate" as const,
  outcome: "success" as const,
  durationMs: 1,
  hostVersion: "0.1.0",
  protocolMajor: 1,
  protocolMinor: 0,
  ...(projectIdentityValue === undefined ? {} : { projectIdentity: projectIdentityValue }),
  timestamp,
});

const readDiagnosticEvents = async (directory: string) => {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  const events = await Promise.all(
    files.map(async (file) =>
      (await readFile(join(directory, file), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ),
  );
  return events.flat();
};

const diagnosticContractFields = {
  eventVersion: 1 as const,
  eventKind: "host-request.completed" as const,
  requestId: "request-1",
  operation: "Negotiate" as const,
  outcome: "success" as const,
  durationMs: 1,
  hostVersion: "0.1.0",
  protocolMajor: 1,
  protocolMinor: 0,
  timestamp: "2026-07-15T00:00:00.000Z",
};

const eventWithPlainHostIdentity = {
  ...diagnosticContractFields,
  // @ts-expect-error Host Identity must be decoded through its domain schema.
  hostIdentity: "host:00000000-0000-4000-8000-000000000000",
} satisfies HostRequestDiagnosticEvent;

const eventWithPlainProjectIdentity = {
  ...diagnosticContractFields,
  hostIdentity: TEST_HOST_IDENTITY,
  // @ts-expect-error Project Identity must be decoded through its domain schema.
  projectIdentity: "project-a",
} satisfies HostRequestDiagnosticEvent;

void eventWithPlainHostIdentity;
void eventWithPlainProjectIdentity;
