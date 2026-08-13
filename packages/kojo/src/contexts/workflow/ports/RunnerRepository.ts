import { Context, type Effect } from "effect";
import type { RunnerRegistration } from "../models/RunnerRegistration.ts";

/**
 * Who is registered as able to drive runs on this factory, and how long ago they said so.
 *
 * The question it answers is the one a recorded answer raises: *is anybody there to apply it?* A
 * verdict written while no runner is alive is real and will apply — later, when one starts — and a
 * surface that showed it as applied would be lying (adr/gate/0001). So this is read by whatever has
 * to tell the two apart: `kojo watch` at startup, and the Console's health check after it.
 *
 * **It reads; it never registers.** Registration and its removal belong to the cluster, which
 * upserts a row when a runner starts, refreshes the heartbeat every ten seconds, and deletes the row
 * on graceful shutdown. Kojo maintaining a second liveness record beside it would be a second answer
 * to one question, and two answers means neither is trustworthy.
 *
 * **Stale rows are returned rather than filtered here**, and `RunnerRegistration.live` decides. A
 * crashed runner's row is the interesting one — the difference between *stopped* and *died* is
 * exactly what a person asking this question wants — and a port that dropped it could not say which.
 */
export class RunnerRepository extends Context.Service<
  RunnerRepository,
  {
    /** Every registration on file, live or stale, newest heartbeat first. */
    readonly registered: Effect.Effect<ReadonlyArray<RunnerRegistration>>;
  }
>()("kojo/workflow/RunnerRepository") {}
