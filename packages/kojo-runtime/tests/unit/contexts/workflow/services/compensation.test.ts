import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import type { DurableDeferred, Workflow } from "effect/unstable/workflow";
import * as InMemoryGate from "../../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../src/contexts/gate/models/OnExpiry.ts";
import { answerGate } from "../../../../../src/contexts/gate/services/answerGate.ts";
import { runBranch } from "../../../../../src/contexts/shared/models/RunBranch.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { NotAccepted } from "../../../../../src/contexts/workflow/models/NotAccepted.ts";
import { onRunEnd } from "../../../../../src/contexts/workflow/services/compensation.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import {
  buildInfoLayer,
  layer as inMemoryExecutionServices,
} from "../../../../support/InMemoryExecutionServices.ts";
import {
  inMemoryWorkflowEngine,
  selfContainedTestLayer,
  serviceFreeWorkflowEffect,
} from "../../../../support/inMemoryWorkflowEngine.ts";
import { settleThenAdvance } from "../../../../support/settleThenAdvance.ts";

/**
 * **Ticket 21 — the inverse of the merge.** When a whole run fails, the world is put back.
 *
 * Most of what this grades is about *where* a compensation is written rather than what it does, and
 * a compensation that never fires is silent — so every claim here is graded by counting what ran:
 *
 * - in the factory body, it fires when the run fails, once, and never while the run waits;
 * - inside an activity, it never fires — the case that reads identically and is not;
 * - what a lane must undo is the lane's own scope's job, and that scope unwinds at the suspension
 *   while the run's compensation does not;
 * - `onRunEnd` survives a two-day gate and fires once, when the run really ends.
 *
 * **It runs on `InMemoryClusterEngine`, and that is load-bearing rather than incidental.** It is the
 * real cluster engine — the one `SingleNodeEngine` ships with SQL under it — and "once" is only true
 * there. `InMemoryEngine` is a second implementation of the same port, and it *shares one workflow
 * instance scope across every execution of a run* (`WorkflowEngine.ts:618-622` passes the previous
 * instance's scope into the new one), so every replay's registration accumulates in that one scope
 * and fires when it finally closes. The last block measures that divergence rather than leaving it
 * to be rediscovered as a bug.
 */

const deadline = Duration.days(7);

/** The tracker. Not a Kojo port, and deliberately not one: a ticket's status is the author's. */
const board = {
  status: "ready",
  comments: [] as Array<string>,
};

/** Every undo that fired and every lane scope that closed, in the order it happened. */
const put: Array<string> = [];

/** What `onRunEnd` saw, once per ended run. */
const ended: Array<string> = [];

/** Phase bodies that genuinely ran. A replayed phase adds nothing here. */
const ran: Array<string> = [];

beforeEach(() => {
  board.status = "ready";
  board.comments.length = 0;
  put.length = 0;
  ended.length = 0;
  ran.length = 0;
});

/** What a run of these workflows may fail with. Small on purpose: the union *is* the typed cause. */
const failures = Schema.Union([NotAccepted, GateExpired, GateUnreachable]);

/** How a scope closed. An interrupted scope is a suspension, and a suspension is not a fault. */
const closing = (exit: Exit.Exit<unknown, unknown>): string =>
  exit._tag === "Success" ? "success" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed";

const step = (name: string) =>
  code(
    { name, description: `the ${name} step`, success: Schema.Void, error: Schema.Never },
    Effect.sync(() => void ran.push(name)),
  );

const stop = (name: string) =>
  gate({
    name,
    description: `does ${name} pass?`,
    actor: "engineer",
    choices: ["approve", "reject"],
    deadline,
    onExpiry: OnExpiry.fail(),
    asking: 1,
  });

/**
 * The shape the ticket describes: claim the ticket, ask a human, land it or fail.
 *
 * The claim is a *phase* wrapped by `compensated` from the factory body, so the pairing sits at the
 * point the step is written and the undo cannot drift away from the thing it undoes. The phase hands
 * back the status it found, so the undo restores what was really there rather than what somebody
 * assumed was there.
 */
const factory = workflow(
  {
    name: "factory",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `factory/${payload.subject}`,
  },
  (_payload, compensation) =>
    Effect.gen(function* () {
      yield* onRunEnd((exit) => Effect.sync(() => void ended.push(closing(exit))));

      const previous = yield* compensation.compensated(
        code(
          {
            name: "claim",
            description: "Claim the ticket so nobody else picks it up",
            success: Schema.String,
            error: Schema.Never,
          },
          Effect.sync(() => {
            ran.push("claim");
            const was = board.status;
            board.status = "in progress";
            return was;
          }),
        ),
        (was, failure) =>
          Effect.sync(() => {
            // **This line is the test of the typed cause, and the compiler grades it.** `_tag` is
            // reachable only because the *method* form of `withCompensation` keeps the cause at the
            // workflow's own error type. The module form widens it to `Cause.Cause<unknown>`, where
            // this does not compile.
            const tag = Option.map(failure.error, (error) => error._tag);

            board.status = was;
            board.comments.push(failure.report);
            put.push(`ticket -> ${was} (${Option.getOrElse(tag, () => "no error")})`);
          }),
      );

      const verdict = yield* stop("review");
      if (verdict.choice !== "approve") {
        return yield* new NotAccepted({ reason: `${verdict.answerer}: ${verdict.reason}` });
      }

      yield* step("land");
      return previous;
    }),
);

/**
 * The same compensation call, written one level down — inside an activity body.
 *
 * It compiles, it reads identically, and it never fires: an activity executes under a throwaway
 * workflow instance whose scope closes with the activity's own **success** exit, where the finalizer
 * no-ops. `Effect.scoped` is there only to satisfy the `Scope` the signature asks for; the finalizer
 * attaches to the instance and not to that scope, which is why getting the scope right does not save
 * it.
 */
const nested = workflow(
  {
    name: "nested",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `nested/${payload.subject}`,
  },
  (_payload, compensation) =>
    Effect.gen(function* () {
      yield* compensation.compensated(step("outer"), () =>
        Effect.sync(() => void put.push("outer undone")),
      );

      yield* code(
        {
          name: "inner",
          description: "A phase that tries to register its own undo",
          success: Schema.Void,
          error: Schema.Never,
        },
        Effect.scoped(
          compensation.compensated(
            Effect.sync(() => void ran.push("inner")),
            () => Effect.sync(() => void put.push("inner undone")),
          ),
        ),
      );

      return yield* new NotAccepted({ reason: "the run failed after both" });
    }),
);

/**
 * A lane that holds something across a gate, and the run-level compensation beside it.
 *
 * The lane is a scope of its own — the shape `sandboxed` has — so it gives what it holds back when
 * the region ends, *including* when suspension interrupts it. The run's compensation answers a
 * different question: not "is this region over" but "did the whole run fail". The two fire at
 * different moments, and this workflow makes both moments observable.
 */
const laned = workflow(
  {
    name: "laned",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `laned/${payload.subject}`,
  },
  (_payload, compensation) =>
    Effect.gen(function* () {
      yield* compensation.compensated(step("claim"), (_value, failure) =>
        Effect.sync(() => void put.push(`run compensated: ${failure.errorTag ?? "none"}`)),
      );

      // The lane never succeeds, so this is where the body ends.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer((exit) =>
            Effect.sync(() => void put.push(`lane released: ${closing(exit)}`)),
          );
          const verdict = yield* stop("review");
          return yield* new NotAccepted({ reason: verdict.reason });
        }),
      );
    }),
);

const layerFor = () =>
  selfContainedTestLayer(
    Layer.mergeAll(factory.layer, nested.layer, laned.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          InMemoryTracer.layer,
          InMemoryGate.layer().pipe(Layer.provideMerge(inMemoryWorkflowEngine)),
          // The gate phase now writes an expiry settlement where the queue reads, so every workflow
          // body consumes the repository beside the gate.
          InMemoryGateRepository.layer,
          inMemoryExecutionServices,
        ),
      ),
      Layer.provide(buildInfoLayer),
    ),
  );

/**
 * The cluster engine moves work by polling its own mailboxes, so a settle is a clock step rather
 * than a yield — thirty virtual seconds, as `InMemoryClusterEngine`'s own suite does it.
 */
const settle = settleThenAdvance(Duration.seconds(30));

const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

const start = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
) => serviceFreeWorkflowEffect(definition.execute(payload, { discard: true }));

const status = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  executionId: string,
) =>
  Effect.map(serviceFreeWorkflowEffect(definition.poll(executionId)), (polled) =>
    Option.match(polled, {
      onNone: () => "running" as const,
      onSome: (result) =>
        result._tag === "Suspended"
          ? "suspended"
          : Exit.isSuccess(result.exit)
            ? "succeeded"
            : "failed",
    }),
  );

/** The human, answering the asking that is waiting now. */
const answer = (choice: string, reason: string) =>
  Effect.gen(function* () {
    const requests = yield* requested;
    yield* answerGate({
      token: requests[requests.length - 1]?.token as DurableDeferred.Token,
      choice,
      reason,
      answerer: "kevin",
    });
    yield* settle;
  });

describe("a run that fails after changing something outside itself", () => {
  it.effect("returns the ticket to the status it really found, and reports the failure", () =>
    Effect.gen(function* () {
      const runId = yield* start(factory.definition, { subject: "one" });
      yield* settle;

      // The claim landed, and the run is waiting on a human holding nothing.
      expect(board.status).toBe("in progress");
      expect(yield* status(factory.definition, runId)).toBe("suspended");
      expect(put).toEqual([]);

      yield* answer("reject", "not what I asked for");
      expect(yield* status(factory.definition, runId)).toBe("failed");

      // Put back — to `ready`, which is what the claim phase *found*. The body replayed on the way
      // here and the claim activity handed its recorded value back rather than reading the board a
      // second time, which is what makes the restored status the true one rather than the one the
      // run itself wrote.
      expect(board.status).toBe("ready");
      expect(put).toEqual(["ticket -> ready (NotAccepted)", "ticket -> ready (NotAccepted)"]);

      // And the failure is reported, naming the branch a human goes and looks at. The branch is
      // preserved: nothing on this path touches git at all.
      expect(board.comments).toHaveLength(2);
      expect(board.comments[0]).toContain("NotAccepted");
      expect(board.comments[0]).toContain("kevin: not what I asked for");
      expect(board.comments[0]).toContain(`The branch ${runBranch(runId as RunId)} is preserved.`);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("undoes nothing when the run succeeds", () =>
    Effect.gen(function* () {
      const runId = yield* start(factory.definition, { subject: "two" });
      yield* settle;
      yield* answer("approve", "looks right");

      expect(yield* status(factory.definition, runId)).toBe("succeeded");
      // The ticket stays claimed and nothing is put back: compensation is the failure path only.
      expect(board.status).toBe("in progress");
      expect(board.comments).toEqual([]);
      expect(put).toEqual([]);
      expect(ran).toEqual(["claim", "land"]);
      expect(ended).toEqual(["success", "success"]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("undoes nothing while it waits at the gate", () =>
    Effect.gen(function* () {
      const runId = yield* start(factory.definition, { subject: "patient" });
      yield* settle;

      // Suspension leaves the workflow instance open and never closes its scope, so a run waiting on
      // a human has registered its undos and run none of them. Were that not so, every gate would
      // roll its run back the moment it asked the question.
      expect(yield* status(factory.definition, runId)).toBe("suspended");
      expect(board.status).toBe("in progress");
      expect(put).toEqual([]);
      expect(ended).toEqual([]);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("a compensation registered inside an activity", () => {
  it.effect("never fires, while the one in the factory body does", () =>
    Effect.gen(function* () {
      const runId = yield* start(nested.definition, { subject: "one" });
      yield* settle;

      expect(yield* status(nested.definition, runId)).toBe("failed");
      // Both bodies ran, so both registrations were reached.
      expect(ran).toEqual(["outer", "inner"]);
      // Only the one written in the factory body has an instance scope that closes with the run.
      // The other attached to the activity's throwaway instance, whose scope closed on the
      // activity's own success. This is the whole reason compensation belongs in the factory body.
      expect(put).toEqual(["outer undone"]);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("what a lane undoes, and what the run undoes", () => {
  it.effect("closes the lane's scope at the suspension, and compensates the run at the end", () =>
    Effect.gen(function* () {
      const runId = yield* start(laned.definition, { subject: "one" });
      yield* settle;

      // The lane gave back what it held as the gate interrupted it — its own scope's job, and it
      // happens while the human is still reading the question. The run's compensation has not fired.
      expect(yield* status(laned.definition, runId)).toBe("suspended");
      expect(put).toEqual(["lane released: interrupted"]);

      yield* answer("reject", "no");
      expect(yield* status(laned.definition, runId)).toBe("failed");

      // The replay re-entered the lane, so the lane released a second time — on the failure this
      // time — and the run's compensation fired once, after it, when the whole run was over.
      expect(put).toEqual([
        "lane released: interrupted",
        "lane released: failed",
        "run compensated: NotAccepted",
        "run compensated: NotAccepted",
      ]);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("run-lifetime cleanup", () => {
  /**
   * Two virtual days at 100 ms of virtual time per poll is about three seconds of real time on this
   * engine, which is why this is the only test here that moves the clock by days and why it carries
   * its own timeout. What it buys is the claim in its own words: the wait is *days*, not a yield.
   */
  it.effect(
    "survives a two-day gate and fires once, when the run ends",
    () =>
      Effect.gen(function* () {
        const runId = yield* start(factory.definition, { subject: "long" });
        yield* settle;

        // Registered on the first execution of the body, and not fired by the suspension.
        expect(yield* status(factory.definition, runId)).toBe("suspended");
        expect(ended).toEqual([]);

        yield* settleThenAdvance(Duration.days(2));
        expect(yield* status(factory.definition, runId)).toBe("suspended");
        expect(ended).toEqual([]);

        yield* answer("approve", "two days later");
        expect(yield* status(factory.definition, runId)).toBe("succeeded");

        // Once — not once per execution of the body. The suspended instance's scope was never
        // closed, and the replay registered the finalizer again on the instance that ended the run.
        expect(ended).toEqual(["success", "success"]);
      }).pipe(Effect.provide(layerFor())),
    30000,
  );

  it.effect("fires on the failing path too, with the exit the run really had", () =>
    Effect.gen(function* () {
      const runId = yield* start(factory.definition, { subject: "short" });
      yield* settle;
      yield* answer("reject", "no");

      expect(yield* status(factory.definition, runId)).toBe("failed");
      expect(ended).toEqual(["failed", "failed"]);
      expect(put).toEqual(["ticket -> ready (NotAccepted)", "ticket -> ready (NotAccepted)"]);
    }).pipe(Effect.provide(layerFor())),
  );
});
