import { Console, Effect, Layer } from "effect";
import { GateUnreachable } from "../models/GateUnreachable.ts";
import { Gate } from "../ports/Gate.ts";
import { GateRepository } from "../ports/GateRepository.ts";
import { describe } from "./TerminalGate.ts";

/**
 * The reference `Gate`: write the question down, then print how to answer it.
 *
 * `TerminalGate` prints and forgets, which is honest for one terminal and useless for the question
 * a factory is actually asked — *what is waiting on a person?* A printed line is gone with the
 * scrollback, and the run that suspended behind it is invisible until somebody remembers it. This
 * adapter is that adapter plus one row, and the row is what `kojo gate list` reads.
 *
 * **A failed write fails the ask.** Recording is not bookkeeping here: an asking nobody can list is
 * an asking nobody will answer, and a run that suspended on one waits until its deadline for
 * nothing. `GateUnreachable` is exactly that condition — the requesting half never got out — so the
 * store's error becomes it rather than being logged and swallowed.
 */
export const layer: Layer.Layer<Gate, never, GateRepository> = Layer.effect(
  Gate,
  Effect.map(GateRepository, (repository) => ({
    request: (request) =>
      repository.asked(request).pipe(
        Effect.mapError(
          (error) =>
            new GateUnreachable({
              gate: request.gate,
              actor: request.actor,
              reason: `the asking could not be written down: ${error.reason}`,
            }),
        ),
        Effect.andThen(Console.log(describe(request))),
      ),
    describe,
  })),
);
