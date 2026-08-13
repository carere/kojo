import { Clock, Duration, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import { TriggerError } from "../models/TriggerError.ts";
import { TriggerEvent } from "../models/TriggerEvent.ts";
import { Trigger, type TriggerOutcome } from "../ports/Trigger.ts";

/** How often the directory is read when it is empty. Slow enough to cost nothing on a laptop. */
const defaultInterval = Duration.seconds(2);

/** Where an acknowledged event goes. Beside the inbox, so one directory is the whole history. */
const ackedDirectory = "acked";

/** What one file in the inbox has to say. Everything else about it is the file system's business. */
const Dropped = Schema.Struct({
  /** What the run is deduplicated by. It must be what the workflow's `idempotencyKey` returns. */
  key: Schema.String,
  /** The payload the run starts from. Still encoded — the workflow's schema decodes it. */
  payload: Schema.Unknown,
});

/**
 * Which file an event came out of, carried on the event so the acknowledgement can find it again.
 *
 * The port gives an ack the event and nothing else, which is right — an adapter that needed the
 * driver to remember its bookkeeping would be a driver. So the file name travels in `source`, where
 * it also does the other job `source` is for: a malformed event reports `inbox/KOJO-1.json`, which
 * is the thing a person has to go and edit.
 */
const sourceFor = (file: string): string => `inbox/${file}`;
const fileOf = (source: string): string => source.slice("inbox/".length);

const unreachable = (directory: string, reason: string, cause: unknown): TriggerError =>
  new TriggerError({
    source: sourceFor(directory),
    fault: "unreachable",
    reason,
    issues: [],
    cause,
  });

/**
 * A directory of JSON files, read on an interval. The trigger a factory with no network runs on.
 *
 * `ManualTrigger` emits one event and ends, which is right for `kojo run` and useless for a process
 * that is supposed to still be there tomorrow. This is the other end of the same port: a source that
 * never ends, that survives the watcher being restarted, and that a person or a cron line feeds by
 * writing a file. One file, `{ "key": "KOJO-1@3", "payload": { … } }`, is one unit of work.
 *
 * **Acknowledging moves the file, and that is what stops the work happening twice.** An event stays
 * in the inbox until the run it started has settled, so a watcher killed mid-run finds the file
 * again on restart and offers it again — and the second offer resolves to the *same* run, because
 * the engine deduplicates on the workflow's own idempotency key. The moved copy carries the run id
 * and where the run stopped, so the directory is also the answer to "what did that ticket produce".
 *
 * A file that is not an event **ends the drive**, exactly as a malformed payload does. That is the
 * decision `Trigger` already records: a watcher that swallowed it would sit there looking healthy
 * while every event fell on the floor. The operator is told which file, by name.
 */
export const layer = (options: {
  readonly directory: string;
  /** How long to wait after finding nothing. Read from the `Clock`, so a test moves it. */
  readonly interval?: Duration.Input | undefined;
}): Layer.Layer<Trigger, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Trigger,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const interval = options.interval ?? defaultInterval;

      /**
       * Files already handed out and not yet acknowledged.
       *
       * The disk is the durable record; this is only so one sweep does not offer the same file the
       * next sweep is still working through, and so an ack that failed to move a file cannot turn
       * into a loop that starts the same run forever.
       */
      const offered = new Set<string>();

      const eventsIn = (files: ReadonlyArray<string>) =>
        Effect.forEach(files, (file) =>
          Effect.gen(function* () {
            const content = yield* fileSystem
              .readFileString(path.join(options.directory, file))
              .pipe(
                Effect.mapError((error) =>
                  unreachable(file, `the event could not be read: ${error.message}`, error),
                ),
              );

            const parsed = yield* Effect.try(() => JSON.parse(content) as unknown).pipe(
              Effect.mapError(
                (error) =>
                  new TriggerError({
                    source: sourceFor(file),
                    fault: "malformed",
                    reason: "the file is not JSON",
                    issues: [],
                    cause: error,
                  }),
              ),
            );

            const dropped = yield* decodeUnknown(Dropped)(parsed).pipe(
              Effect.mapError((error) =>
                TriggerError.fromSchemaError({ source: sourceFor(file), key: file }, error),
              ),
            );

            offered.add(file);
            return new TriggerEvent({
              source: sourceFor(file),
              key: dropped.key,
              payload: dropped.payload,
              // Read when the file is picked up rather than when it was written: the event arrives
              // when the factory sees it, and a file dropped while the watcher was down did not
              // arrive earlier for having sat there.
              receivedAt: yield* Clock.currentTimeMillis,
            });
          }),
        );

      /**
       * One look in the directory.
       *
       * Sleeping **after** an empty look rather than before every look, so a watcher started with
       * work already waiting picks it up at once and an idle one costs one `readdir` per interval.
       */
      const sweep = Effect.gen(function* () {
        const present = yield* fileSystem.readDirectory(options.directory).pipe(
          // A missing inbox is an empty inbox: `kojo watch` may be started before anybody has
          // dropped anything, and refusing to run until a directory exists helps nobody. Anything
          // else — a permission, a disk — is the source being unreadable, which is what
          // `unreachable` names and what a watcher must not mistake for "no work today".
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed<ReadonlyArray<string>>([])
              : Effect.fail(
                  unreachable(
                    options.directory,
                    `the inbox could not be read: ${error.message}`,
                    error,
                  ),
                ),
          ),
        );

        const waiting = present
          .filter((file) => file.endsWith(".json") && !offered.has(file))
          .toSorted();

        if (waiting.length === 0) {
          yield* Effect.sleep(interval);
          return [];
        }
        return yield* eventsIn(waiting);
      });

      const acknowledged = (event: TriggerEvent, run: TriggerOutcome) =>
        Effect.gen(function* () {
          const file = fileOf(event.source);
          const done = path.join(options.directory, ackedDirectory);

          yield* fileSystem.makeDirectory(done, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(done, file),
            `${JSON.stringify(
              {
                key: event.key,
                payload: event.payload,
                receivedAt: event.receivedAt,
                run: { runId: run.runId, outcome: run.outcome },
                acknowledgedAt: yield* Clock.currentTimeMillis,
              },
              undefined,
              2,
            )}\n`,
          );
          yield* fileSystem.remove(path.join(options.directory, file), { force: true });
          yield* Effect.sync(() => offered.delete(file));
        }).pipe(
          Effect.mapError(
            (error) =>
              new TriggerError({
                source: event.source,
                fault: "ack-refused",
                key: event.key,
                // The run happened. Only the telling failed, and nothing may re-start a run on the
                // strength of this — the file staying put is a redelivery, which is safe, not a
                // second factory.
                reason: `the event could not be moved out of the inbox: ${error.message}`,
                issues: [],
                cause: error,
              }),
          ),
        );

      return {
        stream: Stream.fromIterableEffectRepeat(sweep),
        ack: acknowledged,
      } satisfies Trigger["Service"];
    }),
  );
