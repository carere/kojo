import { Clock, Effect, FileSystem, Layer, Path, type PlatformError, Schema } from "effect";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import { RunClaim } from "../models/RunClaim.ts";
import { RunLocked, unknownHolder } from "../models/RunLocked.ts";
import { RunLock } from "../ports/RunLock.ts";

/** The claim as it sits on the disk, so a human with a shell can read who holds a run. */
const encodeClaim = Schema.encodeEffect(RunClaim);

const alreadyExists = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "AlreadyExists";

/**
 * The reference adapter: one file per run, created exclusively.
 *
 * **`wx` is the whole mechanism.** `O_CREAT | O_EXCL` is atomic in the kernel, so two processes
 * asking at the same instant get one success and one `EEXIST` — which is the difference between
 * refusing a second runner and racing one. Anything built out of "does the file exist? then write
 * it" has a window between the two questions, and the window is exactly the case this exists for.
 *
 * **A stale claim is not taken over, and that is deliberate.** A runner that was killed leaves its
 * file behind, and the next process is refused with the dead holder's name. Automatic takeover
 * needs a liveness test that is only meaningful on the machine that wrote the claim — and getting
 * it wrong reintroduces the race the port exists to remove. So a human removes the file, having
 * been told which one and who left it.
 */
export const layer = (options: {
  /** Where claims live. A run's data directory on the host, never inside a worktree. */
  readonly directory: string;
  /** What this runner calls itself. It is what a refused process reports to a human. */
  readonly holder: string;
}): Layer.Layer<RunLock, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    RunLock,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fileFor = (runId: RunId) => path.join(options.directory, `${runId}.claim`);

      /**
       * Who holds it, according to the file that refused us.
       *
       * Every failure to read it back is answered with an unknown holder rather than with an error.
       * The claim was refused either way, and turning "I could not read the name" into a different
       * outcome would let an unreadable file look like a free run.
       */
      const holderOf = (runId: RunId): Effect.Effect<RunLocked> =>
        fileSystem.readFileString(fileFor(runId)).pipe(
          Effect.flatMap((content) => Effect.try(() => JSON.parse(content) as unknown)),
          Effect.flatMap(decodeUnknown(RunClaim)),
          Effect.match({
            onFailure: () => new RunLocked({ runId, holder: unknownHolder, since: 0 }),
            onSuccess: (claim) =>
              new RunLocked({ runId, holder: claim.holder, since: claim.since }),
          }),
        );

      const take = (runId: RunId): Effect.Effect<RunClaim, RunLocked> =>
        Effect.gen(function* () {
          // Made once per claim rather than once per layer: the directory is a run's own, and a
          // factory that has not run yet does not have one.
          yield* fileSystem
            .makeDirectory(options.directory, { recursive: true })
            .pipe(Effect.orDie);

          const claim = new RunClaim({
            runId,
            holder: options.holder,
            since: yield* Clock.currentTimeMillis,
          });

          yield* encodeClaim(claim).pipe(
            Effect.orDie,
            Effect.flatMap((encoded) =>
              fileSystem.writeFileString(fileFor(runId), JSON.stringify(encoded, undefined, 2), {
                flag: "wx",
              }),
            ),
            // Only "it is already there" is a refusal. A full disk or a read-only directory is the
            // machine failing, and reporting that as "another process holds the run" would send
            // somebody hunting for a runner that does not exist. One handler rather than a
            // `catchIf` and an `orDie`: the second would kill the refusal the first just raised.
            Effect.catch((error) =>
              alreadyExists(error)
                ? Effect.flatMap(holderOf(runId), Effect.fail)
                : Effect.die(error),
            ),
          );

          return claim;
        });

      return {
        claim: (runId: RunId) =>
          Effect.acquireRelease(take(runId), (claim) =>
            // The claim is this process's, so removing it cannot take another runner's away — and
            // `force` keeps a release from dying over a file a human already cleaned up by hand.
            fileSystem.remove(fileFor(claim.runId), { force: true }).pipe(Effect.orDie),
          ),
      } satisfies RunLock["Service"];
    }),
  );
