// `@effect/platform-bun` is imported by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  type PlatformError,
  Result,
  Stream,
} from "effect";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as InboxTrigger from "../../../../../src/contexts/trigger/adapters/InboxTrigger.ts";
import { Trigger } from "../../../../../src/contexts/trigger/ports/Trigger.ts";

/** Short, because these tests wait on a real clock: the inbox is a real directory. */
const interval = Duration.millis(50);

const onOwnInbox = <A, E>(
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-inbox-" });
    yield* fileSystem.makeDirectory(`${root}/inbox`, { recursive: true });
    return yield* use(`${root}/inbox`);
  }).pipe(Effect.scoped);

const drop = (directory: string, file: string, content: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(`${directory}/${file}`, content),
  ).pipe(Effect.orDie);

const event = (key: string, subject: string) => JSON.stringify({ key, payload: { subject } });

/** The adapter over one directory, with everything it needs from the platform. */
const over = (directory: string) =>
  InboxTrigger.layer({ directory, interval }).pipe(Layer.provide(BunServices.layer));

describe("a directory of events", () => {
  it.live("reads what was dropped in it, in name order", () =>
    onOwnInbox((directory) =>
      Effect.gen(function* () {
        yield* drop(directory, "b-second.json", event("KOJO-2@1", "second"));
        yield* drop(directory, "a-first.json", event("KOJO-1@1", "first"));

        const emitted = yield* Effect.flatMap(Trigger, (trigger) =>
          Stream.runCollect(Stream.take(trigger.stream, 2)),
        ).pipe(Effect.provide(over(directory)));

        // Name order, because a directory has no order of its own and "whatever readdir said" is
        // not something a person dropping two tickets can predict.
        expect(emitted.map((one) => one.key)).toEqual(["KOJO-1@1", "KOJO-2@1"]);
        expect(emitted[0]?.source).toBe("inbox/a-first.json");
        expect(emitted[0]?.payload).toEqual({ subject: "first" });
        expect(emitted[0]?.receivedAt).toBeGreaterThan(0);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("waits for a file that is not there yet, and picks it up when it is", () =>
    onOwnInbox((directory) =>
      Effect.gen(function* () {
        const reading = yield* Effect.forkChild(
          Effect.flatMap(Trigger, (trigger) =>
            Stream.runCollect(Stream.take(trigger.stream, 1)),
          ).pipe(Effect.provide(over(directory))),
        );

        yield* Effect.sleep(Duration.millis(150));
        yield* drop(directory, "late.json", event("KOJO-3@2", "late"));

        const emitted = yield* Fiber.join(reading);
        expect(emitted.map((one) => one.key)).toEqual(["KOJO-3@2"]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a missing inbox is an empty inbox rather than a failure", () =>
    Effect.gen(function* () {
      // `kojo watch` may be started before anybody has dropped anything, and refusing to run until
      // a directory exists helps nobody.
      const emitted = yield* Effect.flatMap(Trigger, (trigger) =>
        Stream.runCollect(Stream.take(trigger.stream, 1)),
      ).pipe(
        Effect.provide(over("/tmp/kojo-no-such-inbox-ever")),
        Effect.timeoutOption(Duration.millis(300)),
      );

      expect(emitted._tag).toBe("None");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a file that is not an event names the file rather than dying quietly", () =>
    onOwnInbox((directory) =>
      Effect.gen(function* () {
        yield* drop(directory, "broken.json", "{ this is not json");

        const outcome = yield* Effect.flatMap(Trigger, (trigger) =>
          Stream.runCollect(Stream.take(trigger.stream, 1)),
        ).pipe(Effect.provide(over(directory)), Effect.result);

        // The drive ends rather than skipping it: a watcher that swallowed this would sit there
        // looking healthy while every event fell on the floor.
        expect(Result.isFailure(outcome)).toBe(true);
        const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
        expect(failure?.fault).toBe("malformed");
        expect(failure?.source).toBe("inbox/broken.json");
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("an event without a key names the field that is missing", () =>
    onOwnInbox((directory) =>
      Effect.gen(function* () {
        yield* drop(directory, "keyless.json", JSON.stringify({ payload: { subject: "x" } }));

        const outcome = yield* Effect.flatMap(Trigger, (trigger) =>
          Stream.runCollect(Stream.take(trigger.stream, 1)),
        ).pipe(Effect.provide(over(directory)), Effect.result);

        const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
        expect(failure?.fault).toBe("malformed");
        expect(failure?.issues.map((issue) => issue.path)).toEqual([["key"]]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("acknowledging an event", () => {
  it.live("moves the file out of the inbox and writes what the run came to", () =>
    onOwnInbox((directory) =>
      Effect.gen(function* () {
        yield* drop(directory, "one.json", event("KOJO-4@1", "one"));
        const fileSystem = yield* FileSystem.FileSystem;

        yield* Effect.gen(function* () {
          const trigger = yield* Trigger;
          const emitted = yield* Stream.runCollect(Stream.take(trigger.stream, 1));
          const one = emitted[0];
          if (one === undefined) throw new Error("nothing was emitted");

          yield* trigger.ack(one, { runId: "run-abc" as RunId, outcome: "suspended" });
        }).pipe(Effect.provide(over(directory)));

        // Moved, not deleted. The inbox is also the record of what this factory was asked to do,
        // and the run id is what ties a ticket to the branch it produced.
        expect(yield* fileSystem.exists(`${directory}/one.json`)).toBe(false);
        const acked = yield* fileSystem.readFileString(`${directory}/acked/one.json`);
        expect(JSON.parse(acked)).toMatchObject({
          key: "KOJO-4@1",
          run: { runId: "run-abc", outcome: "suspended" },
        });
      }),
    ).pipe(Effect.provide(BunServices.layer), Effect.orDie),
  );

  it.live("an event still in the inbox is offered again, because a redelivery is safe", () =>
    onOwnInbox((directory) =>
      Effect.gen(function* () {
        yield* drop(directory, "two.json", event("KOJO-5@1", "two"));

        // Two separate readers, which is what a watcher restarted mid-run is: the file is still
        // there because nothing acknowledged it, so the work is offered again. What makes that
        // safe is the workflow's idempotency key, not the adapter.
        const first = yield* Effect.flatMap(Trigger, (trigger) =>
          Stream.runCollect(Stream.take(trigger.stream, 1)),
        ).pipe(Effect.provide(over(directory)));
        const second = yield* Effect.flatMap(Trigger, (trigger) =>
          Stream.runCollect(Stream.take(trigger.stream, 1)),
        ).pipe(Effect.provide(over(directory)));

        expect(first[0]?.key).toBe("KOJO-5@1");
        expect(second[0]?.key).toBe("KOJO-5@1");
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
