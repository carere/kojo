import { Effect, Layer } from "effect";
import { AgentInvocationError } from "../models/AgentInvocationError.ts";
import { AgentInvoker } from "../ports/AgentInvoker.ts";

/**
 * Why a call cannot be made, said out loud, once per call.
 *
 * The wording matters more than usual. Whoever reads it has just run `kojo run` in their own
 * factory: they need to know that the run they started is theirs, that it got as far as an agent
 * phase, and that the phase stopped because this build has nothing to call — not because their
 * roster, their prompt or their workflow is wrong.
 */
const noProvider = (agent: string): string =>
  `no agent provider is wired into this build, so \`${agent}\` was never called. ` +
  "The run, the sandbox and the phases are yours; only the invocation is missing.";

/**
 * The agent invoker of a build that has no agent provider yet.
 *
 * **It refuses every call, loudly, and it is the only honest thing to hold here.** A `kojo run` of a
 * factory's own workflow must reach its agent phase — the sandbox is built, the branch is cut, the
 * phase row is written — and the alternative to a refusal is not a working agent, it is a missing
 * service: a workflow body that dies with `Service not found: kojo/agent/AgentInvoker` and a stack
 * trace, which says nothing to the person who wrote the workflow.
 *
 * `provider-failed` rather than `unknown-agent`, and the difference is where it sends the reader.
 * `unknown-agent` means a roster mistake, and this is not one: the roster may be perfect. The
 * provider is what is not there.
 *
 * Both capabilities are `false` because both are claims about a session, and a call that never
 * happens opens none. `resume: false` also holds the correction loop at zero turns, so a phase
 * cannot spend a budget re-asking something nothing answered.
 *
 * @public
 */
export const layer: Layer.Layer<AgentInvoker> = Layer.succeed(AgentInvoker, {
  capabilities: { resume: false, capture: false },
  invoke: (call) =>
    Effect.fail(
      new AgentInvocationError({
        agent: call.agent,
        fault: "provider-failed",
        reason: noProvider(call.agent),
        cause: undefined,
      }),
    ),
});
