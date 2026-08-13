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
 */
export const humanDuration = (millis: number): string => {
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
