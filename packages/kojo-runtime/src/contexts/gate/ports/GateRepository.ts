import { Context, type Effect, type Option } from "effect";
import type { DurableDeferred } from "effect/unstable/workflow";
import type { AskedGate } from "../models/AskedGate.ts";
import type { GateRequest } from "../models/GateRequest.ts";
import type { GateStoreError } from "../models/GateStoreError.ts";
import type { Verdict } from "../models/Verdict.ts";

/**
 * Where the questions live between being asked and being answered.
 *
 * The `Gate` port is how a human is *asked*, and it deliberately keeps nothing: it posts a review,
 * prints a command, sends a message, and finishes. That leaves nobody able to answer the one
 * question a factory is asked every morning — *what is waiting on a person, and for how long?* The
 * engine cannot answer it either: it knows a run is suspended, not what it suspended on.
 *
 * So this is the other half of the reference adapter. One row per **asking**, written from inside
 * the request activity so a replayed body does not duplicate it, and updated once when a verdict is
 * written down. A `Repository` rather than a `Service` because it works with data and nothing else.
 *
 * It is observability, not correctness: resolving the suspension is a write to the *engine's*
 * storage, which `answerGate` does. Nothing here can resume a run, and a row here that says
 * `recorded` never means the run has moved.
 */
export class GateRepository extends Context.Service<
  GateRepository,
  {
    /**
     * Writes down that a human was asked. Called from inside the request activity, once per asking.
     */
    readonly asked: (request: GateRequest) => Effect.Effect<void, GateStoreError>;
    /**
     * Writes the verdict beside the asking it answers, keyed by the token that identifies it.
     *
     * Answering an asking this repository never saw is not an error — the token is the authority,
     * and a verdict may be given from a machine that never ran the workflow. The boolean says
     * whether a row was actually updated, so a caller can tell the two apart and say so.
     */
    readonly recorded: (options: {
      readonly token: DurableDeferred.Token;
      readonly verdict: Verdict;
    }) => Effect.Effect<boolean, GateStoreError>;
    /**
     * Writes down that the deadline settled the asking — nobody answered, and nobody can any more.
     *
     * Written by the run itself when the expiry half of the race wins, beside the `GateRecord` it
     * already records, and it is what lets the queue tell **expired** from **overdue**: overdue
     * means an answer may still land, expired means it cannot. Without it an expired asking sits in
     * *waiting* forever, *overdue by* a number growing without bound.
     *
     * The first settlement is kept, exactly as the first verdict is: the boolean says whether this
     * call was the one that wrote it.
     */
    readonly expired: (options: {
      readonly token: DurableDeferred.Token;
      readonly expiredAt: number;
    }) => Effect.Effect<boolean, GateStoreError>;
    /** One asking, by the token that identifies it. */
    readonly byToken: (
      token: DurableDeferred.Token,
    ) => Effect.Effect<Option.Option<AskedGate>, GateStoreError>;
    /** Every asking this store knows about, in no promised order. */
    readonly all: Effect.Effect<ReadonlyArray<AskedGate>, GateStoreError>;
  }
>()("kojo/gate/GateRepository") {}
