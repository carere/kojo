import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Schema } from "effect";
import type { DurableDeferred } from "effect/unstable/workflow";
import * as InMemoryAgentInvoker from "../../../../../src/contexts/agent/adapters/InMemoryAgentInvoker.ts";
import { AgentInvocationError } from "../../../../../src/contexts/agent/models/AgentInvocationError.ts";
import * as InMemoryGate from "../../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../../../../src/contexts/gate/models/Verdict.ts";
import { answerGate } from "../../../../../src/contexts/gate/services/answerGate.ts";
import * as InMemorySandboxSource from "../../../../../src/contexts/sandbox/adapters/InMemorySandboxSource.ts";
import { SandboxError } from "../../../../../src/contexts/sandbox/models/SandboxError.ts";
import { tagged } from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";
import { WorkspaceError } from "../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import { WorkspaceUnreachable } from "../../../../../src/contexts/sandbox/models/WorkspaceUnreachable.ts";
import { WorktreeUnusable } from "../../../../../src/contexts/sandbox/models/WorktreeUnusable.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import * as InMemoryEngine from "../../../../../src/contexts/workflow/adapters/InMemoryEngine.ts";
import { CheckViolation } from "../../../../../src/contexts/workflow/models/CheckViolation.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { agent } from "../../../../../src/contexts/workflow/services/phase/agent.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { start, status } from "../../../../../src/contexts/workflow/services/run.ts";
import { sandboxed } from "../../../../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { settle, settleThenAdvance } from "../../../../support/settleThenAdvance.ts";

/**
 * Suspension, resumption and expiry, as ordinary unit tests.
 *
 * This file is the proof of the whole durability claim. A run stops at a gate, holds nothing, and
 * continues days later where it stopped — and the thing that makes that survivable is that a resumed
 * run **replays its body from the top**, with only recorded phase results handed back. Everything
 * outside a phase runs again. So the assertions here are all shaped the same way: count what ran.
 *
 * Nothing below reads a wall clock or spawns anything. Seven virtual days pass in the time it takes
 * to walk `settleThenAdvance`, so the fact that these tests finish inside vitest's five-second
 * budget is itself the measurement.
 */

const deadline = Duration.days(7);

/** What a scouting agent hands back. One field, because the envelope is not what is under test. */
class Notes extends Schema.Class<Notes>("Notes")({ finding: Schema.String }) {}

/** Everything a workflow's error channel has to admit once it holds a gate and an agent phase. */
const failures = Schema.Union([
  GateExpired,
  GateUnreachable,
  EnvelopeParseError,
  AgentInvocationError,
  CheckViolation,
  WorkspaceError,
  SandboxError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

/** Every phase body that genuinely ran, in order. A replayed phase adds nothing here. */
const ran: Array<string> = [];

/** Everything a workflow did *outside* a phase. This one grows on every replay, and that is the point. */
const stray: Array<string> = [];

beforeEach(() => {
  ran.length = 0;
  stray.length = 0;
});

/**
 * What was taken and what was given back, in order, as the fake sandbox watched it happen.
 *
 * Read from `ObservedSandboxes` rather than from a module-level array, because the thing under test
 * is now the real `sandboxed` scope: nothing in the workflow body pushes here, so the sequence is
 * the adapter's account of what the scope did, not the author's account of what they meant.
 */
const holds = Effect.flatMap(InMemorySandboxSource.ObservedSandboxes, (observed) =>
  Effect.map(observed.events, (events) => events.map((event) => event.moment)),
);

/**
 * One code phase whose only work is to say it ran.
 *
 * A phase rather than a bare effect, because that is what makes the count trustworthy: a recorded
 * activity replays without running its body, so an entry here means the work was done on that round.
 */
const step = (name: string) =>
  code(
    { name, description: `the ${name} step`, success: Schema.Void, error: Schema.Never },
    Effect.sync(() => void ran.push(name)),
  );

const stop = (name: string, onExpiry: OnExpiry.OnExpiry = OnExpiry.fail()) =>
  gate({
    name,
    description: `does ${name} pass?`,
    actor: "engineer",
    choices: ["approve", "reject"],
    deadline,
    onExpiry,
    asking: 1,
  });

/**
 * A run that stops three times, with a phase of every kind between the stops.
 *
 * The agent is scripted with a **list of one**, which is exhausted rather than recycled. So a scout
 * phase that re-ran on replay would not merely double a counter — the invoker would refuse the
 * second call and the run would fail. The most expensive thing a factory does is the thing this
 * proves happens once.
 */
const assembly = workflow(
  {
    name: "assembly",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `assembly/${payload.subject}`,
  },
  () =>
    Effect.gen(function* () {
      yield* step("prepare");
      yield* stop("plan");

      const notes = yield* agent({
        name: "scout",
        description: "Read the ticket and say what is there",
        agent: "scout",
        prompt: "What is here?",
        envelope: Notes,
      });

      yield* stop("approve");
      yield* step("verify");
      yield* stop("merge");
      yield* step("land");

      return notes.finding;
    }),
);

/**
 * The same run with one line moved out of a phase — the defect this suite exists to catch.
 *
 * Written the way an author writes it by accident: a `push` that looks harmless next to a phase that
 * looks identical. In a real workflow it is the `git push`, the ticket transition, or the Slack
 * message that fires again days later when a human finally answers.
 */
const undisciplined = workflow(
  {
    name: "undisciplined",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `undisciplined/${payload.subject}`,
  },
  () =>
    Effect.gen(function* () {
      yield* step("prepare");
      yield* Effect.sync(() => void stray.push("push"));

      yield* stop("plan");
      yield* stop("approve");
      yield* stop("merge");

      return "landed";
    }),
);

/**
 * A run that holds a **sandbox** for the length of a gate — the real scope, not a stand-in.
 *
 * This was written against a bare `Effect.acquireRelease` while ticket 17 was still in flight, and
 * the substitution mattered: a plain scope proves that *suspension unwinds a scope*, which is a
 * claim about Effect. Pointing it at `sandboxed` proves that **Kojo's sandbox scope is placed where
 * that happens to it** — outside every phase, local rather than `Workflow.scope`, and built through
 * a memo map of its own so the replay cannot hand back the container it already released. Those are
 * three decisions in `sandboxed.ts` that a bare `acquireRelease` could not have graded.
 */
const held = workflow(
  {
    name: "held",
    payload: { subject: Schema.String },
    success: Verdict,
    error: failures,
    idempotencyKey: (payload) => `held/${payload.subject}`,
  },
  () =>
    sandboxed(
      {
        name: "held",
        branch: "kojo/held",
        provider: tagged("bind-mount", { name: "fake", env: {} }),
      },
      stop("approve"),
    ),
);

/** A run whose next step is chosen by what the gate settled as, expiry included. */
const deadlined = workflow(
  {
    name: "deadlined",
    payload: { subject: Schema.String, onExpiry: Schema.Literals(["fail", "reject"]) },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `deadlined/${payload.subject}`,
  },
  (payload) =>
    Effect.gen(function* () {
      const verdict = yield* stop(
        "approve",
        payload.onExpiry === "fail"
          ? OnExpiry.fail()
          : OnExpiry.reject({ choice: "reject", reason: "nobody answered in time" }),
      );

      yield* step(verdict.choice === "approve" ? "merge" : "abandon");
      return verdict.choice;
    }),
);

const layerFor = () =>
  Layer.mergeAll(assembly.layer, undisciplined.layer, held.layer, deadlined.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        InMemorySandboxSource.layer(),
        InMemoryAgentInvoker.layer({ scout: [{ envelope: { finding: "it compiles" } }] }),
        InMemoryGate.layer().pipe(Layer.provideMerge(InMemoryEngine.layer)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

const phasesOf = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.phases);

const gatesOf = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.gates);

/** The human, answering whichever asking is waiting now — always the last one requested. */
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

/** Starts the three-gate run and answers all three askings, a day of thinking between each. */
const throughEveryGate = Effect.gen(function* () {
  const runId = yield* start(assembly.definition, { subject: "one" });
  yield* settle;

  for (const reason of ["the plan reads fine", "the work reads fine", "land it"]) {
    expect(yield* status(assembly.definition, runId)).toBe("suspended");
    yield* settleThenAdvance(Duration.days(1));
    yield* answer("approve", reason);
  }

  return runId;
});

describe("a deadline nobody answers", () => {
  it.effect("takes the declared expiry branch after seven virtual days", () =>
    Effect.gen(function* () {
      const runId = yield* start(deadlined.definition, { subject: "quiet", onExpiry: "reject" });
      yield* settle;
      expect(yield* status(deadlined.definition, runId)).toBe("suspended");
      expect(ran).toEqual([]);

      // Seven days of nobody answering. That this test finishes at all is the measurement: a
      // durable sleep that read a wall clock would outlive vitest by six days and change.
      yield* settleThenAdvance(deadline);

      expect(yield* status(deadlined.definition, runId)).toBe("succeeded");
      // The declared branch, run: `abandon`, and never `merge`. An expiry that only failed the run
      // would leave this empty, and an expiry that guessed would leave the wrong entry.
      expect(ran).toEqual(["abandon"]);

      const gates = yield* gatesOf;
      expect(gates).toHaveLength(1);
      expect(gates[0]?.outcome).toBe("expired");
      // Nobody answered, so nothing may claim to have answered.
      expect(gates[0]?.answerer).toBeUndefined();
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("ends the branch that assumed an answer when the declared branch is fail", () =>
    Effect.gen(function* () {
      const runId = yield* start(deadlined.definition, { subject: "silent", onExpiry: "fail" });
      yield* settle;

      yield* settleThenAdvance(deadline);

      expect(yield* status(deadlined.definition, runId)).toBe("failed");
      // Nothing downstream of the gate ran on a verdict that never came.
      expect(ran).toEqual([]);
      expect(yield* phasesOf).toEqual([]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("holds the run open for the whole deadline, and not a millisecond less", () =>
    Effect.gen(function* () {
      const runId = yield* start(deadlined.definition, { subject: "patient", onExpiry: "reject" });
      yield* settle;

      // One millisecond short of the deadline the run is still waiting: a gate that expired early
      // would answer on a human's behalf while the human still had time.
      yield* settleThenAdvance(Duration.subtract(deadline, Duration.millis(1)));
      expect(yield* status(deadlined.definition, runId)).toBe("suspended");

      yield* settleThenAdvance(Duration.millis(1));
      expect(yield* status(deadlined.definition, runId)).toBe("succeeded");
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("a run that stops at every gate", () => {
  it.effect("resumes through all three, and every phase ran exactly once", () =>
    Effect.gen(function* () {
      const runId = yield* start(assembly.definition, { subject: "one" });
      yield* settle;

      // Stop one. Only what precedes it has run.
      expect(yield* status(assembly.definition, runId)).toBe("suspended");
      expect(ran).toEqual(["prepare"]);

      yield* answer("approve", "the plan reads fine");
      // Stop two. The replay handed `prepare` back rather than running it again, and the scout —
      // the expensive call — happened once, on this round.
      expect(yield* status(assembly.definition, runId)).toBe("suspended");
      expect(ran).toEqual(["prepare"]);

      yield* answer("approve", "the work reads fine");
      expect(yield* status(assembly.definition, runId)).toBe("suspended");
      expect(ran).toEqual(["prepare", "verify"]);

      yield* answer("approve", "land it");
      expect(yield* status(assembly.definition, runId)).toBe("succeeded");

      // Three suspensions, four replays of the body, and one execution of each phase. This is the
      // assertion that catches a side effect placed outside a phase.
      expect(ran).toEqual(["prepare", "verify", "land"]);
      expect(yield* requested).toHaveLength(3);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("calls the agent once, however many times the body replays", () =>
    Effect.gen(function* () {
      const runId = yield* throughEveryGate;

      // The scout was scripted with a list of one. A second call would be refused as exhausted and
      // this run would have failed, so a succeeded run *is* the exactly-once assertion.
      expect(yield* status(assembly.definition, runId)).toBe("succeeded");

      const scouted = (yield* phasesOf).filter((record) => record.name === "scout");
      expect(scouted).toHaveLength(1);
      expect(scouted[0]?.kind).toBe("agent");
      expect(scouted[0]?.agent?.session).toBe("scout-session-1");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("leaves one record per phase after three suspensions, not one per replay", () =>
    Effect.gen(function* () {
      yield* throughEveryGate;

      // The duplicate-row test. The trace write lives *inside* each activity; around it, it would
      // sit outside the recorded boundary and re-run on every replay, leaving ten rows for these
      // four phases.
      const phases = yield* phasesOf;
      expect(phases.map((record) => record.name)).toEqual(["prepare", "scout", "verify", "land"]);
      expect(new Set(phases.map((record) => record.phaseId)).size).toBe(4);
      expect(phases.map((record) => record.attempt)).toEqual([1, 1, 1, 1]);
      expect(phases.map((record) => record.outcome)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
      ]);

      // One record per asking, for the same reason.
      const gates = yield* gatesOf;
      expect(gates.map((record) => record.gate)).toEqual(["plan", "approve", "merge"]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("re-runs anything left outside a phase, once per replay", () =>
    Effect.gen(function* () {
      const runId = yield* start(undisciplined.definition, { subject: "loose" });
      yield* settle;
      expect(stray).toEqual(["push"]);

      yield* answer("approve", "the plan reads fine");
      yield* answer("approve", "the work reads fine");
      yield* answer("approve", "land it");
      expect(yield* status(undisciplined.definition, runId)).toBe("succeeded");

      // Four executions of the body — the first and one per resume — and the loose line fired on
      // every one of them. Days apart, in a real factory.
      expect(stray).toHaveLength(4);
      // The line beside it, inside a phase, ran once. Same body, same run, one `code` apart: this
      // is what makes the exactly-once assertions above worth writing.
      expect(ran).toEqual(["prepare"]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("starts once and says it is suspended, not finished, while it waits", () =>
    Effect.gen(function* () {
      const runId = yield* start(assembly.definition, { subject: "one" });
      yield* settle;

      const trace = yield* InMemoryTracer.RecordedTrace;
      // A run stopped at a gate has not failed. Reading the raw exit calls it one, because
      // suspension *is* an interrupt of the run's fiber — and it would say so for the whole two
      // days a human takes to answer.
      expect(yield* trace.outcomes).toEqual(new Map([[runId, "suspended"]]));

      yield* answer("approve", "the plan reads fine");
      yield* answer("approve", "the work reads fine");
      yield* answer("approve", "land it");

      // One run, one start, whatever the body replayed. The second start would carry the time of
      // the resume, so a duplicate here is also a lie about when the run began.
      const runs = yield* trace.runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.runId).toBe(runId);
      expect(runs[0]?.startedAt).toBe(0);
      expect(yield* trace.outcomes).toEqual(new Map([[runId, "succeeded"]]));
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("what a run holds while it waits", () => {
  it.effect("releases its sandbox at suspension and builds another one on resume", () =>
    Effect.gen(function* () {
      const runId = yield* start(held.definition, { subject: "scope" });
      yield* settle;

      // Suspension is an ordinary interrupt, so the scope unwinds where it stands — before the
      // human has even read the question.
      expect(yield* status(held.definition, runId)).toBe("suspended");
      expect(yield* holds).toEqual(["acquired", "released"]);

      // Two days of holding nothing. A sandbox kept across this is a container nobody is using and
      // a lock nobody can take.
      yield* settleThenAdvance(Duration.days(2));
      expect(yield* holds).toEqual(["acquired", "released"]);

      yield* answer("approve", "reads fine");
      expect(yield* status(held.definition, runId)).toBe("succeeded");

      // Taken again by the replay, and given back when the run finished. The rebuild is what the
      // run pays for suspending, and it is the reason a gate is placed deliberately.
      expect(yield* holds).toEqual(["acquired", "released", "acquired", "released"]);

      // A *second container*, not the first one handed back: the two acquisitions carry different
      // sandbox ids, so nothing about the released container survived into the rebuild. The
      // sequence above alone would not say that — a reused handle could produce it too.
      //
      // This does **not** grade `{ local: true }` in `sandboxed.ts`. Measured: removing that option
      // leaves all 218 unit tests green, because `MemoMapImpl` keys on layer *object identity* and
      // `sandboxed` builds a fresh `layers(config)` on every call, so a shared memo map has nothing
      // to match. The option is defensive against a future hoist, not a thing under test here.
      const observed = yield* Effect.flatMap(
        InMemorySandboxSource.ObservedSandboxes,
        (it) => it.events,
      );
      expect(new Set(observed.map((event) => event.id)).size).toBe(2);

      // One trace row per acquisition, and the one a gate interrupted is not a fault.
      const sandboxes = yield* Effect.flatMap(
        InMemoryTracer.RecordedTrace,
        (trace) => trace.sandboxes,
      );
      expect(sandboxes.map((record) => record.outcome)).toEqual(["interrupted", "released"]);
    }).pipe(Effect.provide(layerFor())),
  );
});
