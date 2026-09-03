import { Context, type Effect } from "effect";
import type { GateRequest } from "../models/GateRequest.ts";
import type { GateUnreachable } from "../models/GateUnreachable.ts";

/**
 * How a human is asked. Deliberately only half of the story.
 *
 * `request` posts a review, prints a command, or sends a message — and then it *finishes*. It never
 * waits for the answer, because the answer may arrive in another process, on another machine, on
 * Tuesday. Only the Daemon records and applies a Verdict; the Project runtime receives continuation
 * through its private Runner protocol.
 *
 * That asymmetry is the whole design. A port with a `ask(): Effect<Verdict>` method would have to
 * hold the fiber, and holding the fiber is holding the container.
 */
export class Gate extends Context.Service<
  Gate,
  {
    readonly request: (request: GateRequest) => Effect.Effect<void, GateUnreachable>;
    /** One human-readable rendering, shared by the terminal, the trace, and the CLI. */
    readonly describe: (request: GateRequest) => string;
  }
>()("kojo/gate/Gate") {}
