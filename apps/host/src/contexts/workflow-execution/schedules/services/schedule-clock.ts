import { Context, Layer } from "effect";

export interface ScheduleClockShape {
  readonly now: () => number;
}

/**
 * The schedule clock is a narrow seam so reconciliation and control races can
 * be tested against a fixed instant without exposing timer implementation
 * details outside the Host.
 */
export class ScheduleClock extends Context.Service<ScheduleClock, ScheduleClockShape>()(
  "kojo/host/ScheduleClock",
) {}

export const ScheduleClockLive = Layer.succeed(ScheduleClock, {
  now: () => Date.now(),
});
