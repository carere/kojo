import { describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { type DurableDeferred, type Workflow, WorkflowEngine } from "effect/unstable/workflow";
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
import { WorktreeState } from "../../../../../src/contexts/sandbox/models/WorktreeState.ts";
import { WorktreeUnusable } from "../../../../../src/contexts/sandbox/models/WorktreeUnusable.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { factoryOwnPaths } from "../../../../../src/contexts/workflow/models/PermissionPolicy.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { sandboxed } from "../../../../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";

/**
 * A provider descriptor with no Sandcastle behind it.
 *
 * `tagged` is the model, not an adapter: it pairs a provider value with the capability tag the
 * published types throw away. A unit test may say what kind of sandbox it is asking for without
 * importing the factories that would build a real one.
 */
const provider = tagged("bind-mount", { name: "fake", env: {} });

const branch = "kojo/lane";
const inner = "kojo/lane/inner";

const failures = Schema.Union([
  GateExpired,
  GateUnreachable,
  SandboxError,
  WorkspaceError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

/** The one phase every lane below runs, so a test can say whether it ran again on replay. */
const readHealth = code(
  {
    name: "read",
    description: "Read the file the sandbox's own workspace holds",
    success: Schema.String,
    error: WorkspaceError,
  },
  Effect.flatMap(Workspace, (workspace) => workspace.read("src/health.ts")),
);

const review = gate({
  name: "review",
  description: "Does this land?",
  actor: "engineer",
  choices: ["approve", "reject"],
  deadline: Duration.days(7),
  onExpiry: OnExpiry.fail(),
  asking: 1,
});

/** One lane: read inside the sandbox, ask a human, come back and say what both produced. */
const lane = workflow(
  {
    name: "lane",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `lane/${payload.subject}`,
  },
  () =>
    sandboxed(
      { name: "lane", branch, provider },
      Effect.gen(function* () {
        const health = yield* readHealth;
        const verdict = yield* review;
        return `${health}/${verdict.choice}`;
      }),
    ),
);

/** A lane inside a lane, on its own branch — the nesting the four primitives promise. */
const nested = workflow(
  {
    name: "nested",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `nested/${payload.subject}`,
  },
  () =>
    sandboxed(
      { name: "outer", branch, provider },
      Effect.gen(function* () {
        const outside = yield* readHealth;
        const inside = yield* sandboxed(
          { name: "inner", branch: inner, provider },
          code(
            {
              name: "read_inner",
              description: "Read the file the inner sandbox holds",
              success: Schema.String,
              error: WorkspaceError,
            },
            Effect.flatMap(Workspace, (workspace) => workspace.read("src/health.ts")),
          ),
        );
        return `${outside}+${inside}`;
      }),
    ),
);

/** A lane that says out loud that it wants its factory left in the tree. See `hidden`. */
const unmasked = workflow(
  {
    name: "unmasked",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `unmasked/${payload.subject}`,
  },
  () => sandboxed({ name: "unmasked", branch, provider, hidden: [] }, readHealth),
);

/**
 * The mistake, written down so nobody has to make it twice.
 *
 * A sandbox scope **inside** a phase rather than around one. `Activity.make` wraps every body in
 * `retryOnInterrupt`, and a suspension *is* an interrupt, so the engine retries the phase until it
 * runs out and then dies. Kojo cannot make this unrepresentable — the author writes the nesting —
 * so it is asserted instead.
 */
const misplaced = workflow(
  {
    name: "misplaced",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `misplaced/${payload.subject}`,
  },
  () =>
    code(
      {
        name: "everything",
        description: "A whole lane wrongly wrapped in one phase",
        success: Schema.String,
        error: failures,
      },
      sandboxed(
        { name: "inside", branch, provider },
        Effect.map(review, (verdict) => verdict.choice),
      ),
    ),
);

const seeded: InMemorySandboxSource.Programmed = {
  files: {
    [branch]: { "src/health.ts": "outer" },
    [inner]: { "src/health.ts": "inner" },
  },
};

const layerFor = (
  programmed: InMemorySandboxSource.Programmed = seeded,
  answers: Record<string, ReadonlyArray<InMemoryGate.ProgrammedAnswer>> = {},
) =>
  Layer.mergeAll(lane.layer, nested.layer, misplaced.layer, unmasked.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        InMemorySandboxSource.layer(programmed),
        InMemoryGate.layer(answers).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

/** Hands the scheduler to the forked run without moving the virtual clock. See gate.test.ts. */
const settle = TestClock.adjust(Duration.zero);

/**
 * Starts a run and lets it get as far as it can.
 *
 * `discard: true`, never a bare `execute` — the engine's execute is a poll loop that only returns
 * on `Complete`, so awaiting a run that is going to suspend never settles.
 */
const started = (execution: Effect.Effect<string, never, WorkflowEngine.WorkflowEngine>) =>
  Effect.gen(function* () {
    const executionId = yield* execution;
    yield* settle;
    return executionId;
  });

const startLane = (subject: string) =>
  started(lane.definition.execute({ subject }, { discard: true }));

const statusOf = (executionId: string) =>
  Effect.map(lane.definition.poll(executionId), (polled) =>
    Option.match(polled, {
      onNone: () => "running" as const,
      onSome: (result) => result._tag,
    }),
  );

const observed = Effect.flatMap(
  InMemorySandboxSource.ObservedSandboxes,
  (sandboxes) => sandboxes.events,
);
const recorded = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.sandboxes);
const phases = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.phases);
const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

const answer = (token: DurableDeferred.Token, choice: string) =>
  Effect.gen(function* () {
    yield* answerGate({ token, choice, reason: "reads fine", answerer: "kevin" });
    yield* settle;
  });

describe("a region of a workflow inside a sandbox", () => {
  it.effect("releases the container while it waits, and builds another one on the answer", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("one");
      expect(yield* statusOf(executionId)).toBe("Suspended");

      // This is the whole of D3, in one assertion. The scope is local and it sits outside every
      // phase, so the suspension's interrupt unwinds it before the human has even read the
      // question. A workflow-lifetime scope would show only "acquired" here.
      expect((yield* observed).map((event) => event.moment)).toEqual(["acquired", "released"]);

      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      expect(yield* statusOf(executionId)).toBe("Complete");
      // Re-entering the scope on replay built it again — from the branch, since that is all the
      // request carries.
      expect((yield* observed).map((event) => event.moment)).toEqual([
        "acquired",
        "released",
        "acquired",
        "released",
      ]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("leaves one record per acquisition, so the rebuild is visible", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("records");
      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      const rows = yield* recorded;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.sandboxId)).toEqual([...new Set(rows.map((r) => r.sandboxId))]);
      expect(rows.map((row) => row.name)).toEqual(["lane", "lane"]);
      expect(rows.map((row) => row.branch)).toEqual([branch, branch]);
      // Torn down by a suspension, then released normally. `interrupted` is not a fault: it is what
      // a gate looks like from inside the scope.
      expect(rows.map((row) => row.outcome)).toEqual(["interrupted", "released"]);
      expect(rows.every((row) => row.runId === executionId)).toBe(true);
      expect(rows[0]?.lifetimeMillis).toBe(0);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("replays past the phases it already ran, and only rebuilds the sandbox", () =>
    Effect.gen(function* () {
      yield* startLane("replay");
      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      // The sharpest edge in the system, asserted rather than argued: the recorded activity comes
      // back without running again, while everything outside one — the scope — runs every time.
      expect((yield* phases).filter((phase) => phase.name === "read")).toHaveLength(1);
      expect((yield* observed).filter((event) => event.moment === "acquired")).toHaveLength(2);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("gives the region the workspace its own sandbox chose", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("workspace");
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      const result = Option.getOrThrow(yield* lane.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, never>).exit;
      expect(Exit.isSuccess(exit) && exit.value).toBe("outer/approve");
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("what crosses into the container", () => {
  it.effect("stamps the run, the acquisition and the attempt on every sandbox", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("correlation");

      const events = yield* observed;
      const environment = events[0]?.environment;

      expect(environment?.KOJO_RUN_ID).toBe(executionId);
      // A sandbox is a scope around phases, so at the moment its container starts there is no
      // phase. The acquisition's own id goes in, because that is the row the container's output
      // belongs to — and the attempt is 0, which `Activity.CurrentAttempt` can never be.
      expect(environment?.KOJO_PHASE_ID).toBe(events[0]?.id);
      expect(environment?.KOJO_ATTEMPT).toBe("0");
      expect(Object.keys(environment ?? {}).sort()).toEqual([
        "KOJO_ATTEMPT",
        "KOJO_PHASE_ID",
        "KOJO_RUN_ID",
      ]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("records what actually crossed, rather than claiming it", () =>
    Effect.gen(function* () {
      yield* startLane("recorded-env");
      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      const rows = yield* recorded;
      const events = (yield* observed).filter((event) => event.moment === "acquired");
      expect(rows.map((row) => row.environment)).toEqual(events.map((event) => event.environment));
      // A rebuild is a different acquisition, so its correlation is different too. Anything else
      // would join two containers' output onto one row.
      expect(rows[0]?.environment.KOJO_PHASE_ID).not.toBe(rows[1]?.environment.KOJO_PHASE_ID);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("what the factory's own files are asked to do", () => {
  it.effect("takes them out of every scope an author said nothing about", () =>
    Effect.gen(function* () {
      yield* startLane("hidden-default");

      // The first line of defence from architecture.md §8, edge 5, resolved where the two contexts
      // meet: the roster, the workflows, the envelopes, the checks, the commands and the prompts.
      // An author who writes nothing gets it, which is the whole point of it being a default.
      expect((yield* observed)[0]?.hidden).toEqual([...factoryOwnPaths]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("obeys a factory that says out loud it wants them left in", () =>
    Effect.gen(function* () {
      yield* started(unmasked.definition.execute({ subject: "kept" }, { discard: true }));

      // `hidden: []` is the opt-out, and it has to be greppable rather than inferred: Kojo's own
      // factory takes it, because `bun knip` — one of its five real commands — exits 1 in a worktree
      // whose `.kojo/` is hidden. See `keepsItsOwnFactory` in `.kojo/workflows/lane/common.ts`.
      expect((yield* observed)[0]?.hidden).toEqual([]);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("a branch that moved under a suspended run", () => {
  const moved: InMemorySandboxSource.Programmed = {
    ...seeded,
    worktrees: {
      [branch]: (acquisition) =>
        new WorktreeState({
          head: branch,
          detached: false,
          modified: false,
          tracked: true,
          behind: acquisition === 1 ? 0 : 3,
          ahead: 1,
        }),
    },
  };

  it.effect("stops the run rather than rebuilding on a tree nobody checked", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("moved");
      expect(yield* statusOf(executionId)).toBe("Suspended");

      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      const result = Option.getOrThrow(yield* lane.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, WorktreeUnusable>).exit;
      expect(Exit.isFailure(exit)).toBe(true);

      // Loud, and specific about which of Sandcastle's four silent skip paths it caught.
      const rows = yield* recorded;
      expect(rows).toHaveLength(2);
      expect(rows[1]?.outcome).toBe("failed");
    }).pipe(Effect.provide(layerFor(moved))),
  );

  it.effect("still records the acquisition it then refused to use", () =>
    Effect.gen(function* () {
      yield* startLane("moved-record");
      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      // The container was built; hiding that because the tree turned out to be wrong would omit
      // exactly the runs somebody is investigating.
      expect((yield* observed).filter((event) => event.moment === "acquired")).toHaveLength(2);
    }).pipe(Effect.provide(layerFor(moved))),
  );
});

describe("a container that comes back with a workspace it cannot work in", () => {
  /** Unreachable once, then fine — what a rebuild is supposed to find. */
  const onceMissing: InMemorySandboxSource.Programmed = {
    ...seeded,
    reachable: { [branch]: (acquisition) => acquisition > 1 },
  };

  /** Unreachable every time. No rebuild can recover this, and the run has to say so. */
  const alwaysMissing: InMemorySandboxSource.Programmed = {
    ...seeded,
    reachable: { [branch]: () => false },
  };

  it.effect("builds another container rather than failing the run", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("unreachable-once");

      // Two containers inside **one** execution of the body, and the second one carried the lane
      // all the way to the gate. Nothing about the run was wrong, so nothing about the run stopped.
      expect((yield* observed).map((event) => event.moment)).toEqual([
        "acquired",
        "released",
        "acquired",
        "released",
      ]);
      expect(yield* statusOf(executionId)).toBe("Suspended");

      yield* TestClock.adjust(Duration.days(2));
      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "approve");

      const result = Option.getOrThrow(yield* lane.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, never>).exit;
      expect(Exit.isSuccess(exit) && exit.value).toBe("outer/approve");

      // The phase inside the sandbox ran once, on the container that worked. A discarded container
      // that had been allowed to run a phase would show two.
      expect((yield* phases).filter((phase) => phase.name === "read")).toHaveLength(1);
    }).pipe(Effect.provide(layerFor(onceMissing))),
  );

  it.effect("leaves the discarded container its own row, so the rebuild has a cost", () =>
    Effect.gen(function* () {
      yield* startLane("unreachable-rows");

      const rows = yield* recorded;
      expect(rows).toHaveLength(2);
      // Thrown away, and recorded as such — the same outcome an acquisition gets when the worktree
      // check rejects it, because it is the same category of fact: the container was built and was
      // not usable. Hiding it would hide the whole cost of the recovery.
      expect(rows[0]?.outcome).toBe("failed");
      // And the one that carried the lane was torn down by the suspension, not by the rebuild.
      expect(rows[1]?.outcome).toBe("interrupted");
      expect(new Set(rows.map((row) => row.sandboxId)).size).toBe(2);
    }).pipe(Effect.provide(layerFor(onceMissing))),
  );

  it.effect("gives up after three, and names the workspace and the branch", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("unreachable-always");

      const result = Option.getOrThrow(yield* lane.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, WorkspaceUnreachable>).exit;
      expect(Exit.isFailure(exit)).toBe(true);

      const failure = Option.getOrThrow(
        Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none(),
      ) as WorkspaceUnreachable;
      expect(failure._tag).toBe("WorkspaceUnreachable");
      expect(failure.branch).toBe(branch);
      expect(failure.worktreePath).toBe(`/worktrees/${branch}`);
      expect(failure.containers).toBe(3);

      // The sentence a human reads leads with the two facts that say where to look. The probe's own
      // words come after them; a message that began with a container runtime's account of
      // `config.json` is the failure this whole path exists to replace.
      expect(failure.summary.indexOf(`/worktrees/${branch}`)).toBeLessThan(
        failure.summary.indexOf(failure.reach.detail),
      );
      expect(failure.summary).toContain(branch);

      // Three containers, bounded — and no phase ever ran, because none of them could.
      expect((yield* observed).filter((event) => event.moment === "acquired")).toHaveLength(3);
      expect(yield* phases).toHaveLength(0);
      expect((yield* recorded).map((row) => row.outcome)).toEqual(["failed", "failed", "failed"]);
    }).pipe(Effect.provide(layerFor(alwaysMissing))),
  );
});

describe("a sandbox that never starts", () => {
  it.effect("fails the region with the reason, and records nothing that did not happen", () =>
    Effect.gen(function* () {
      const executionId = yield* startLane("broken");

      const result = Option.getOrThrow(yield* lane.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, SandboxError>).exit;
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* recorded).toHaveLength(0);
    }).pipe(Effect.provide(layerFor({ ...seeded, refuses: [branch] }))),
  );
});

describe("sandboxes nesting as branches of the graph", () => {
  it.effect("opens the inner one inside the outer, and closes it first", () =>
    Effect.gen(function* () {
      const executionId = yield* started(
        nested.definition.execute({ subject: "nest" }, { discard: true }),
      );

      const result = Option.getOrThrow(yield* nested.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, never>).exit;
      // Each region read its own tree, which is the point: two lanes can want different images.
      expect(Exit.isSuccess(exit) && exit.value).toBe("outer+inner");

      expect((yield* observed).map((event) => `${event.moment} ${event.name}`)).toEqual([
        "acquired outer",
        "acquired inner",
        "released inner",
        "released outer",
      ]);

      const rows = yield* recorded;
      expect(rows.map((row) => row.name)).toEqual(["inner", "outer"]);
      expect(rows.map((row) => row.branch)).toEqual([inner, branch]);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("a sandbox scope put inside a phase instead of around one", () => {
  it.effect("never suspends, rebuilds ten times over, and dies", () =>
    Effect.gen(function* () {
      const executionId = yield* started(
        misplaced.definition.execute({ subject: "wrong" }, { discard: true }),
      );

      // The lane above records `Suspended` here. This one records nothing at all: the activity's
      // `retryOnInterrupt` swallows the interrupt, so `intoResult` never sees the interrupt-only
      // cause that would have become a suspension. Nobody can answer a gate that never opened.
      expect(yield* misplaced.definition.poll(executionId)).toEqual(Option.none());

      yield* TestClock.adjust(Duration.days(8));
      yield* settle;

      const result = Option.getOrThrow(yield* misplaced.definition.poll(executionId));
      const exit = (result as Workflow.Complete<string, never>).exit;
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "retry attempts exhausted",
      );

      // One entry, eleven containers: the first, then one per retry. A gate placed like this costs
      // ten rebuilds and ends in a defect, which is what "the scope goes outside" buys.
      const acquired = (yield* observed).filter((event) => event.moment === "acquired");
      expect(acquired).toHaveLength(11);

      // And eleven **distinct** ids, because eleven containers are eleven rows.
      //
      // Read this as the invariant it is and **not** as evidence for the sequence in `SandboxId`:
      // it passes under the old clock-only id as well. `retryOnInterrupt`'s schedule advances the
      // test clock between attempts, so the eleven readings differ on their own. Reverting
      // `makeSandboxId` to the clock alone fails `SandboxId.test.ts` and leaves this green — checked.
      expect(new Set(acquired.map((event) => event.id)).size).toBe(11);
    }).pipe(Effect.provide(layerFor())),
  );
});
