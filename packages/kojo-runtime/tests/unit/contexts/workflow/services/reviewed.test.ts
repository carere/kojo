import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import type { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import * as InMemoryGate from "../../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateRejected } from "../../../../../src/contexts/gate/models/GateRejected.ts";
import { GateUnreachable } from "../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../src/contexts/gate/models/OnExpiry.ts";
import { answerGate, parseToken } from "../../../../../src/contexts/gate/services/answerGate.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { NotAccepted } from "../../../../../src/contexts/workflow/models/NotAccepted.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { approval, reviewed } from "../../../../../src/contexts/workflow/services/reviewed.ts";
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
import { settle, settleThenAdvance } from "../../../../support/settleThenAdvance.ts";

const deadline = Duration.days(7);

/** The reviewer's own words, once per revision that genuinely ran. */
const revisions: Array<string> = [];

beforeEach(() => {
  revisions.length = 0;
});

/**
 * The revision step, as a real phase.
 *
 * A phase rather than a bare effect, because that is what makes the count trustworthy: a recorded
 * activity replays without running its body, so an entry in `revisions` means the work was actually
 * done on that round rather than read back from a previous one.
 */
const revise = (name: string, reason: string, subject: number) =>
  code(
    {
      name,
      description: "Address what the reviewer refused",
      success: Schema.Finite,
      error: Schema.Never,
    },
    Effect.sync(() => {
      revisions.push(reason);
      return subject + 1;
    }),
  );

const failures = Schema.Union([GateRejected, GateExpired, GateUnreachable]);

/**
 * The defect this ticket exists to prevent, written exactly as an author would write it.
 *
 * Every part of this is careful except one: the revision is named per round, so it gets its own
 * persistence slot and genuinely re-runs. Only the gate keeps a single name across the loop — which
 * is the mistake the design record itself shipped, and the whole difference between this workflow
 * and the one below it.
 */
const naive = workflow(
  {
    name: "naive",
    payload: { subject: Schema.String, limit: Schema.Finite },
    success: Schema.Finite,
    error: failures,
    idempotencyKey: (payload) => `naive/${payload.subject}`,
  },
  (payload) =>
    Effect.gen(function* () {
      let draft = 0;
      let last = "never approved";

      for (let round = 1; round <= payload.limit; round++) {
        const verdict = yield* gate({
          name: "review",
          description: "Does this land on main?",
          actor: "engineer",
          choices: ["approve", "reject"],
          deadline,
          onExpiry: OnExpiry.fail(),
          asking: 1,
        });

        if (verdict.choice === "approve") return draft;
        last = verdict.reason;
        draft = yield* revise(`revise_${round}`, verdict.reason, draft);
      }

      return yield* new GateRejected({ gate: "review", actor: "engineer", reason: last });
    }),
);

/** The same loop, handed to `reviewed`. The author names nothing per round and threads no counter. */
const looped = workflow(
  {
    name: "looped",
    payload: { subject: Schema.String, limit: Schema.Finite },
    success: Schema.Finite,
    error: failures,
    idempotencyKey: (payload) => `looped/${payload.subject}`,
  },
  (payload) =>
    reviewed({
      name: "review",
      description: "Does this land on main?",
      actor: "engineer",
      limit: payload.limit,
      deadline,
      onExpiry: OnExpiry.fail(),
      subject: 0,
      context: (draft) => ({ revision: String(draft) }),
      revise: (verdict, draft) => revise("revise", verdict.reason, draft),
    }),
);

/** A loop whose revision fails for a reason that has nothing to do with the reviewer. */
const brittle = workflow(
  {
    name: "brittle",
    payload: { subject: Schema.String },
    success: Schema.Finite,
    error: Schema.Union([NotAccepted, GateRejected, GateExpired, GateUnreachable]),
    idempotencyKey: (payload) => `brittle/${payload.subject}`,
  },
  () =>
    reviewed({
      name: "review",
      description: "Does this land on main?",
      actor: "engineer",
      limit: 5,
      deadline,
      onExpiry: OnExpiry.fail(),
      subject: 0,
      revise: () => Effect.fail(new NotAccepted({ reason: "the branch is gone" })),
    }),
);

const layerFor = (answers: Record<string, ReadonlyArray<InMemoryGate.ProgrammedAnswer>> = {}) =>
  selfContainedTestLayer(
    Layer.mergeAll(naive.layer, looped.layer, brittle.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          InMemoryTracer.layer,
          InMemoryGate.layer(answers).pipe(Layer.provideMerge(inMemoryWorkflowEngine)),
          // The gate phase now writes an expiry settlement where the queue reads, so every workflow
          // body consumes the repository beside the gate.
          InMemoryGateRepository.layer,
          inMemoryExecutionServices,
        ),
      ),
      Layer.provide(buildInfoLayer),
    ),
  );

const execute = serviceFreeWorkflowEffect;
const poll = serviceFreeWorkflowEffect;

/**
 * `execute` does not return while a run is suspended, so every test here starts with
 * `discard: true` and asks `poll`. Time moves through `settleThenAdvance`, never through a bare
 * `TestClock.adjust`.
 */

const statusOf = (
  polled: Effect.Effect<
    Option.Option<{ readonly _tag: string }>,
    never,
    WorkflowEngine.WorkflowEngine
  >,
) =>
  Effect.map(polled, (result) =>
    Option.match(result, {
      onNone: () => "running" as const,
      onSome: (polled) => polled._tag,
    }),
  );

const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

const traced = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) =>
  Effect.zip(trace.gates, trace.phases),
);

const answer = (token: DurableDeferred.Token, choice: string, reason: string) =>
  Effect.gen(function* () {
    yield* answerGate({ token, choice, reason, answerer: "kevin" });
    yield* settle;
  });

/** The token of the asking that is waiting now — the last one requested. */
const waiting = Effect.map(
  requested,
  (requests) => requests[requests.length - 1]?.token as DurableDeferred.Token,
);

const exitOf = <E>(result: unknown) => (result as Workflow.Complete<number, E>).exit;

/** The typed error a finished run failed with, or nothing if it succeeded. */
const failureOf = <E>(exit: Exit.Exit<number, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("a hand-written loop", () => {
  it.effect("runs every round against one stale verdict, and never suspends again", () =>
    Effect.gen(function* () {
      const executionId = yield* execute(
        naive.definition.execute({ subject: "fixed", limit: 5 }, { discard: true }),
      );
      yield* settle;
      expect(yield* statusOf(poll(naive.definition.poll(executionId)))).toBe("Suspended");

      // One human, asked once, answering once.
      yield* answer(yield* waiting, "reject", "needs work");

      // And a run that believes it was reviewed five times. A `DurableDeferred` is keyed
      // `executionId/name` and refuses to overwrite, so every later round read the recorded
      // rejection back instantly instead of stopping for a person.
      expect(yield* statusOf(poll(naive.definition.poll(executionId)))).toBe("Complete");
      expect(yield* requested).toHaveLength(1);
      expect(revisions).toEqual(Array.from({ length: 5 }, () => "needs work"));

      // Four of the five rounds are invisible: one asking, one record, no latency to read.
      const [gates] = yield* traced;
      expect(gates).toHaveLength(1);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("the reviewed loop", () => {
  it.effect("suspends on every asking, and leaves one gate record per round", () =>
    Effect.gen(function* () {
      const executionId = yield* execute(
        looped.definition.execute({ subject: "distinct", limit: 5 }, { discard: true }),
      );
      yield* settle;

      expect(yield* statusOf(poll(looped.definition.poll(executionId)))).toBe("Suspended");
      expect(yield* requested).toHaveLength(1);
      expect((yield* parseToken((yield* requested)[0]?.token ?? "")).deferredName).toBe(
        "gate/review/1",
      );

      // A day of thinking, then a rejection. The next asking is a genuine suspension.
      yield* settleThenAdvance(Duration.days(1));
      yield* answer(yield* waiting, "reject", "needs work");

      expect(yield* statusOf(poll(looped.definition.poll(executionId)))).toBe("Suspended");
      const second = yield* requested;
      expect(second).toHaveLength(2);
      expect(second[1]?.token).not.toBe(second[0]?.token);
      expect((yield* parseToken(second[1]?.token ?? "")).deferredName).toBe("gate/review/2");
      // The second asking is about the revised subject, not the one already refused.
      expect(second[1]?.description).toContain("revision: 1");

      yield* settleThenAdvance(Duration.days(3));
      yield* answer(yield* waiting, "reject", "still not it");

      expect(yield* statusOf(poll(looped.definition.poll(executionId)))).toBe("Suspended");
      expect(yield* requested).toHaveLength(3);

      yield* settleThenAdvance(Duration.days(2));
      // The loop's choices are its own, not the author's, so the approving word comes from it.
      yield* answer(yield* waiting, approval, "better");

      expect(yield* statusOf(poll(looped.definition.poll(executionId)))).toBe("Complete");
      const result = Option.getOrThrow(yield* poll(looped.definition.poll(executionId)));
      const exit = exitOf<never>(result);
      // Two rejections, two revisions, and the approved subject comes back.
      expect(Exit.isSuccess(exit) && exit.value).toBe(2);
      expect(revisions).toEqual(["needs work", "still not it"]);

      const [gates, phases] = yield* traced;
      expect(gates.map((record) => record.asking)).toEqual([
        "gate/review/1",
        "gate/review/2",
        "gate/review/3",
      ]);
      expect(gates.map((record) => record.choice)).toEqual(["reject", "reject", "approve"]);
      // Per-round human latency, which is the whole reason one record per asking is worth keeping.
      expect(gates.map((record) => record.latencyMillis)).toEqual([
        Option.some(Duration.toMillis(Duration.days(1))),
        Option.some(Duration.toMillis(Duration.days(3))),
        Option.some(Duration.toMillis(Duration.days(2))),
      ]);

      // The author named one phase, and the engine's own attempt counter gave each round its own
      // record and its own persistence slot.
      const revised = phases.filter((record) => record.name === "revise");
      expect(revised.map((record) => record.attempt)).toEqual([1, 2]);
      expect(new Set(revised.map((record) => record.phaseId)).size).toBe(2);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("returns the subject unchanged when the first asking approves", () =>
    Effect.gen(function* () {
      const executionId = yield* execute(
        looped.definition.execute({ subject: "clean", limit: 5 }, { discard: true }),
      );
      yield* settle;

      const result = Option.getOrThrow(yield* poll(looped.definition.poll(executionId)));
      const exit = exitOf<never>(result);
      expect(Exit.isSuccess(exit) && exit.value).toBe(0);
      expect(revisions).toEqual([]);
      expect(yield* requested).toHaveLength(1);
    }).pipe(Effect.provide(layerFor({ review: [{ choice: "approve", reason: "reads fine" }] }))),
  );

  it.effect("exhausting the bound is a typed failure, and the last asking revises nothing", () =>
    Effect.gen(function* () {
      const executionId = yield* execute(
        looped.definition.execute({ subject: "stubborn", limit: 2 }, { discard: true }),
      );
      yield* settle;

      expect(yield* statusOf(poll(looped.definition.poll(executionId)))).toBe("Complete");
      const result = Option.getOrThrow(yield* poll(looped.definition.poll(executionId)));
      const exit = exitOf<GateRejected>(result);
      expect(Exit.isFailure(exit)).toBe(true);

      // The failure says why it was refused, not merely how often — the reviewer's own last words.
      const failure = failureOf(exit);
      expect(failure?._tag).toBe("GateRejected");
      expect(failure?.reason).toBe("still no");

      // Two askings, one revision: nothing is revised for a human who will not be asked again.
      expect(yield* requested).toHaveLength(2);
      expect(revisions).toEqual(["not yet"]);
    }).pipe(
      Effect.provide(
        layerFor({
          review: [
            { choice: "reject", reason: "not yet" },
            { choice: "reject", reason: "still no" },
          ],
        }),
      ),
    ),
  );

  it.effect("lets a failure from the revision travel out untouched", () =>
    Effect.gen(function* () {
      const executionId = yield* execute(
        brittle.definition.execute({ subject: "broken" }, { discard: true }),
      );
      yield* settle;

      const result = Option.getOrThrow(yield* poll(brittle.definition.poll(executionId)));
      const exit = exitOf<NotAccepted>(result);
      expect(Exit.isFailure(exit)).toBe(true);
      // Not a rejection, so it is not retried and it is not renamed on the way out.
      expect(failureOf(exit)?._tag).toBe("NotAccepted");
      expect(yield* requested).toHaveLength(1);
    }).pipe(Effect.provide(layerFor({ review: [{ choice: "reject", reason: "no" }] }))),
  );
});
