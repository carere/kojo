import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryRunLock from "../../../../../src/contexts/workflow/adapters/InMemoryRunLock.ts";
import { RunLocked } from "../../../../../src/contexts/workflow/models/RunLocked.ts";
import { oneRunner } from "../../../../../src/contexts/workflow/services/oneRunner.ts";

const runId = "9f86d081884c7d659a2feaa0c55ad015" as RunId;
const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as RunId;

const lock = InMemoryRunLock.layer({ holder: "runner-one" });

describe("two runners against one run id", () => {
  /**
   * Edge 9, as one assertion: the second one is **refused**, and the first is not disturbed.
   *
   * A run id names a branch and a branch names a worktree, so the second runner would be rebuilding
   * the directory the first is working in. The nesting here is what a second process looks like from
   * inside a test — one lock, two claims, no waiting anywhere.
   */
  it.effect("refuses the second, and says who is holding it", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(
        oneRunner(runId, oneRunner(runId, Effect.succeed("the inner one ran"))),
      );

      expect(Result.isFailure(outcome)).toBe(true);
      expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(RunLocked);
      expect(Result.isFailure(outcome) && outcome.failure.runId).toBe(runId);
      expect(Result.isFailure(outcome) && outcome.failure.holder).toBe("runner-one");
    }).pipe(Effect.provide(lock)),
  );

  /**
   * Refused, and refused *immediately*.
   *
   * The port has no `waitFor` and this is why: a queue turns a corruption into a delay, and a delay
   * is a thing people stop noticing. Under a `TestClock` a runner that waited for anything at all
   * would still be pending here, because nothing advances the clock.
   */
  it.effect("does not queue behind the runner that holds it", () =>
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(
        oneRunner(runId, Effect.sleep(Duration.days(2)).pipe(Effect.as("done"))),
      );
      yield* TestClock.adjust(Duration.zero);

      const refused = yield* Effect.result(oneRunner(runId, Effect.succeed("second")));
      expect(Result.isFailure(refused)).toBe(true);

      yield* TestClock.adjust(Duration.days(2));
      expect(yield* Fiber.join(first)).toBe("done");
    }).pipe(Effect.provide(lock)),
  );

  it.effect("lets a different run through, because the claim is per run id", () =>
    Effect.gen(function* () {
      expect(yield* oneRunner(runId, oneRunner(other, Effect.succeed("both")))).toBe("both");
    }).pipe(Effect.provide(lock)),
  );
});

describe("giving the claim back", () => {
  it.effect("releases it when the run finishes, so the next process may join", () =>
    Effect.gen(function* () {
      expect(yield* oneRunner(runId, Effect.succeed("first"))).toBe("first");
      expect(yield* oneRunner(runId, Effect.succeed("second"))).toBe("second");
    }).pipe(Effect.provide(lock)),
  );

  /**
   * The path that matters most, because it is the one a run takes when something has gone wrong.
   *
   * A claim that outlived a failure would leave every later process refused by a runner that is not
   * there — and the reference adapter writes a file, so it would still be refused tomorrow.
   */
  it.effect("releases it when the run fails", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(oneRunner(runId, Effect.fail("the lane fell over")));
      expect(Result.isFailure(outcome) && outcome.failure).toBe("the lane fell over");

      expect(yield* oneRunner(runId, Effect.succeed("after the failure"))).toBe(
        "after the failure",
      );
    }).pipe(Effect.provide(lock)),
  );

  it.effect("releases it when the run is interrupted", () =>
    Effect.gen(function* () {
      const held = yield* Effect.forkChild(oneRunner(runId, Effect.never));
      yield* TestClock.adjust(Duration.zero);
      yield* Fiber.interrupt(held);

      expect(yield* oneRunner(runId, Effect.succeed("after the interrupt"))).toBe(
        "after the interrupt",
      );
    }).pipe(Effect.provide(lock)),
  );
});
