import { Cause, Clock, Effect, Option, Schema, SchemaAST } from "effect";
import { Activity } from "effect/unstable/workflow";
import type { AgentAnswer } from "../../../agent/models/AgentAnswer.ts";
import { AgentInvocationError } from "../../../agent/models/AgentInvocationError.ts";
import type { AgentSessionId } from "../../../agent/models/AgentSessionId.ts";
import { AgentInvoker } from "../../../agent/ports/AgentInvoker.ts";
import { contractFor } from "../../../agent/services/renderPrompt.ts";
import { WorkspaceError } from "../../../sandbox/models/WorkspaceError.ts";
import { decodeUnknown } from "../../../shared/lib/decode.ts";
import { present } from "../../../shared/lib/present.ts";
import { makePhaseId } from "../../../shared/models/PhaseId.ts";
import { AgentCallRecord } from "../../../trace/models/AgentCallRecord.ts";
import { InFlightPhase } from "../../../trace/models/InFlightPhase.ts";
import { PhaseRecord } from "../../../trace/models/PhaseRecord.ts";
import { Verification } from "../../../trace/models/Verification.ts";
import { Tracer } from "../../../trace/ports/Tracer.ts";
import { type Check, runChecks } from "../../guards/Check.ts";
import { CheckViolation } from "../../models/CheckViolation.ts";
import { EnvelopeParseError } from "../../models/EnvelopeParseError.ts";
import { CurrentRun } from "../CurrentRun.ts";
import { defaultCorrections, withCorrections } from "../corrections.ts";
import { whereItRan } from "./whereItRan.ts";

/**
 * What the envelope calls itself, for the trace and for the correction prompt.
 *
 * `Schema.Class` sets its own identifier annotation from the name it was declared with, so this is
 * the envelope's real name rather than a second one the call site has to keep in step.
 */
const identifierOf = (envelope: Schema.Top): string =>
  SchemaAST.resolveIdentifier(envelope.ast) ?? "envelope";

/**
 * A judgement call: prompt in, typed envelope out.
 *
 * One question, one contract, validated after the fact — never an iteration loop. Sandcastle's own
 * iteration count and completion signal would be a *second* control plane under Kojo's, and running
 * two means neither can say why a run stopped (D4). Iterating on the *work* is the author's, in
 * plain control flow. What happens here is narrower and is not iteration: an answer that is refused
 * is sent back for repair, in the same conversation, a bounded number of times, and the question
 * never changes.
 *
 * **Kojo decodes, the provider does not.** The agent provider never receives the schema; it hands
 * back text. That is deliberate — decode inside the provider and `EnvelopeParseError` belongs to
 * the provider, when it is precisely the error the correction loop takes as its input.
 *
 * **The answer is graded before it is returned.** Decoding proves the shape; `checks` prove the
 * content, against the repository rather than against the agent. Either refusal re-prompts the
 * *same session*, so a correction costs one message, and the loop is bounded so a stubborn agent
 * cannot spend a budget forever. Exhausting the bound fails with the last refusal itself.
 *
 * Like the code phase, the trace write sits **inside** the activity, so a run that suspends three
 * times still leaves one record for this phase — one row for the whole phase, corrections and all,
 * carrying what the last call cost and how many turns it took to get there.
 */
export const agent = <Envelope extends Schema.Top, R = never>(options: {
  readonly name: string;
  readonly description: string;
  /** The roster name of the agent to call. */
  readonly agent: string;
  readonly prompt: string;
  readonly envelope: Envelope;
  /** The session to re-enter. Absent starts cold; the correction loop is what passes one. */
  readonly session?: Option.Option<AgentSessionId> | undefined;
  /** Run over the decoded envelope's claims, after the agent returns. All of them, every attempt. */
  readonly checks?: ReadonlyArray<Check<Envelope["Type"], R>> | undefined;
  /** How many correction turns this phase may spend. Defaults to `defaultCorrections`. */
  readonly corrections?: number | undefined;
}) =>
  Activity.make({
    name: options.name,
    success: options.envelope,
    // `CheckViolation` and `WorkspaceError` are here whether or not this phase declares a check: an
    // agent phase is the primitive that grades what it is given, and a channel that changed shape
    // with the options would make every author's error union depend on a list they may edit later.
    error: Schema.Union([EnvelopeParseError, AgentInvocationError, CheckViolation, WorkspaceError]),
    execute: Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      const tracer = yield* Tracer;
      const run = yield* CurrentRun;
      const attempt = yield* Activity.CurrentAttempt;
      const sandboxId = yield* whereItRan;
      const startedAt = yield* Clock.currentTimeMillis;
      const checks = options.checks ?? [];

      // The run's status, stamped before the first turn — adr/trace/0002. An agent phase is where
      // this matters most: it is the phase that runs for minutes, so it is the one a live Console
      // would otherwise draw nothing at all for. Corrections do not touch it, exactly as they do not
      // produce a second record: the whole phase is one span, whatever it took inside.
      yield* tracer.phaseEntered(
        run.runId,
        new InFlightPhase({
          phaseId: makePhaseId(run.runId, options.name, attempt),
          name: options.name,
          kind: "agent",
          attempt,
          startedAt,
          ...present("sandboxId", sandboxId),
        }),
      );

      // Half of the row is only known once the agent has answered, and the row is still owed when
      // the answer never comes. So the call is held here and read on the way out — one wide record
      // on every path, rather than a second trace write for the half that arrived late.
      let call: Option.Option<AgentCallRecord> = Option.none();

      // The conversation the next turn re-enters. It starts as whatever the author passed and
      // becomes the session the agent answered in, so a correction is one more message rather than
      // a cold start that has to be told everything again.
      let session = options.session ?? Option.none<AgentSessionId>();
      let corrections = 0;
      let failed: ReadonlyArray<string> = [];

      // A correction is one more message in the same conversation. An invoker that cannot re-enter
      // one can only offer a cold call carrying the correction and none of the context that earned
      // it — a different request wearing the same name. So the bound is zero there, and the phase
      // row says which of the two reasons the phase stopped correcting.
      const correctable = invoker.capabilities.resume;
      const limit = correctable ? (options.corrections ?? defaultCorrections) : 0;

      // **The contract is appended here, not by the author and not by the invoker.**
      //
      // Not by the author, because SSSF keeps the type, the prompt's JSON example and the call
      // site's output type in three files and warns twice about drift; here the example *is* the
      // schema the decoder uses, rendered from it at the moment the prompt is built, so drift is
      // not expressible (D5).
      //
      // Not by the invoker, because the schema never crosses the `AgentInvoker` port — put the
      // decode behind the port and `EnvelopeParseError` belongs to the provider, when it is
      // precisely the error the correction loop takes as its input.
      //
      // Only the **cold** turn carries it. A correction is one more message in a conversation that
      // already holds the schema, and `correctionFor` names the envelope again by identifier.
      const opening = `${options.prompt}\n\n${contractFor(options.envelope)}`;

      return yield* withCorrections(
        (correction) =>
          Effect.gen(function* () {
            if (Option.isSome(correction)) corrections += 1;
            failed = [];

            const answer = yield* invoker.invoke({
              agent: options.agent,
              prompt: Option.getOrElse(correction, () => opening),
              session,
            });
            session = Option.some(answer.session);
            call = Option.some(
              new AgentCallRecord({
                agent: answer.agent,
                model: answer.model,
                session: answer.session,
                resumed: answer.resumed,
                tokensIn: answer.tokensIn,
                tokensOut: answer.tokensOut,
                ...present("contextTokens", answer.contextTokens),
              }),
            );

            const envelope = yield* decodeEnvelope(options.envelope, answer);
            const report = yield* runChecks(checks, envelope);
            failed = report.failed.map((result) => result.check);

            const violation = CheckViolation.fromReport(options.agent, report);
            return violation === undefined ? envelope : yield* violation;
          }),
        limit,
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const endedAt = yield* Clock.currentTimeMillis;
            yield* tracer.phase(
              new PhaseRecord({
                runId: run.runId,
                phaseId: makePhaseId(run.runId, options.name, attempt),
                name: options.name,
                description: options.description,
                kind: "agent",
                outcome:
                  exit._tag === "Success"
                    ? "succeeded"
                    : Cause.hasInterrupts(exit.cause)
                      ? "interrupted"
                      : "failed",
                attempt,
                startedAt,
                endedAt,
                ...present("sandboxId", sandboxId),
                ...present(
                  "errorTag",
                  exit._tag === "Success"
                    ? undefined
                    : Option.getOrUndefined(
                        Option.map(Cause.findErrorOption(exit.cause), (error) => error._tag),
                      ),
                ),
                ...present("agent", Option.getOrUndefined(call)),
                verification: new Verification({
                  envelope: identifierOf(options.envelope),
                  ran: checks.map((check) => check.name),
                  failed,
                  corrections,
                  correctable,
                }),
              }),
            );
          }),
        ),
      );
    }),
  });

/**
 * The agent's text, read as the envelope it was asked for.
 *
 * `fromJsonString` rather than a hand-rolled `JSON.parse`, so an agent that answered with prose and
 * an agent that answered with the wrong fields fail the same way, through the one decode path, with
 * the issue tree that makes a correction prompt worth sending. `raw` keeps what was actually said:
 * the issue list cannot be turned back into it, and it is the first thing a human wants when a
 * correction loop ran out of retries.
 */
const decodeEnvelope = <Envelope extends Schema.Top>(envelope: Envelope, answer: AgentAnswer) =>
  decodeUnknown(Schema.fromJsonString(envelope))(answer.output).pipe(
    Effect.mapError((error) =>
      EnvelopeParseError.fromSchemaError(
        { agent: answer.agent, expected: identifierOf(envelope), raw: answer.output },
        error,
      ),
    ),
  );
