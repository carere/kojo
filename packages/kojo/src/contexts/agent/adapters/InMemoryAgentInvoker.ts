import { Effect, Layer, Option } from "effect";
import { AgentAnswer } from "../models/AgentAnswer.ts";
import { AgentInvocationError } from "../models/AgentInvocationError.ts";
import type { AgentSessionId } from "../models/AgentSessionId.ts";
import type { AgentCall, AgentCapabilities } from "../ports/AgentInvoker.ts";
import { AgentInvoker } from "../ports/AgentInvoker.ts";

/**
 * One pre-programmed answer.
 *
 * `envelope` is the ordinary case — an object, serialised the way an agent emits it, so a test says
 * what an agent decided in one literal. `output` is the case that matters just as much: verbatim
 * text an agent might really produce and that is *not* the envelope, which is the only way to
 * exercise the decode failure the correction loop exists for.
 */
export type ScriptedAnswer = {
  readonly model?: string | undefined;
  readonly tokensIn?: number | undefined;
  readonly tokensOut?: number | undefined;
  /** What the session occupied after the turn. Left unsaid, the answer reports none — as most do. */
  readonly contextTokens?: number | undefined;
} & ({ readonly envelope: unknown } | { readonly output: string });

/**
 * What one agent answers: the same thing every time, or a list it works through in order.
 *
 * A bare answer repeats, because most agents in most tests answer once and the phase order is what
 * is under test. A list is strict — it is exhausted, never recycled — because a list is what a test
 * of a *loop* scripts, and silently repeating the last answer would turn "the loop ran twice more
 * than it should have" into a green run.
 */
export type Script = ScriptedAnswer | ReadonlyArray<ScriptedAnswer>;

/** The default matrix row: everything a test needs, none of it pretending to be a container. */
const bothCapabilities: AgentCapabilities = { resume: true, capture: true };

/**
 * A scripted invoker: agent name in, pre-programmed envelope out.
 *
 * This is what makes a whole factory testable — no network, no credentials, no container, and a
 * deterministic answer per agent. It is the adapter every unit test uses.
 *
 * An unscripted agent is an `unknown-agent` fault rather than a plausible empty answer, on the same
 * principle as the in-memory workspace: a test that forgot to say what the router decides must find
 * that out from the test, not from a run that quietly took the wrong branch.
 */
export const layer = (
  scripts: Record<string, Script>,
  options?: { readonly capabilities?: AgentCapabilities },
): Layer.Layer<AgentInvoker> =>
  Layer.effect(
    AgentInvoker,
    Effect.sync(() => {
      const capabilities = options?.capabilities ?? bothCapabilities;
      const remaining = new Map<string, Array<ScriptedAnswer>>();
      const repeating = new Map<string, ScriptedAnswer>();
      for (const [agent, script] of Object.entries(scripts)) {
        if (Array.isArray(script)) remaining.set(agent, [...script]);
        else repeating.set(agent, script as ScriptedAnswer);
      }

      // Sessions are numbered rather than random, so a phase record a test asserts on reads the
      // same on every run.
      let opened = 0;

      const refuse = (agent: string, fault: AgentInvocationError["fault"], reason: string) =>
        Effect.fail(new AgentInvocationError({ agent, fault, reason, cause: undefined }));

      const nextAnswer = (agent: string): Effect.Effect<ScriptedAnswer, AgentInvocationError> => {
        const queue = remaining.get(agent);
        if (queue !== undefined) {
          const answer = queue.shift();
          return answer === undefined
            ? refuse(agent, "unknown-agent", "the scripted answers for this agent are exhausted")
            : Effect.succeed(answer);
        }
        const answer = repeating.get(agent);
        return answer === undefined
          ? refuse(agent, "unknown-agent", "no scripted answer for this agent")
          : Effect.succeed(answer);
      };

      const invoke = (call: AgentCall): Effect.Effect<AgentAnswer, AgentInvocationError> => {
        if (Option.isSome(call.session) && !capabilities.resume) {
          return refuse(
            call.agent,
            "resume-unsupported",
            "this invoker cannot re-enter a session, and starting cold would be a different call",
          );
        }
        return nextAnswer(call.agent).pipe(
          Effect.map(
            (answer) =>
              new AgentAnswer({
                agent: call.agent,
                model: answer.model ?? "scripted",
                session: Option.getOrElse(call.session, () => {
                  opened += 1;
                  return `${call.agent}-session-${opened}` as AgentSessionId;
                }),
                resumed: Option.isSome(call.session),
                tokensIn: answer.tokensIn ?? 0,
                tokensOut: answer.tokensOut ?? 0,
                contextTokens: answer.contextTokens,
                output:
                  "output" in answer
                    ? answer.output
                    : JSON.stringify(answer.envelope, undefined, 2),
              }),
          ),
        );
      };

      return { capabilities, invoke } satisfies AgentInvoker["Service"];
    }),
  );
