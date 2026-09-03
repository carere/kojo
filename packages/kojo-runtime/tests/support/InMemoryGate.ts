import { Context, Effect, Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import type { GateRequest } from "../../src/contexts/gate/models/GateRequest.ts";
import { Gate } from "../../src/contexts/gate/ports/Gate.ts";
import { applyRecordedGateVerdict } from "./TestDaemonGateApplication.ts";

/** A verdict written before the run started. Everything the test does not say gets a stand-in. */
export interface ProgrammedAnswer {
  readonly choice: string;
  readonly reason?: string | undefined;
  readonly answerer?: string | undefined;
}

/**
 * What was asked, readable from a test without a terminal.
 *
 * Separate from `Gate` for the same reason `RecordedTrace` is separate from `Tracer`: nothing that
 * asks a human should be able to read back what everyone else asked.
 */
export class RequestedGates extends Context.Service<
  RequestedGates,
  { readonly requests: Effect.Effect<ReadonlyArray<GateRequest>> }
>()("kojo/gate/RequestedGates") {}

/**
 * A gate answered by a script instead of a person.
 *
 * Answers are queued **per gate name and consumed in order**, so the reviewed loop gets a different
 * verdict on each round — reject, then approve — rather than the same one forever. When a gate's
 * queue runs out the request is recorded and nothing answers it, which is the suspending case: the
 * run stops and the test answers it by hand through `applyRecordedGateVerdict`.
 *
 * A programmed answer is written from inside the requesting half, before the run ever reaches the
 * wait, so a scripted gate does not suspend at all. That is deliberate — a test about what an
 * author's workflow *decides* should not also be a test about durability.
 */
export const layer = (
  answers: Record<string, ReadonlyArray<ProgrammedAnswer>> = {},
): Layer.Layer<Gate | RequestedGates, never, WorkflowEngine.WorkflowEngine> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const requests: Array<GateRequest> = [];
      const queued = new Map(
        Object.entries(answers).map(([gate, programmed]) => [gate, [...programmed]]),
      );

      return Context.make(Gate, {
        request: (request: GateRequest) =>
          Effect.gen(function* () {
            requests.push(request);
            const next = queued.get(request.gate)?.shift();
            if (next === undefined) return;

            yield* applyRecordedGateVerdict({
              token: request.token,
              choice: next.choice,
              reason: next.reason ?? "",
              answerer: next.answerer ?? "in-memory",
            }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
          }),
        describe: (request: GateRequest) =>
          `${request.gate} → ${request.actor}: ${request.description}`,
      }).pipe(Context.add(RequestedGates, { requests: Effect.sync(() => [...requests]) }));
    }),
  );
