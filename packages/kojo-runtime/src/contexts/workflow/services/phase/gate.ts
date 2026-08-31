import { Clock, Duration, Effect, Option, Schema } from "effect";
import {
  Activity,
  DurableClock,
  DurableDeferred,
  type WorkflowEngine,
} from "effect/unstable/workflow";
import { GateExpired } from "../../../gate/models/GateExpired.ts";
import { settled } from "../../../gate/models/GateRecord.ts";
import { GateRequest } from "../../../gate/models/GateRequest.ts";
import { GateUnreachable } from "../../../gate/models/GateUnreachable.ts";
import type { OnExpiry } from "../../../gate/models/OnExpiry.ts";
import { Settlement, Verdict } from "../../../gate/models/Verdict.ts";
import { Gate } from "../../../gate/ports/Gate.ts";
import { GateRepository } from "../../../gate/ports/GateRepository.ts";
import { Tracer } from "../../../trace/ports/Tracer.ts";
import { CurrentRun } from "../CurrentRun.ts";
import { currentLane } from "./whereItRan.ts";

/** What an author declares when a run needs a human. */
export interface GateParams {
  readonly name: string;
  readonly description: string;
  /** Who is asked to decide. */
  readonly actor: string;
  readonly choices: ReadonlyArray<string>;
  /** Neither this nor `onExpiry` is optional: a run that waits forever is a leak. */
  readonly deadline: Duration.Input;
  readonly onExpiry: OnExpiry;
  /**
   * Which asking of this gate this is. Defaults to the engine's own attempt counter.
   *
   * A `DurableDeferred` is keyed `executionId/name` and refuses to overwrite, so asking the same
   * gate twice under one name reads the *first* verdict back instantly, forever — a loop that
   * looks like it is asking a human and is not. The reviewed loop drives this counter; an author
   * writing a single gate never sets it.
   */
  readonly asking?: number | undefined;
}

interface Asking {
  readonly params: GateParams;
  /** Unique to this asking. It is the deferred name, so it is also what keys the recorded answer. */
  readonly deferredName: string;
  readonly actor: string;
  readonly deadline: Duration.Input;
}

/** What one asking produced: the request as it went out, and the verdict if one came back. */
interface Answered {
  readonly request: GateRequest;
  readonly verdict: Option.Option<Verdict>;
}

/**
 * One asking of a gate: request, suspend, settle, record.
 *
 * The requesting half sits inside an `Activity` so a resumed run does not print the command, post
 * the review, or write the record a second time. Everything outside an activity re-runs on every
 * replay, and a gate is precisely the thing that causes replays.
 */
const ask = (
  asking: Asking,
): Effect.Effect<
  Answered,
  GateUnreachable,
  | Gate
  | GateRepository
  | Tracer
  | CurrentRun
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const run = yield* CurrentRun;
    const port = yield* Gate;
    const repository = yield* GateRepository;
    const tracer = yield* Tracer;

    // `make` returns a plain object. `yield*` on it is a defect at runtime, not a type error.
    const deferred = DurableDeferred.make(asking.deferredName, { success: Verdict });
    const token = yield* DurableDeferred.token(deferred);
    const deadline = Duration.fromInputUnsafe(asking.deadline);

    const request = yield* Activity.make({
      name: `${asking.deferredName}/request`,
      success: GateRequest,
      error: GateUnreachable,
      execute: Effect.gen(function* () {
        const requestedAt = yield* Clock.currentTimeMillis;
        const request = new GateRequest({
          runId: run.runId,
          gate: asking.params.name,
          asking: asking.deferredName,
          description: asking.params.description,
          actor: asking.actor,
          choices: asking.params.choices,
          token,
          requestedAt,
          deadlineAt: requestedAt + Duration.toMillis(deadline),
          onExpiry: asking.params.onExpiry._tag,
        });
        yield* port.request(request);
        return request;
      }),
    });

    const settlement = yield* DurableDeferred.raceAll({
      name: asking.deferredName,
      success: Settlement,
      error: Schema.Never,
      effects: [
        DurableDeferred.await(deferred),
        // `inMemoryThreshold` is forced to zero because a gate must never hold the fiber. The
        // 60-second default runs any shorter deadline as an in-memory `Effect.sleep` inside an
        // activity, which keeps the sandbox open and the run un-suspended for the whole wait.
        DurableClock.sleep({
          name: `${asking.deferredName}/deadline`,
          duration: deadline,
          inMemoryThreshold: Duration.zero,
        }).pipe(Effect.as("expired" as const)),
      ],
    });

    yield* Activity.make({
      name: `${asking.deferredName}/record`,
      success: Schema.Void,
      error: Schema.Never,
      execute: Effect.gen(function* () {
        yield* tracer.gate(settled(request, settlement));
        // The queue's read model has to hear the same settlement the trace just did, or an expired
        // asking sits in *waiting* forever, *overdue by* a number growing without bound. The
        // deadline is used as the settlement time rather than the clock because it is when the
        // asking stopped being answerable — and it replays stable, like the reject verdict below.
        // Logged and swallowed rather than failing the activity: the row is observability, and a
        // run must not be traded for the record of it — the same rule every trace write follows.
        if (settlement === "expired") {
          yield* repository.expired({ token, expiredAt: request.deadlineAt }).pipe(
            Effect.ignoreCause({
              log: "Error",
              message: `the asking ${asking.deferredName} could not be marked expired`,
            }),
          );
        }
      }),
    });

    return {
      request,
      verdict: settlement === "expired" ? Option.none() : Option.some(settlement),
    };
  });

/**
 * The lane's name, with its separator, or nothing at all on the host.
 *
 * **A gate's durable name has to include the lane it was asked in, and the reason was measured.** A
 * `DurableDeferred` is keyed `executionId/name`, and so is the request activity, so two lanes of one
 * run that both ask a gate called `review` share one question: only the first lane's request reaches
 * a human, one answer completes both lanes, and the trace keeps one row for two branches. Measured
 * before the qualifier existed — `approve` was returned to both lanes from a single click.
 *
 * The scope's **name** and never its acquisition id, because this string must mean the same thing
 * after a rebuild as it did before one; the name is authored and constant, the id is per-container.
 *
 * A gate asked on the host keeps exactly the name it had, so nothing outside a sandbox scope
 * changes. Two identical gate names on the host still collide, and they should: there is no lane to
 * tell them apart, and inventing one would be inventing an identity out of nothing.
 */
const qualifier: Effect.Effect<string> = Effect.map(
  currentLane,
  Option.match({ onNone: () => "", onSome: (lane) => `${lane}/` }),
);

/**
 * A human decision point. The run stops, releases everything it holds, and continues on an answer.
 *
 * The asking half runs and finishes; the answering half happens later, possibly in another process,
 * on another machine, on another day. Nothing is held in between — suspension is an ordinary
 * interrupt, so a sandbox scope around this gate unwinds before the human even reads the question.
 */
export const gate = (
  params: GateParams,
): Effect.Effect<
  Verdict,
  GateUnreachable | GateExpired,
  | Gate
  | GateRepository
  | Tracer
  | CurrentRun
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const asking = params.asking ?? (yield* Activity.CurrentAttempt);
    const name = `gate/${yield* qualifier}${params.name}/${asking}`;
    const first = yield* ask({
      params,
      deferredName: name,
      actor: params.actor,
      deadline: params.deadline,
    });

    if (Option.isSome(first.verdict)) return first.verdict.value;

    switch (params.onExpiry._tag) {
      case "fail":
        return yield* new GateExpired({
          gate: params.name,
          waited: Duration.fromInputUnsafe(params.deadline),
        });

      case "reject":
        // Answered on the human's behalf, so the author's ordinary rejection path handles it. The
        // deadline is used as the answer time rather than the current clock: this value is built
        // outside an activity, and a later suspension replays it.
        return new Verdict({
          choice: params.onExpiry.choice,
          reason: params.onExpiry.reason,
          answerer: expiryAnswerer,
          answeredAt: first.request.deadlineAt,
        });

      case "escalate": {
        const escalation = params.onExpiry;
        const second = yield* ask({
          params,
          deferredName: `${name}/escalated`,
          actor: escalation.to,
          deadline: escalation.deadline,
        });

        if (Option.isSome(second.verdict)) return second.verdict.value;

        // An escalation is one further asking, not a chain: the escalated asking has no expiry
        // branch of its own, so a gate can never escalate forever.
        return yield* new GateExpired({
          gate: params.name,
          waited: Duration.sum(
            Duration.fromInputUnsafe(params.deadline),
            Duration.fromInputUnsafe(escalation.deadline),
          ),
        });
      }
    }
  });

/** Who an auto-rejected verdict is attributed to. There was no person, and it must not claim one. */
const expiryAnswerer = "kojo";
