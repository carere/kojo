import { Duration, Schema } from "effect";

/**
 * How long a registration outlives the runner that stopped refreshing it.
 *
 * Not a number Kojo chose: it is the cluster's own `shardLockExpiration`, and `getRunners` applies
 * exactly this window to the same column. Using a different one here would make Kojo disagree with
 * the framework about who is running.
 */
export const staleAfter: Duration.Duration = Duration.seconds(35);

/**
 * One runner, as the registration table remembers it.
 *
 * **Liveness is this row's age and nothing else.** `RunnerHealth` cannot answer the question:
 * `SingleRunner.layer` wires `layerNoop`, whose `isAlive` returns true for every address it is ever
 * given, so anything built on it reports a live runner while the machine is off — the "approved ✓
 * that means nothing" adr/gate/0001 exists to prevent.
 *
 * The heartbeat is the cluster's, refreshed every ten seconds by the shard-lock loop **even for a
 * runner holding zero shards**. Kojo writes no heartbeat of its own.
 */
export class RunnerRegistration extends Schema.Class<RunnerRegistration>("RunnerRegistration")({
  /** Host and port, as the runner registered it. One address per row. */
  address: Schema.String,
  /** How long ago the runner last said it was alive. Negative never happens; zero routinely does. */
  heartbeatAgeMillis: Schema.Finite,
}) {
  isLive(within: Duration.Duration = staleAfter): boolean {
    return this.heartbeatAgeMillis <= Duration.toMillis(within);
  }
}

/**
 * The runners that are actually running.
 *
 * **No rows is the normal idle state, not an error.** Sharding unregisters on graceful shutdown, so
 * a cleanly stopped `kojo watch` leaves the table empty. What the filter is for is the other case: a
 * runner that was killed leaves its row behind, and for up to thirty-five seconds that row would
 * claim a runner nobody can talk to. Ageing it out is mandatory rather than an optimisation.
 */
export const live = (
  registrations: ReadonlyArray<RunnerRegistration>,
  within: Duration.Duration = staleAfter,
): ReadonlyArray<RunnerRegistration> =>
  registrations.filter((registration) => registration.isLive(within));
