import { describe, expect, it } from "@effect/vitest";
import { Context, Duration, Effect, Exit, Latch, Layer, Option, Schema } from "effect";
import { type DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import * as InMemoryGate from "../../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../src/contexts/gate/models/OnExpiry.ts";
import { answerGate } from "../../../../../src/contexts/gate/services/answerGate.ts";
import * as InMemorySandboxSource from "../../../../../src/contexts/sandbox/adapters/InMemorySandboxSource.ts";
import { SandboxError } from "../../../../../src/contexts/sandbox/models/SandboxError.ts";
import { tagged } from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";
import { WorkspaceError } from "../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import { WorkspaceUnreachable } from "../../../../../src/contexts/sandbox/models/WorkspaceUnreachable.ts";
import { WorktreeUnusable } from "../../../../../src/contexts/sandbox/models/WorktreeUnusable.ts";
import { Sandbox } from "../../../../../src/contexts/sandbox/ports/Sandbox.ts";
import { laneOf } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { sandboxed } from "../../../../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { settle, settleThenAdvance } from "../../../../support/settleThenAdvance.ts";

/**
 * **Two lanes of one factory, at the same time.**
 *
 * Every workflow here is one run with two `sandboxed` regions entered concurrently — two names, two
 * branches, two containers. That is what an author writes; no Kojo API decides the lanes
 * (architecture.md D1), and the two scopes are branches of the author's graph rather than one
 * wrapper around the run.
 *
 * The suite exists for the constraint typescript-effect.md §3 measured and nothing had yet driven:
 * **suspension waits for sibling activities.** A gate cannot suspend its run while any other
 * activity of that run is still executing, so a gate in one lane holds *both* containers open until
 * the other lane's phase finishes. That is why two lanes are not simply two lanes.
 */

const provider = tagged("bind-mount", { name: "fake", env: {} });

const alphaBranch = "kojo/lane/alpha";
const betaBranch = "kojo/lane/beta";

const failures = Schema.Union([
  GateExpired,
  GateUnreachable,
  SandboxError,
  WorkspaceError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

/**
 * The handshake that makes "at the same time" a fact rather than a hope.
 *
 * A test that forked two lanes and asserted on the order they happened to interleave would be
 * grading the scheduler. These latches let each lane say *I am inside my phase now* and let the test
 * say *you may leave it*, so the moment one lane's gate tries to suspend is a moment the other
 * lane's activity is provably still running.
 */
class Handshake extends Context.Service<
  Handshake,
  {
    readonly alphaUp: Latch.Latch;
    readonly betaUp: Latch.Latch;
    readonly release: Latch.Latch;
  }
>()("test/Handshake") {}

/** A fresh set per test. Module state would leak an open latch into the next case. */
const handshake = (): Handshake["Service"] => ({
  alphaUp: Latch.makeUnsafe(false),
  betaUp: Latch.makeUnsafe(false),
  release: Latch.makeUnsafe(false),
});

/** What crossed into *this* lane's container. A phase inside it carries the key back out. */
const correlation = Effect.map(Sandbox, (sandbox) => sandbox.environment.KOJO_PHASE_ID ?? "");

/** Alpha's phase in the rendezvous pair: announce, wait for beta, then read the key. */
const alphaMeet = code(
  {
    name: "alpha_read",
    description: "Read alpha's own correlation while beta is inside its phase",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.gen(function* () {
    const shook = yield* Handshake;
    yield* shook.alphaUp.open;
    yield* shook.betaUp.await;
    return yield* correlation;
  }),
);

/** Beta's half of the same rendezvous. Both phases are therefore inside their containers at once. */
const betaMeet = code(
  {
    name: "beta_read",
    description: "Read beta's own correlation while alpha is inside its phase",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.gen(function* () {
    const shook = yield* Handshake;
    yield* shook.betaUp.open;
    yield* shook.alphaUp.await;
    return yield* correlation;
  }),
);

/** Alpha's phase in the gate pair: it may not reach its gate until beta is provably working. */
const alphaBeforeGate = code(
  {
    name: "alpha_read",
    description: "Read alpha's correlation once beta's long phase is running",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.gen(function* () {
    const shook = yield* Handshake;
    yield* shook.betaUp.await;
    return yield* correlation;
  }),
);

/** The long one. It announces itself and then stays running until the test lets it go. */
const betaLong = code(
  {
    name: "beta_build",
    description: "A long phase in the other lane",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.gen(function* () {
    const shook = yield* Handshake;
    const key = yield* correlation;
    yield* shook.betaUp.open;
    yield* shook.release.await;
    return key;
  }),
);

const alphaReview = gate({
  name: "alpha_review",
  description: "Does alpha land?",
  actor: "engineer",
  choices: ["approve", "reject"],
  deadline: Duration.days(7),
  onExpiry: OnExpiry.fail(),
  asking: 1,
});

/** Two lanes that rendezvous inside their own containers, and neither one waits for a human. */
const together = workflow(
  {
    name: "together",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `together/${payload.subject}`,
  },
  () =>
    Effect.map(
      Effect.all(
        [
          sandboxed({ name: "alpha", branch: alphaBranch, provider }, alphaMeet),
          sandboxed({ name: "beta", branch: betaBranch, provider }, betaMeet),
        ],
        { concurrency: "unbounded" },
      ),
      ([alpha, beta]) => `${alpha}+${beta}`,
    ),
);

/** The same two lanes, with a gate in one of them and a long phase in the other. */
const gated = workflow(
  {
    name: "gated",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `gated/${payload.subject}`,
  },
  () =>
    Effect.map(
      Effect.all(
        [
          sandboxed(
            { name: "alpha", branch: alphaBranch, provider },
            Effect.gen(function* () {
              const key = yield* alphaBeforeGate;
              const verdict = yield* alphaReview;
              return `${key}/${verdict.choice}`;
            }),
          ),
          sandboxed({ name: "beta", branch: betaBranch, provider }, betaLong),
        ],
        { concurrency: "unbounded" },
      ),
      ([alpha, beta]) => `${alpha}+${beta}`,
    ),
);

/**
 * One gate expression, asked in both lanes — the mistake an author makes without noticing.
 *
 * Nothing here says which lane it belongs to. Before `gate` qualified its durable name by the
 * enclosing scope, this shape was silently catastrophic: measured, it produced **one** request,
 * **one** trace row, and one human's `approve` returned to both lanes.
 */
const sharedReview = gate({
  name: "review",
  description: "Does this lane land?",
  actor: "engineer",
  choices: ["approve", "reject"],
  deadline: Duration.days(7),
  onExpiry: OnExpiry.fail(),
  asking: 1,
});

/**
 * Alpha's holding phase, and the reason the shared-gate case needs one.
 *
 * Two lanes that both walk straight into a gate do not both get asked: whichever one suspends first
 * interrupts the other before its request activity has run, and which one that is depends on the
 * scheduler. So the sibling constraint is used *on purpose* here — alpha stays inside an activity
 * while beta asks, which parks beta's suspension instead of letting alpha's interrupt beat it. Both
 * questions are then out before either lane suspends, every time.
 */
const alphaHold = code(
  {
    name: "alpha_hold",
    description: "Keep alpha inside an activity while beta reaches its gate",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.gen(function* () {
    const shook = yield* Handshake;
    yield* shook.alphaUp.open;
    yield* shook.release.await;
    return yield* correlation;
  }),
);

const betaWait = code(
  {
    name: "beta_wait",
    description: "Let alpha get inside its phase first",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.flatMap(Handshake, (shook) => Effect.andThen(shook.alphaUp.await, correlation)),
);

const shared = workflow(
  {
    name: "shared",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `shared/${payload.subject}`,
  },
  () =>
    Effect.map(
      Effect.all(
        [
          sandboxed(
            { name: "alpha", branch: alphaBranch, provider },
            Effect.andThen(
              alphaHold,
              Effect.map(sharedReview, (verdict) => verdict.reason),
            ),
          ),
          sandboxed(
            { name: "beta", branch: betaBranch, provider },
            Effect.andThen(
              betaWait,
              Effect.map(sharedReview, (verdict) => verdict.reason),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ),
      ([alpha, beta]) => `${alpha}+${beta}`,
    ),
);

const seeded: InMemorySandboxSource.Programmed = {
  files: {
    [alphaBranch]: { "src/health.ts": "alpha" },
    [betaBranch]: { "src/health.ts": "beta" },
  },
};

const layerFor = (shook: Handshake["Service"]) =>
  Layer.mergeAll(together.layer, gated.layer, shared.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        InMemorySandboxSource.layer(seeded),
        Layer.succeed(Handshake, shook),
        InMemoryGate.layer({}).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

/**
 * Builds the latches and the layer from them, in that order.
 *
 * The layer has to hold the same latches the test body opens, so both come from one call. A test
 * that built its own set inside the generator would be signalling latches nobody was waiting on —
 * which passes the first assertion and hangs on the second.
 */
const withLanes = <A, E>(
  use: (shook: Handshake["Service"]) => Effect.Effect<A, E, Layer.Success<Lanes>>,
): Effect.Effect<A, E> => {
  const shook = handshake();
  return use(shook).pipe(Effect.provide(layerFor(shook)));
};

type Lanes = ReturnType<typeof layerFor>;

const observed = Effect.flatMap(
  InMemorySandboxSource.ObservedSandboxes,
  (sandboxes) => sandboxes.events,
);
const recorded = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.sandboxes);
const phases = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.phases);
const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

const statusOf = (executionId: string) =>
  Effect.map(gated.definition.poll(executionId), (polled) =>
    Option.match(polled, {
      onNone: () => "running" as const,
      onSome: (result) => result._tag,
    }),
  );

const sharedStatusOf = (executionId: string) =>
  Effect.map(shared.definition.poll(executionId), (polled) =>
    Option.match(polled, {
      onNone: () => "running" as const,
      onSome: (result) => result._tag,
    }),
  );

/**
 * A settle that is enough for a suspension which had to queue behind a sibling.
 *
 * Such a suspension is two hops behind an ordinary one, and the number was measured rather than
 * guessed: `waitForZero` releases the parked fiber on the first turn, and `Workflow.suspend`'s
 * interrupt travels out through `Effect.all` and both sandbox scopes on the second. One `settle`
 * still reads `running`. Four are used, so a spare turn does not turn an engine change into a
 * mystery — and the assertion this protects is the *second* half of the story anyway: the first half
 * is that the run is **not** suspended while the sibling works, and that one is asserted on a single
 * settle deliberately.
 */
const settleFully = Effect.gen(function* () {
  for (let turn = 0; turn < 4; turn += 1) yield* settle;
});

/** Do two intervals share a moment? The reading a timestamp join is forced to make. */
const overlaps = (
  first: { readonly from: number; readonly to: number },
  second: { readonly from: number; readonly to: number },
): boolean => first.from <= second.to && second.from <= first.to;

describe("two lanes of one run, in two sandboxes, on two branches", () => {
  it.effect("enters both scopes at once and keeps them apart", () =>
    withLanes((shook) =>
      Effect.gen(function* () {
        const started = yield* together.definition.execute({ subject: "both" }, { discard: true });
        yield* settle;
        expect(Latch.isOpen(shook.alphaUp) && Latch.isOpen(shook.betaUp)).toBe(true);

        const rows = yield* recorded;
        expect(rows.map((row) => row.name).sort()).toEqual(["alpha", "beta"]);
        expect(rows.map((row) => row.branch).sort()).toEqual([alphaBranch, betaBranch]);
        // Two acquisitions, two ids, two containers. One scope reused across both lanes would be
        // the global wrapper architecture.md §2 rejects.
        expect(new Set(rows.map((row) => row.sandboxId)).size).toBe(2);
        expect(rows.every((row) => row.runId === started)).toBe(true);

        // Both were alive at the same moment, which is what makes the rest of this file worth
        // asserting. Two lanes that merely followed one another would prove nothing.
        const alpha = rows.find((row) => row.name === "alpha");
        const beta = rows.find((row) => row.name === "beta");
        expect(
          overlaps(
            { from: alpha?.acquiredAt ?? 0, to: alpha?.releasedAt ?? 0 },
            { from: beta?.acquiredAt ?? 0, to: beta?.releasedAt ?? 0 },
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("says which lane each phase belonged to, from the phase row alone", () =>
    withLanes(() =>
      Effect.gen(function* () {
        yield* together.definition.execute({ subject: "attribution" }, { discard: true });
        yield* settle;

        const rows = yield* phases;
        expect(rows).toHaveLength(2);

        // One column of the phase row answers *which lane*: the acquisition it names carries the
        // scope's own name. No second table is read, and nothing is matched on time.
        const lanes = new Map(
          rows.map((row) => [row.name, Option.getOrNull(laneOf(row.sandboxId))]),
        );
        expect(lanes.get("alpha_read")).toBe("alpha");
        expect(lanes.get("beta_read")).toBe("beta");
      }),
    ),
  );

  it.effect("carries a correlation into each container that names that container", () =>
    withLanes(() =>
      Effect.gen(function* () {
        yield* together.definition.execute({ subject: "correlation" }, { discard: true });
        yield* settle;

        const rows = yield* recorded;
        const alpha = rows.find((row) => row.name === "alpha");
        const beta = rows.find((row) => row.name === "beta");

        // `KOJO_PHASE_ID` is the acquisition's own id in each, and the two differ. This is the join
        // that survives the boundary Effect cannot cross.
        expect(alpha?.environment.KOJO_PHASE_ID).toBe(alpha?.sandboxId);
        expect(beta?.environment.KOJO_PHASE_ID).toBe(beta?.sandboxId);
        expect(alpha?.environment.KOJO_PHASE_ID).not.toBe(beta?.environment.KOJO_PHASE_ID);
        // Same run in both, so output from either container lands on the right run as well as the
        // right unit of work.
        expect(alpha?.environment.KOJO_RUN_ID).toBe(beta?.environment.KOJO_RUN_ID);

        // And what each lane's phase read *inside* its own container is that lane's key — the
        // reading a lane's agent output carries home. Cross-wired lanes would swap these two.
        const inside = new Map((yield* phases).map((row) => [row.name, row.sandboxId]));
        expect(inside.get("alpha_read")).toBe(alpha?.sandboxId);
        expect(inside.get("beta_read")).toBe(beta?.sandboxId);
      }),
    ),
  );

  it.effect("cannot be told apart by time, which is the whole reason the key exists", () =>
    withLanes(() =>
      Effect.gen(function* () {
        yield* together.definition.execute({ subject: "timestamps" }, { discard: true });
        yield* settle;

        const rows = yield* recorded;
        const alphaPhase = (yield* phases).find((row) => row.name === "alpha_read");

        // Ask the question a timestamp join asks: *which container was alive while this phase ran?*
        // Both were. The answer is two candidates, so the join is a coin toss, and it is a coin
        // toss that gets worse the busier the factory is.
        const byTime = rows.filter((row) =>
          overlaps(
            { from: row.acquiredAt, to: row.releasedAt },
            { from: alphaPhase?.startedAt ?? 0, to: alphaPhase?.endedAt ?? 0 },
          ),
        );
        expect(byTime).toHaveLength(2);

        // The recorded key answers it outright, and answers it with one row.
        const byKey = rows.filter((row) => row.sandboxId === alphaPhase?.sandboxId);
        expect(byKey.map((row) => row.name)).toEqual(["alpha"]);
      }),
    ),
  );
});

describe("a gate in one lane while the other lane is still working", () => {
  it.effect("holds both containers open until the sibling phase finishes", () =>
    withLanes((shook) =>
      Effect.gen(function* () {
        const started = yield* gated.definition.execute({ subject: "siblings" }, { discard: true });
        yield* settle;

        // Alpha asked its question: the request activity ran and the gate is out with a human.
        expect(yield* requested).toHaveLength(1);

        // And yet nothing has been released, and the run is not suspended. `wrapActivityResult`
        // parks the suspending fiber until every sibling activity is done, so alpha's container —
        // the one nobody is using — stays up for as long as beta's phase runs.
        // **This is the constraint, asserted rather than assumed.**
        expect((yield* observed).map((event) => event.moment)).toEqual(["acquired", "acquired"]);
        expect(yield* statusOf(started)).toBe("running");

        // An hour of beta's phase, and still nothing released.
        yield* settleThenAdvance(Duration.hours(1));
        expect((yield* observed).filter((event) => event.moment === "released")).toHaveLength(0);
        expect(yield* statusOf(started)).toBe("running");

        yield* shook.release.open;
        yield* settleFully;

        // Beta finished, and only then did the suspension land — both containers at once.
        expect(yield* statusOf(started)).toBe("Suspended");
        expect((yield* observed).filter((event) => event.moment === "released")).toHaveLength(2);
      }),
    ),
  );

  it.effect("charges the waiting lane for the wait, on its own row", () =>
    withLanes((shook) =>
      Effect.gen(function* () {
        yield* gated.definition.execute({ subject: "cost" }, { discard: true });
        yield* settle;
        yield* settleThenAdvance(Duration.hours(1));
        yield* shook.release.open;
        yield* settleFully;

        const rows = yield* recorded;
        const alpha = rows.find((row) => row.name === "alpha");

        // The hour is on alpha's own row, where a human can find it. It is the price of the
        // constraint, and a design that hid it would leave the bill unexplained.
        expect(alpha?.lifetimeMillis).toBeGreaterThanOrEqual(Duration.toMillis(Duration.hours(1)));
        // Alpha's scope was torn down by the suspension; beta's ended by finishing.
        expect(rows.map((row) => `${row.name}:${row.outcome}`).sort()).toEqual([
          "alpha:interrupted",
          "beta:released",
        ]);
      }),
    ),
  );

  it.effect("resumes on the answer and rebuilds a container for each lane", () =>
    withLanes((shook) =>
      Effect.gen(function* () {
        const started = yield* gated.definition.execute({ subject: "resume" }, { discard: true });
        yield* settle;
        yield* shook.release.open;
        yield* settleFully;
        expect(yield* statusOf(started)).toBe("Suspended");

        yield* answerGate({
          token: (yield* requested)[0]?.token as DurableDeferred.Token,
          choice: "approve",
          reason: "both lanes read fine",
          answerer: "kevin",
        });
        yield* settle;

        expect(yield* statusOf(started)).toBe("Complete");

        // Replay re-entered both scopes, because a scope is not an activity: four acquisitions for
        // two lanes across one suspension, two per lane.
        const acquired = (yield* observed).filter((event) => event.moment === "acquired");
        expect(acquired.map((event) => event.name).sort()).toEqual([
          "alpha",
          "alpha",
          "beta",
          "beta",
        ]);

        // Neither lane's phase ran twice — the recorded activities came back without executing.
        expect((yield* phases).map((row) => row.name).sort()).toEqual(["alpha_read", "beta_build"]);

        // Each phase still names the container it *actually* ran in, which is the first
        // acquisition of its lane. The rebuilt containers carried no phase, and the rows say so.
        const first = new Map<string, string>();
        for (const event of acquired) if (!first.has(event.name)) first.set(event.name, event.id);
        const ran = new Map((yield* phases).map((row) => [row.name, row.sandboxId as string]));
        expect(ran.get("alpha_read")).toBe(first.get("alpha"));
        expect(ran.get("beta_build")).toBe(first.get("beta"));
      }),
    ),
  );
});

describe("one gate name, asked in both lanes", () => {
  it.effect("asks it twice, once per lane, so one answer cannot settle the other", () =>
    withLanes((shook) =>
      Effect.gen(function* () {
        const started = yield* shared.definition.execute({ subject: "same" }, { discard: true });
        yield* settleFully;
        yield* shook.release.open;
        yield* settleFully;

        // Two questions, and the lane is in the name of each. **Before the qualifier this read
        // `["gate/review/1"]`** — one asking for two branches, because a durable deferred is keyed
        // `executionId/name` and both lanes wrote the same name. Measured then: one request reached
        // a human, one `approve` came back to both lanes, and the trace kept one row for two
        // branches.
        expect((yield* requested).map((request) => request.asking).sort()).toEqual([
          "gate/alpha/review/1",
          "gate/beta/review/1",
        ]);

        // Two tokens, so the two questions can be answered by two people, on two days.
        expect(new Set((yield* requested).map((request) => request.token)).size).toBe(2);
        expect(yield* sharedStatusOf(started)).toBe("Suspended");
      }),
    ),
  );

  /**
   * **A limitation found here, not assumed, and it is upstream rather than Kojo's.**
   *
   * The test above leaves a run with *two gates open at the same time*, which is the state two lanes
   * reach naturally: one lane is inside a long phase while the other asks its question, and then the
   * first asks its own. Answering one of the two does not resume that run. The execution fiber ends
   * with an interrupts-only cause and `instance.suspended` false, so `Workflow.intoResult` fails the
   * fiber instead of recording `Suspended`, and `Workflow.poll` then **dies** — a defect with an
   * empty cause, which is the worst possible sentence for a human to be shown.
   *
   * Measured, both ways round and on both engines: with `WorkflowEngine.layerMemory` and with
   * `InMemoryClusterEngine` (the real cluster engine over `TestRunner`), and with and without a
   * sandbox scope, so it is neither the memory engine's nor Kojo's. It also depends on *which* of
   * the two gates is answered — answering the lane that replays to completion last is survivable,
   * answering the other is not — which is what makes it a trap rather than a rule.
   *
   * Pinned rather than worked around. The day the engine records `Suspended` here, this test goes
   * red and says so.
   */
  it.effect("cannot be resumed one gate at a time, and that is not Kojo's to fix", () =>
    withLanes((shook) =>
      Effect.gen(function* () {
        const started = yield* shared.definition.execute({ subject: "stuck" }, { discard: true });
        yield* settleFully;
        yield* shook.release.open;
        yield* settleFully;
        expect(yield* sharedStatusOf(started)).toBe("Suspended");

        const alpha = (yield* requested).find((request) => request.asking.includes("alpha"));
        yield* answerGate({
          token: alpha?.token as DurableDeferred.Token,
          choice: "approve",
          reason: "alpha reads fine",
          answerer: "kevin",
        });
        yield* settleFully;

        // Not `Suspended`, not `Complete` — no answer at all. `poll` dies.
        const polled = yield* Effect.exit(shared.definition.poll(started));
        expect(Exit.isFailure(polled)).toBe(true);
      }),
    ),
  );
});
