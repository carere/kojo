import { Clock, Effect, Layer } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";
import { RunClaim } from "../models/RunClaim.ts";
import { RunLocked } from "../models/RunLocked.ts";
import { RunLock } from "../ports/RunLock.ts";

/**
 * Claims held in a `Map`, for a unit test of what a second claim does.
 *
 * The interesting behaviour of a lock is not where it is written down; it is that the second claim
 * **fails** rather than waits, and that the first is given back on every exit path. Both are
 * answered here in microseconds. What only the real adapter can answer is whether the refusal
 * survives a process boundary, and that is an integration test.
 *
 * The holder is a parameter so a test can put two of these side by side and read which one refused.
 */
export const layer = (options?: { readonly holder?: string }): Layer.Layer<RunLock> =>
  Layer.effect(
    RunLock,
    Effect.sync(() => {
      const held = new Map<RunId, RunClaim>();
      const holder = options?.holder ?? "in-memory";

      return {
        claim: (runId: RunId) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const existing = held.get(runId);
              if (existing !== undefined) {
                return yield* new RunLocked({
                  runId,
                  holder: existing.holder,
                  since: existing.since,
                });
              }

              const claim = new RunClaim({
                runId,
                holder,
                since: yield* Clock.currentTimeMillis,
              });
              held.set(runId, claim);
              return claim;
            }),
            (claim) =>
              Effect.sync(() => {
                held.delete(claim.runId);
              }),
          ),
      } satisfies RunLock["Service"];
    }),
  );
