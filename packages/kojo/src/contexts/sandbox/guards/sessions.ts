import { Effect } from "effect";
import { AgentInvocationError } from "../../agent/models/AgentInvocationError.ts";
import type { AgentCapabilities } from "../../agent/ports/AgentInvoker.ts";
import type { SandboxCapabilities } from "../models/SandboxProvider.ts";

/**
 * The sandbox's half of the session question, in the words the agent port asks it in.
 *
 * The two vocabularies are deliberately separate — `AgentCapabilities` is what an invoker can do,
 * and an invoker is limited by its agent provider as well as by its sandbox — so this is the
 * translation, in one place, rather than two fields copied by hand at every construction site.
 *
 * Nothing here derives anything from a Sandcastle value. The tag came in with the provider, because
 * the published types strip it and an isolated provider is structurally identical to a no-sandbox
 * one (`models/SandboxProvider.ts`).
 */
export const sessionCapabilities = (capabilities: SandboxCapabilities): AgentCapabilities => ({
  resume: capabilities.resumesSessions,
  capture: capabilities.capturesSessions,
});

/**
 * A workflow that needs to re-enter a session says so here, and finds out before it burns a call.
 *
 * This is the guard against the quiet degradation: on an isolated provider there is no session to
 * re-enter, and the tempting thing is to start a cold one instead. That turns a correction turn
 * costing one message into a full re-run with none of the conversation, and it does it invisibly —
 * the run still ends `succeeded`, only more expensively and with a different answer. So the run
 * fails, with the fault the trace already groups on and the kind of sandbox that caused it.
 *
 * The `resume-unsupported` fault is `AgentInvocationError`'s, not a second name for the same thing:
 * an invoker handed a session it cannot resume fails exactly this way, and a caller that checked in
 * advance should not have to catch a different error than one that did not.
 */
export const requireResume = (
  agent: string,
  capabilities: SandboxCapabilities,
): Effect.Effect<void, AgentInvocationError> =>
  capabilities.resumesSessions
    ? Effect.void
    : Effect.fail(
        new AgentInvocationError({
          agent,
          fault: "resume-unsupported",
          reason:
            `a ${capabilities.kind} sandbox keeps no session to re-enter, ` +
            "and starting a cold one would be a different call",
          cause: undefined,
        }),
      );
