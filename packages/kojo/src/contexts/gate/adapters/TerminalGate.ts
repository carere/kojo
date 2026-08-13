import { Console, DateTime, Layer } from "effect";
import type { GateRequest } from "../models/GateRequest.ts";
import { Gate } from "../ports/Gate.ts";

/**
 * The exact command that answers the gate.
 *
 * One `--choice` flag rather than a `--approve` / `--reject` pair: two independent booleans parse
 * `--approve --reject` as both true and accept neither, so contradictory and missing decisions
 * would have to be caught by a handler instead of by the parser.
 */
const answerCommand = (request: GateRequest, choice: string): string =>
  `kojo gate answer ${request.token} --choice ${choice} --reason "<why>"`;

/**
 * The one rendering of a gate request, exported because every adapter that asks a human owes them
 * the same words. `Gate.describe` hands it to the trace and the CLI; `RecordingGate` prints it too.
 */
export const describe = (request: GateRequest): string => {
  const deadline = DateTime.formatIso(DateTime.makeUnsafe(request.deadlineAt));
  const lines = [
    `gate "${request.gate}" waits on ${request.actor}  ·  run ${request.runId}`,
    `  ${request.description}`,
    `  deadline ${deadline}  ·  on expiry: ${request.onExpiry}`,
    "",
    ...request.choices.map((choice) => `  ${answerCommand(request, choice)}`),
  ];
  return lines.join("\n");
};

/**
 * Prints the answering command and returns. It does not wait, and that is the whole behaviour.
 *
 * A terminal adapter that blocked on `readline` would be the one thing this design exists to
 * avoid: the process holding a container open while a human thinks. Print, finish, let the run
 * suspend. The human answers from any terminal, later, with the command that was printed.
 */
export const layer: Layer.Layer<Gate> = Layer.succeed(Gate)({
  request: (request) => Console.log(describe(request)),
  describe,
});
