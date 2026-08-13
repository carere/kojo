import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";

/**
 * Hands the scheduler to the forked run without moving the virtual clock.
 *
 * `TestClock.adjust` forks `Effect.yieldNow` and awaits it before it does anything else, so a zero
 * adjustment is a settle and nothing more: every fiber that is ready to run, runs, and the clock
 * stays where it was. Use it where nothing has to expire — after starting a run, after answering a
 * gate — and use `settleThenAdvance` everywhere time has to pass.
 */
export const settle: Effect.Effect<void> = TestClock.adjust(Duration.zero);

/**
 * The last slice of the advance, held back so it lands after a settle rather than before one.
 *
 * One millisecond of virtual time. It is small enough that no deadline in a test can fall inside it
 * by accident, and it is *subtracted from* the requested duration rather than added to it, so
 * `settleThenAdvance(Duration.days(2))` moves the clock two days exactly and a test may still assert
 * a human latency to the millisecond.
 */
const trailing = Duration.millis(1);

/**
 * Moves virtual time forward around a suspended run, in the order that does not deadlock.
 *
 * **This is the only place a test moves the clock.** The naive one-liner hangs, for two reasons
 * found by measurement rather than by reading:
 *
 * 1. `TestClock.adjust` only releases sleeps that were registered *before* it ran. A run started
 *    with `discard: true` has not necessarily reached its durable sleep yet, so advancing first
 *    parks that sleep for the whole virtual duration — a seven-day gate against a five-second
 *    vitest timeout. Hence the leading settle.
 * 2. Waking a run is not the same as letting it get anywhere. Whatever the deadline or the answer
 *    released has to run far enough to register its *next* sleep, or reach the next gate, or write
 *    its record. Hence the settle in the middle, and the settle at the end.
 *
 * The shape is therefore settle → advance → settle → advance, with the last advance being the
 * millisecond held back above; the closing settle is what lets a test read the state the run reached
 * because of it. A durable sleep costs nothing here: `DurableClock` reads the Effect `Clock` on both
 * of its paths, so a seven-day gate expires in the time it takes to walk this function.
 */
export const settleThenAdvance = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.gen(function* () {
    const total = Duration.fromInputUnsafe(duration);
    const last = Duration.min(total, trailing);

    yield* settle;
    yield* TestClock.adjust(Duration.subtract(total, last));
    yield* settle;
    yield* TestClock.adjust(last);
    yield* settle;
  });
