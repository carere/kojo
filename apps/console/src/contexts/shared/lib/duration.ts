/**
 * Durations, written the way a person reads them.
 *
 * Pure functions over two numbers, so every label on screen can be graded without a browser and
 * without a clock. `now` is always an argument here for the same reason it is a context value in a
 * component: this module must never be the thing that makes a screenshot move.
 */

const second = 1_000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * A span of time, at two units of precision and no more.
 *
 * Two units because one is too coarse to act on — a gate that says *41h* hides twelve minutes that
 * decide whether it has already expired — and three is noise nobody reads. The units are seconds up
 * to a minute, then minutes, then hours, then days, which is the range a run actually occupies:
 * console.md's worked example spans 0.2 seconds to 41 hours.
 *
 * **Below a second it prints milliseconds, and that floor moved because it was making the UI lie.**
 * The rounding below turns everything under 500 ms into `0s`, so a phase that took 403 ms and a
 * phase that took 252 ms both read *0s* — and a person then reports the run as having "two 0 ms
 * phases", because the Console told them so. That happened. A duration of zero is a real answer and
 * still reads `0s`; a duration that is merely small now says how small.
 *
 * One unit here rather than two, and the doctrine survives: `400ms` has no second unit to carry.
 * Rounded to 10 ms because the millisecond digit is noise from a clock nobody synchronised.
 */
export const humanDuration = (millis: number): string => {
  const exact = Math.max(0, Math.abs(millis));
  // Rounded first, then re-tested: 999 ms rounds to 1000, and `1000ms` is a worse answer than `1s`
  // for the same quantity. The boundary belongs to the second, not to the millisecond.
  const rounded = Math.round(exact / 10) * 10;
  if (exact > 0 && rounded < second) return `${rounded}ms`;
  const span = Math.max(0, Math.round(Math.abs(millis) / second) * second);
  if (span < minute) return `${Math.round(span / second)}s`;
  if (span < hour) return `${Math.floor(span / minute)}m ${Math.round((span % minute) / second)}s`;
  if (span < day) return `${Math.floor(span / hour)}h ${Math.floor((span % hour) / minute)}m`;
  return `${Math.floor(span / day)}d ${Math.floor((span % day) / hour)}h`;
};

/**
 * A duration on the time axis, in hours rather than days.
 *
 * The same two units, with the day step left out on purpose. console.md's break says *41h 12m*, and
 * it has to: *1d 17h* is the same quantity written so that nobody can compare it with the *2m 0s*
 * phase beside it without doing arithmetic, and comparing is the only reason the number is there. A
 * factory run is measured in hours, so hours is where this stops.
 *
 * Below a minute it falls back to {@link humanDuration}, because a break that elided eight seconds
 * would otherwise read *0h 0m*.
 */
export const axisDuration = (millis: number): string => {
  const span = Math.max(0, Math.abs(millis));
  if (span < hour) return humanDuration(span);
  return `${Math.floor(span / hour)}h ${Math.floor((span % hour) / minute)}m`;
};

/**
 * How long is left before a moment, or how far past it we are.
 *
 * The two cases read differently on purpose. *in 7h 0m* is a number somebody may still act on;
 * *overdue by 2h 0m* is a statement that the run is stuck on a question that has gone stale, and it
 * must not be mistakable for the first at a glance.
 */
export const deadlineLabel = (deadlineAt: number, now: number): string =>
  now > deadlineAt
    ? `overdue by ${humanDuration(now - deadlineAt)}`
    : `in ${humanDuration(deadlineAt - now)}`;

/**
 * A tick's label, at the precision of the step it is drawn at.
 *
 * **The magnitude of the value must not choose the units — the step must.** {@link axisDuration}
 * drops seconds above an hour, which is right for a break's own label and wrong for a tick: a run
 * of two twenty-second phases either side of a 41-hour gate draws four ticks five seconds apart,
 * and every one of them reads `41h 0m`. Four identical labels under a header that says the step is
 * `5s` is an axis that cannot be measured by reading it, which is the only thing an axis is for.
 *
 * So the step decides. At a 5 s step the hour needs its seconds; at a 2 m step it does not; below a
 * second the tick is in milliseconds and the minute is not worth printing.
 */
export const tickLabel = (elapsedMillis: number, stepMillis: number): string => {
  const span = Math.max(0, Math.abs(elapsedMillis));
  if (span === 0) return "0s";

  // Sub-second steps. Below a second `humanDuration` already speaks milliseconds; above one it
  // rounds to the nearest whole second, which at a 500 ms step makes 1500 and 2000 both read `2s`.
  // One decimal is what keeps two adjacent ticks apart, and it is the only place a fraction is
  // printed anywhere in this module.
  if (stepMillis < second) {
    if (span < second) return humanDuration(span);
    const tenths = (Math.round((span % minute) / 100) / 10).toFixed(1);
    // The minute still has to be said. Collapsing a long wait leaves a fine step either side of the
    // break, so a tick can sit at 1.2 s and the next at 1m 6.8 s — and `66.8s` for the second of
    // those is a number a reader has to convert before they can place it.
    if (span >= minute) return `${Math.floor(span / minute)}m ${tenths}s`;
    return `${tenths}s`;
  }

  const hours = Math.floor(span / hour);
  const minutes = Math.floor((span % hour) / minute);
  const seconds = Math.round((span % minute) / second);

  // A step of a minute or coarser can never land between two seconds, so seconds are noise.
  if (stepMillis >= minute) {
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m 0s`;
  }

  // Finer than a minute: seconds are the whole point of the tick, so they survive the hour.
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};
