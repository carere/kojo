import { Effect, Layer } from "effect";
import type { RunnerRegistration } from "../models/RunnerRegistration.ts";
import { RunnerRepository } from "../ports/RunnerRepository.ts";

/**
 * The registrations a test states outright.
 *
 * The one question this port answers — *is anybody there to apply an answer?* — has three interesting
 * shapes, and none of them can be produced on demand from a real cluster: no rows at all, which is a
 * cleanly stopped watcher; a row whose heartbeat is fresh; and a row whose heartbeat is thirty-six
 * seconds old, which is a runner that was killed and must not be reported as alive. Stating them is
 * the only way to grade the staleness window without waiting out its thirty-five seconds.
 *
 * It is also what a Console reads in a repository that has no factory: there is no `cluster_runners`
 * to ask, and *nothing is running* is the true answer rather than an error.
 */
export const of = (
  registrations: ReadonlyArray<RunnerRegistration>,
): Layer.Layer<RunnerRepository> =>
  Layer.succeed(RunnerRepository, { registered: Effect.succeed(registrations) });
