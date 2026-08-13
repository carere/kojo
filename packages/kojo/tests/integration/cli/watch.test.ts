// `@effect/platform-bun` is imported by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  type PlatformError,
  Schedule,
  type Scope,
} from "effect";
import * as SqliteGateRepository from "../../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import type { AskedGate } from "../../../src/contexts/gate/models/AskedGate.ts";
import { GateRepository } from "../../../src/contexts/gate/ports/GateRepository.ts";
import * as SqliteDatabase from "../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import * as SqliteRunnerRepository from "../../../src/contexts/workflow/adapters/SqliteRunnerRepository.ts";
import {
  live,
  type RunnerRegistration,
} from "../../../src/contexts/workflow/models/RunnerRegistration.ts";
import { RunnerRepository } from "../../../src/contexts/workflow/ports/RunnerRepository.ts";

/**
 * How often a live runner refreshes its registration — the cluster's `shardLockRefreshInterval`.
 *
 * Not a number this file chose: it is the default `SingleRunner` runs under, and `kojo watch` does
 * not override it. It is here because a heartbeat older than this is the difference between a
 * runner that is quiet and a runner that is gone.
 */
const refreshInterval = Duration.seconds(10);

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;
const recorder = new URL("../../support/recordVerdict.ts", import.meta.url).pathname;

/**
 * The Bun that is running this test, which is what every child must also be.
 *
 * The CLI reaches `bun:sqlite` through the engine's SQL client, so a child spawned on Node dies at
 * import — inside a spawn whose failure this file would report as "the watcher never said
 * anything", which reads like a defect in the watcher rather than in how the suite was launched.
 */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

/** A long-lived child, its output so far, and the two ways it can be ended. */
interface Running {
  readonly said: () => string;
  readonly stop: (signal: NodeJS.Signals) => void;
  readonly gone: Effect.Effect<void>;
}

const running = (child: ChildProcess): Running => {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  return {
    said: () => output,
    stop: (signal) => void child.kill(signal),
    gone: Effect.callback<void>((resume) => {
      if (child.exitCode !== null || child.signalCode !== null) return resume(Effect.void);
      child.once("exit", () => resume(Effect.void));
    }),
  };
};

/**
 * One `kojo watch`, alive until the test's scope ends.
 *
 * Scoped rather than killed at the end of each test body, so a failing assertion cannot leave a
 * daemon behind holding the database it was measuring.
 */
const watching = (args: ReadonlyArray<string>): Effect.Effect<Running, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => running(spawn(bun(), [cli, "watch", ...args]))),
    (child) => Effect.sync(() => child.stop("SIGKILL")),
  );

/** Polls a child's output until it says something, and reports everything it said if it never does. */
const untilSaid = (child: Running, text: string): Effect.Effect<string> =>
  Effect.repeat(Effect.sync(child.said), {
    schedule: Schedule.spaced(Duration.millis(100)),
    until: (said: string) => said.includes(text),
    times: 250,
  }).pipe(
    Effect.flatMap((said) =>
      said.includes(text)
        ? Effect.succeed(said)
        : Effect.die(new Error(`the watcher never said "${text}". It said:\n${said}`)),
    ),
  );

/** One short-lived process, start to exit, with everything it printed. */
const ran = (command: string, args: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const child = running(spawn(bun(), [command, ...args]));
    yield* child.gone;
    return child.said();
  });

/** `→ run <id>`, the line a watcher prints when an event becomes a run. */
const runIdIn = (said: string): string => /→ run (\S+)/.exec(said)?.[1] ?? "";

/**
 * What waits on a person, read from the file rather than from anybody's output.
 *
 * The askings list is the durable record of a suspended run, and reading it here is how the test
 * knows both runs have reached their gate — a watcher's log says what it said, which is one process's
 * account of a fact that outlives it.
 */
const asked = (database: string) =>
  Effect.flatMap(GateRepository, (repository) => repository.all).pipe(
    Effect.provide(
      SqliteGateRepository.layer.pipe(Layer.provide(SqliteDatabase.layer({ path: database }))),
    ),
    Effect.orDie,
  );

/** Waits until that many questions are on the file, and says what it found. */
const untilAsked = (database: string, count: number) =>
  Effect.repeat(asked(database), {
    schedule: Schedule.spaced(Duration.millis(200)),
    until: (gates: ReadonlyArray<AskedGate>) => gates.length >= count,
    times: 100,
  }).pipe(
    Effect.flatMap((gates) =>
      gates.length >= count
        ? Effect.succeed(gates)
        : Effect.die(new Error(`only ${gates.length} of ${count} runs reached a gate`)),
    ),
  );

/** What the watcher says it ran for one run — the replay witness, isolated from the rest of the log. */
const phasesFor = (said: string, runId: string): string => {
  const header = `phases this watcher ran for ${runId}:`;
  const from = said.indexOf(header);
  if (from < 0) return "";
  const rest = said.slice(from + header.length);
  const end = rest.indexOf("\n\n");
  return end < 0 ? rest : rest.slice(0, end);
};

/** The registration table, read from a process that is deliberately not a runner. */
const registrations = (
  database: string,
): Effect.Effect<ReadonlyArray<RunnerRegistration>, PlatformError.PlatformError> =>
  Effect.flatMap(RunnerRepository, (repository) => repository.registered).pipe(
    Effect.provide(
      SqliteRunnerRepository.layer.pipe(Layer.provide(SqliteDatabase.layer({ path: database }))),
    ),
    Effect.orDie,
  );

interface Factory {
  readonly database: string;
  readonly inbox: string;
}

const onOwnFactory = <A, E>(
  use: (factory: Factory) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-watch-" });
    yield* fileSystem.makeDirectory(`${root}/inbox`, { recursive: true });
    return yield* use({ database: `${root}/kojo.db`, inbox: `${root}/inbox` });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const dropEvent = (inbox: string, file: string, key: string, subject: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(`${inbox}/${file}`, JSON.stringify({ key, payload: { subject } })),
  ).pipe(Effect.orDie);

/** The flags every watcher in this file runs with: quick loops, because a test is watching it. */
const quickly = (factory: Factory): ReadonlyArray<string> => [
  "demo-review",
  "--inbox",
  factory.inbox,
  "--database",
  factory.database,
  "--poll",
  "1",
  "--sweep",
  "1",
];

describe("running the factory unattended", () => {
  it.live(
    "restarts onto every suspended run, applies what another process answered, and re-runs nothing",
    () =>
      onOwnFactory((factory) =>
        Effect.gen(function* () {
          // **One.** A watcher, an empty inbox, and two tickets dropped into it. Two, because the
          // claim is that a restarted watcher resumes *every* suspended run, and one run cannot
          // tell the difference between every and the first.
          const first = yield* watching(quickly(factory));
          yield* untilSaid(first, "watching demo-review");

          // The watcher is the first process to touch this file, and the mark says it created and
          // migrated it alone, under the first-run lock, before it opened anything. Nothing else
          // writes that mark, so its absence would mean `kojo watch` skipped the guard and went
          // back to racing whichever other command started beside it.
          expect(existsSync(SqliteDatabase.readyMarkOf(factory.database))).toBe(true);

          yield* dropEvent(factory.inbox, "kojo-1.json", "demo-review/KOJO-1", "KOJO-1");
          yield* dropEvent(factory.inbox, "kojo-2.json", "demo-review/KOJO-2", "KOJO-2");

          const waiting = yield* untilAsked(factory.database, 2);
          expect(first.said()).toContain('suspended at gate "approve"');
          expect(first.said()).toContain("waiting on engineer");

          // While it is alive it is registered, which is what makes a recorded answer more than a
          // hope. Read from here rather than from `RunnerHealth`, whose noop calls every address
          // alive — the "approved ✓ that means nothing" adr/gate/0001 was written to prevent.
          const alive = yield* registrations(factory.database);
          expect(live(alive)).toHaveLength(1);

          // **Two.** It is killed rather than stopped: the laptop closed, the process died.
          first.stop("SIGKILL");
          yield* first.gone;

          const afterCrash = yield* registrations(factory.database);
          expect(afterCrash).toHaveLength(1);

          // **A live runner refreshes this row every ten seconds**, holding no shards or otherwise.
          // So waiting longer than that and finding an *older* heartbeat is the measurement that
          // says nobody is refreshing it any more — which is what stale means, and the reason the
          // timestamp filter is mandatory rather than an optimisation. The framework's own window
          // over the same column is thirty-five seconds, which is what finally removes it; this
          // asserts the mechanism the window is applied to rather than sitting out the window.
          yield* Effect.sleep(refreshInterval.pipe(Duration.sum(Duration.seconds(1))));
          const ageing = yield* registrations(factory.database);
          expect(ageing).toHaveLength(1);
          expect(ageing[0]?.heartbeatAgeMillis ?? 0).toBeGreaterThan(
            Duration.toMillis(refreshInterval),
          );
          expect(live(ageing, refreshInterval)).toHaveLength(0);

          // **Three.** A new watcher, which never saw either run start, adopts both from the
          // askings. Nothing came back through the inbox: those files were acknowledged and moved
          // when the runs suspended, so what the second watcher is working from is the file.
          const second = yield* watching(quickly(factory));
          for (const gate of waiting) {
            yield* untilSaid(second, `run ${gate.request.runId} suspended at gate "approve"`);
          }

          // **Four.** The answers are written by a process holding no runner and registering no
          // workflow body, so what applies them can only be the watcher. `kojo gate answer` would
          // have applied them itself, which would make a watcher that did nothing at all look
          // exactly like one that worked.
          for (const gate of waiting) {
            const recorded = yield* ran(recorder, [
              factory.database,
              gate.request.token,
              "approve",
              "ships",
              "kevin",
            ]);
            expect(recorded).toContain("applied nothing");
          }

          for (const gate of waiting) {
            const runId = gate.request.runId;
            const applied = yield* untilSaid(second, `run ${runId} succeeded`);

            // **Nothing re-ran.** The table is what *this* watcher executed, and the phase before
            // the gate is not in it: its recorded activity result came back instead of its body. A
            // `draft` line here would mean the work was done twice — and an empty table would mean
            // somebody else had already applied the answer, so the two failures are told apart.
            const phases = phasesFor(applied, runId);
            expect(phases).toContain("land");
            expect(phases).not.toContain("draft");
          }

          // **Five.** Stopped cleanly, it takes its registration with it. No rows is the normal
          // idle state of a factory, not a fault.
          second.stop("SIGTERM");
          yield* second.gone;
          expect(second.said()).toContain("stopped watching");
          expect(yield* registrations(factory.database)).toHaveLength(0);
        }),
      ),
    60_000,
  );

  it.live(
    "two triggers for one ticket revision produce one run",
    () =>
      onOwnFactory((factory) =>
        Effect.gen(function* () {
          const watcher = yield* watching(quickly(factory));
          yield* untilSaid(watcher, "watching demo-review");

          yield* dropEvent(factory.inbox, "first.json", "demo-review/KOJO-2", "KOJO-2");
          const once = yield* untilSaid(watcher, "first.json demo-review/KOJO-2 → run");
          const runId = runIdIn(once);

          // The same ticket revision, delivered again — a poller that re-read the tracker, a
          // webhook nobody answered in time, a person running the command twice.
          yield* dropEvent(factory.inbox, "second.json", "demo-review/KOJO-2", "KOJO-2");
          const twice = yield* untilSaid(watcher, "second.json demo-review/KOJO-2 → run");

          // One run. The engine hashes the workflow's own idempotency key into the execution id,
          // and nothing in the watcher keeps a table of seen events beside it.
          expect([...twice.matchAll(/→ run (\S+)/g)].map((match) => match[1])).toEqual([
            runId,
            runId,
          ]);

          // Both events were acknowledged, because the source is still waiting to hear — and what
          // both were told is the run that already exists.
          const fileSystem = yield* FileSystem.FileSystem;
          const acked = yield* fileSystem
            .readDirectory(`${factory.inbox}/acked`)
            .pipe(Effect.orDie);
          expect(acked.toSorted()).toEqual(["first.json", "second.json"]);
          for (const file of acked) {
            const content = yield* fileSystem
              .readFileString(`${factory.inbox}/acked/${file}`)
              .pipe(Effect.orDie);
            expect(JSON.parse(content)).toMatchObject({
              run: { runId, outcome: "suspended" },
            });
          }

          // And one question waits on a person, not two.
          const listed = yield* ran(cli, ["gate", "list", "--database", factory.database]);
          expect(listed.split("\n").filter((line) => line.includes(runId))).toHaveLength(1);
        }),
      ),
    60_000,
  );
});
