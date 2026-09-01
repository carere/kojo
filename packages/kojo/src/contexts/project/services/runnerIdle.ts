import { DEFAULT_RUNNER_IDLE_MILLIS } from "../../workflow/models/SchedulingDefaults.ts";

export type RunnerDemand =
  | "execution"
  | "trigger-polling"
  | "refresh"
  | "recovery"
  | "ready-wakeup"
  | "waiting-for-slot"
  | "waiting-for-human"
  | "none";

export const runnerIsIdle = (demand: RunnerDemand): boolean =>
  demand === "waiting-for-slot" || demand === "waiting-for-human" || demand === "none";

export const runnerShouldStop = (options: {
  readonly demand: RunnerDemand;
  readonly idleSince: number;
  readonly now: number;
  readonly idleMillis?: number;
}): boolean =>
  runnerIsIdle(options.demand) &&
  options.now - options.idleSince >= (options.idleMillis ?? DEFAULT_RUNNER_IDLE_MILLIS);
