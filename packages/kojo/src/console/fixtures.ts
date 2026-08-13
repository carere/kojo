import { Effect, Layer } from "effect";
import { DurableDeferred } from "effect/unstable/workflow";
import * as InMemoryGateRepository from "../contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateRecord } from "../contexts/gate/models/GateRecord.ts";
import { GateRequest } from "../contexts/gate/models/GateRequest.ts";
import type { ExpiryBranch } from "../contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../contexts/gate/models/Verdict.ts";
import { GateRepository } from "../contexts/gate/ports/GateRepository.ts";
import { present } from "../contexts/shared/lib/present.ts";
import { PathRollback } from "../contexts/shared/models/PathRollback.ts";
import { makePhaseId } from "../contexts/shared/models/PhaseId.ts";
import type { RunId } from "../contexts/shared/models/RunId.ts";
import { makeSandboxId, type SandboxId } from "../contexts/shared/models/SandboxId.ts";
import * as InMemoryArtifactReader from "../contexts/trace/adapters/InMemoryArtifactReader.ts";
import * as InMemoryTraceReader from "../contexts/trace/adapters/InMemoryTraceReader.ts";
import { AgentCallRecord } from "../contexts/trace/models/AgentCallRecord.ts";
import { InFlightPhase } from "../contexts/trace/models/InFlightPhase.ts";
import {
  Occurrence,
  type OccurrenceKind,
  type OccurrenceOutcome,
} from "../contexts/trace/models/Occurrence.ts";
import {
  type PhaseKind,
  type PhaseOutcome,
  PhaseRecord,
} from "../contexts/trace/models/PhaseRecord.ts";
import { RepoEffect } from "../contexts/trace/models/RepoEffect.ts";
import { RunRecord } from "../contexts/trace/models/RunRecord.ts";
import { RunSummary } from "../contexts/trace/models/RunSummary.ts";
import { SandboxRecord } from "../contexts/trace/models/SandboxRecord.ts";
import { Verification } from "../contexts/trace/models/Verification.ts";
import type { ArtifactReader } from "../contexts/trace/ports/ArtifactReader.ts";
import type { TraceReader } from "../contexts/trace/ports/TraceReader.ts";
import { RunnerRegistration } from "../contexts/workflow/models/RunnerRegistration.ts";
import type { FactoryPresence } from "./FactoryHealth.ts";
import { frozenNow } from "./frozenNow.ts";

/**
 * Traces that never ran, for the surface that has to render them.
 *
 * console.md §11 fixes the Console's browser tier as **in-memory readers behind the real HTTP
 * server**, so the tests exercise the real routes, the real Query wiring and the real components
 * with nothing faked but the data. This module is the data half of that, and `kojo ui --fixtures`
 * is the flag that selects it.
 *
 * **Why the records are stated rather than produced.** A run held at a gate for forty-one hours, a
 * run that failed, and a repository with no factory at all cannot be made to exist on demand by
 * driving a workflow — the first would take forty-one hours and the third is the absence of the
 * database. Stating them is the only way a test can be about the state rather than about how long it
 * took to reach it.
 *
 * **Every timestamp is fixed, and fixed against one instant.** `frozenNow` is what a browser test
 * freezes the Console's clock to, so a deadline seven hours out reads *in 7h 0m* on every machine,
 * on every run, forever. A fixture written against `Date.now()` would make each of those assertions
 * a different assertion every second.
 *
 * It ships inside the package rather than beside the tests because the flag that selects it is a
 * flag of `kojo ui`, and `kojo ui` is what the browser tier starts. The cost is a few kilobytes of
 * records in the published package; the alternative is a second server that is not the real one.
 *
 * **Every optional field here goes through `present`, which is the same function the SQLite readers
 * use.** That is not tidiness. These records are encoded by the same routes that encode the ones the
 * database produces, and a record built by *omitting* an absent field and one built by passing
 * `undefined` for it encode to two different documents — nothing and `null`. This module used to do
 * the first while `SqliteTraceReader` did the second, so every browser test in the build was run
 * against a shape a real factory has never sent, and the run view threw on the shape it always
 * sends. adr/trace/0003 settles it: absent, never `null`, on both sides, through one helper.
 */

const second = 1_000;
const minute = 60 * second;
const hour = 60 * minute;

/** A run id, branded. Fixture ids are ours, so there is nothing to validate. */
const id = (name: string): RunId => name as RunId;

/** What every fixture run shares: this build of Kojo, one host, one configuration. */
const provenance = {
  engineVersion: "0.0.0",
  engineCommit: "development",
  configDigest: "sha256:fixture",
  host: "fixture-host",
} as const;

const summary = (options: {
  readonly runId: string;
  readonly workflow: string;
  readonly startedAt: number;
  readonly outcome?: "succeeded" | "failed" | "suspended";
  readonly finishedAt?: number;
  readonly inFlight?: InFlightPhase;
  /**
   * The image the run's containers were built from.
   *
   * Optional here because it is optional on the record: no provider in Kojo resolves a digest yet,
   * so a run that never built one is the ordinary case and the panel has to say so rather than draw
   * a blank. Stated on the run that acquires a sandbox twice, which is where somebody asks.
   */
  readonly imageDigest?: string;
}): RunSummary =>
  new RunSummary({
    run: new RunRecord({
      runId: id(options.runId),
      workflow: options.workflow,
      idempotencyKey: `${options.workflow}/${options.runId}`,
      startedAt: options.startedAt,
      ...provenance,
      ...present("imageDigest", options.imageDigest),
    }),
    ...present("outcome", options.outcome),
    ...present("finishedAt", options.finishedAt),
    ...present("inFlight", options.inFlight),
  });

/**
 * One phase record, from the six things a waterfall reads off it and the four it draws from.
 *
 * A builder rather than six literals per run, because the fixtures below are about *shapes a UI gets
 * wrong* — a rebuild, a correction loop, a breach — and each of those is one field away from an
 * ordinary phase. Spelling every record out in full would bury the one field that is the point.
 */
const phase = (options: {
  readonly runId: string;
  readonly name: string;
  readonly kind: PhaseKind;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome?: PhaseOutcome;
  readonly attempt?: number;
  readonly sandboxId?: SandboxId;
  readonly errorTag?: string;
  readonly corrections?: number;
  readonly breaches?: ReadonlyArray<PathRollback>;
  readonly changed?: ReadonlyArray<string>;
  /**
   * What the envelope *said* it changed, when that is not what the working tree held.
   *
   * Defaults to `changed`, because an agent that described its own work is the ordinary case. Stated
   * apart from it only for the run that is about the two disagreeing — which is the pair of columns
   * console.md §6 asks the panel to put side by side.
   */
  readonly claimed?: ReadonlyArray<string>;
  readonly commits?: ReadonlyArray<string>;
  readonly resumed?: boolean;
  readonly contextTokens?: number;
  readonly correctable?: boolean;
  /**
   * A check that failed **without ever joining the checks that ran**.
   *
   * The ordinary shape states a failure in both lists, and the fixture below defends that. This is
   * the other shape the trace can hold: a check that threw instead of returning a verdict never
   * completed, so the writer records the failure and the `ran` list never learns the name. A panel
   * that draws `ran` alone would hide it — which is exactly the failure a reader must never miss.
   */
  readonly unlistedFailure?: string;
}): PhaseRecord =>
  new PhaseRecord({
    runId: id(options.runId),
    phaseId: makePhaseId(options.runId, options.name, options.attempt ?? 1),
    name: options.name,
    description: `the ${options.name} phase`,
    kind: options.kind,
    outcome: options.outcome ?? "succeeded",
    attempt: options.attempt ?? 1,
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    ...present("sandboxId", options.sandboxId),
    ...present("errorTag", options.errorTag),
    ...present("breaches", options.breaches),
    ...present(
      "repo",
      options.changed === undefined
        ? undefined
        : new RepoEffect({
            claimed: options.claimed ?? options.changed,
            changed: options.changed,
            commits: options.commits ?? [],
          }),
    ),
    ...(options.kind === "agent"
      ? {
          agent: new AgentCallRecord({
            agent: "builder",
            model: "fixture-model",
            session: `${options.runId}-${options.name}` as AgentCallRecord["session"],
            resumed: options.resumed ?? false,
            tokensIn: 4_000,
            tokensOut: 900,
            ...present("contextTokens", options.contextTokens),
          }),
          verification: new Verification({
            envelope: "Answer",
            // A check that did not hold is one of the checks that **ran**. Stating it in only one of
            // the two lists would let a panel that draws the checks it ran hide the one that failed.
            ran:
              options.errorTag === "CheckViolation"
                ? ["the answer decodes", "the tests pass"]
                : ["the answer decodes"],
            failed: [
              ...(options.errorTag === "CheckViolation" ? ["the tests pass"] : []),
              // Named in `failed` and deliberately absent from `ran` above.
              ...(options.unlistedFailure === undefined ? [] : [options.unlistedFailure]),
            ],
            corrections: options.corrections ?? 0,
            correctable: options.correctable ?? true,
          }),
        }
      : {}),
  });

/**
 * One repetition inside a phase — the only record in the trace allowed to be numerous.
 *
 * They are stated per phase because that is how a panel reads them, and they are the half of the
 * detail panel that no other view carries: console.md §6 puts a phase's tool calls and `exec`
 * invocations there and nowhere else.
 */
const occurrence = (options: {
  readonly runId: string;
  readonly phase: string;
  readonly kind: OccurrenceKind;
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome?: OccurrenceOutcome;
  readonly detail?: string;
  readonly attempt?: number;
}): Occurrence =>
  new Occurrence({
    runId: id(options.runId),
    phaseId: makePhaseId(options.runId, options.phase, options.attempt ?? 1),
    kind: options.kind,
    name: options.name,
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    outcome: options.outcome ?? "succeeded",
    ...present("detail", options.detail),
  });

/** One acquisition. The id carries the moment it was acquired, so two of them can never collide. */
const acquisition = (options: {
  readonly runId: string;
  readonly name: string;
  readonly acquiredAt: number;
  readonly releasedAt: number;
  readonly sequence: number;
  readonly outcome?: "released" | "interrupted" | "failed";
}): SandboxRecord =>
  new SandboxRecord({
    runId: id(options.runId),
    sandboxId: makeSandboxId(options.runId, options.name, options.acquiredAt, options.sequence),
    name: options.name,
    provider: "docker",
    kind: "isolated",
    branch: `kojo/${options.runId}`,
    worktreePath: `/tmp/kojo/${options.runId}`,
    environment: { KOJO_RUN_ID: options.runId },
    acquiredAt: options.acquiredAt,
    releasedAt: options.releasedAt,
    outcome: options.outcome ?? "released",
  });

/**
 * The durable deferred name one asking of a gate is keyed by, written the way the engine writes it.
 *
 * `gate/<name>/<round>` — `phase/gate.ts` builds exactly this, and it carries slashes because a
 * deferred name is not a Kojo identifier and was never held to the trace's path guard. The fixtures
 * state it faithfully so that the Console's gate route is graded against the shape a real factory
 * produces rather than against a flat name that would never need encoding.
 */
const askingOf = (gate: string): string => `gate/${gate}/1`;

/** A gate that settled, which is the only kind the trace holds a record of. */
const answered = (options: {
  readonly runId: string;
  readonly gate: string;
  readonly actor: string;
  readonly requestedAt: number;
  readonly answeredAt: number;
}): GateRecord =>
  new GateRecord({
    runId: id(options.runId),
    gate: options.gate,
    asking: askingOf(options.gate),
    token: tokenFor(options.runId, askingOf(options.gate)),
    description: `Should the ${options.gate} proceed?`,
    actor: options.actor,
    choices: ["approve", "reject"],
    requestedAt: options.requestedAt,
    deadlineAt: options.requestedAt + 72 * hour,
    onExpiry: "fail",
    outcome: "answered",
    answerer: options.actor,
    choice: "approve",
    reason: "the change is small and the tests are green",
    answeredAt: options.answeredAt,
  });

/**
 * **A gate the deadline settled, which the trace records exactly as it records an answered one.**
 *
 * `phase/gate.ts` writes one `<asking>/record` activity for whichever half of
 * `DurableDeferred.raceAll` won, so an expiry leaves a `GateRecord` with the same shape and a
 * different `outcome`, and with no answerer, choice, reason or answer time — because there was no
 * answer. The fixture states it because the Console's *applied* rule turns on that field: a reader
 * that took a record's mere presence as proof somebody decided would say *"a runner picked the
 * answer up"* over a question nobody ever answered.
 */
const expired = (options: {
  readonly runId: string;
  readonly gate: string;
  readonly actor: string;
  readonly requestedAt: number;
  readonly deadlineAt: number;
  readonly onExpiry: ExpiryBranch;
}): GateRecord =>
  new GateRecord({
    runId: id(options.runId),
    gate: options.gate,
    asking: askingOf(options.gate),
    token: tokenFor(options.runId, askingOf(options.gate)),
    description: `Should the ${options.gate} proceed?`,
    actor: options.actor,
    choices: ["approve", "reject"],
    requestedAt: options.requestedAt,
    deadlineAt: options.deadlineAt,
    onExpiry: options.onExpiry,
    outcome: "expired",
  });

/**
 * A token that decodes.
 *
 * Built through `TokenParsed` rather than written out as a string, because `POST /api/gates/:token`
 * parses before it does anything else — a hand-written token would make every fixture gate
 * unanswerable and the failure would look like a bug in the answering path.
 */
const tokenFor = (runId: string, asking: string) =>
  new DurableDeferred.TokenParsed({
    workflowName: "fixture",
    executionId: runId,
    deferredName: asking,
  }).asToken;

const asking = (options: {
  readonly runId: string;
  readonly gate: string;
  readonly actor: string;
  readonly requestedAt: number;
  readonly deadlineAt: number;
  /** The choices this gate declares. Two is the ordinary shape; a third is stated where it matters. */
  readonly choices?: ReadonlyArray<string>;
  /**
   * Which way the run goes if nobody answers. `fail` unless a fixture needs the other answer.
   *
   * It is stated where the run *survived* its expiry, because that is the only shape in which a
   * settled asking is still on screen: a `fail` branch ends the run, and a run that has ended shows
   * no card. A gate whose expiry rejected on the human's behalf leaves the run going and the
   * question visibly finished, which is the pair the *expired* state has to be graded on.
   */
  readonly onExpiry?: ExpiryBranch;
}): GateRequest =>
  new GateRequest({
    runId: id(options.runId),
    gate: options.gate,
    asking: askingOf(options.gate),
    description: `Should the ${options.gate} proceed?`,
    actor: options.actor,
    choices: options.choices ?? ["approve", "reject"],
    token: tokenFor(options.runId, askingOf(options.gate)),
    requestedAt: options.requestedAt,
    deadlineAt: options.deadlineAt,
    // The record carries the *branch*, not the whole `OnExpiry` value: what a reader needs to know
    // about an expired gate is which way the run went, and the reason and the escalation target are
    // the workflow's business.
    onExpiry: options.onExpiry ?? "fail",
  });

/**
 * A verdict already written against an asking, as the answering half wrote it.
 *
 * **The state the whole gate card exists to keep honest.** An asking with a verdict and no
 * `GateRecord` beside it in the trace is an answer that is *recorded and not applied*: real, and yet
 * the run has not moved. It cannot be produced on demand — it needs a runner to be absent at the
 * exact moment somebody answers — so it is stated.
 */
interface Recorded {
  readonly asking: GateRequest;
  readonly verdict: Verdict;
}

/**
 * An asking the run settled by expiry, as the run's own record activity writes it.
 *
 * The pair to the settled `GateRecord` with outcome `expired`: `phase/gate.ts` writes both in one
 * activity, so a fixture that stated the record without the settlement would be a shape no real
 * factory produces — and it is exactly the shape that left an expired asking in the queue's
 * *waiting* list forever, *overdue by* a number growing without bound.
 */
interface Expired {
  readonly asking: GateRequest;
  readonly expiredAt: number;
}

/** Everything one named fixture says about the world. */
interface Fixture {
  /** Whether this repository has a factory at all — `absent` is a state, not a failure. */
  readonly factory: FactoryPresence;
  readonly runs: ReadonlyArray<RunSummary>;
  readonly askings: ReadonlyArray<GateRequest>;
  /** Askings that already carry a verdict. Seeded through the repository, like every other one. */
  readonly answers: ReadonlyArray<Recorded>;
  /** Askings the deadline settled. Seeded through the repository, the way the run writes them. */
  readonly expiries: ReadonlyArray<Expired>;
  /**
   * Who is registered as able to apply an answer.
   *
   * Empty is the ordinary fixture, and it is the truth of a server reading records that no process
   * is executing. One fresh registration is the other half of the pair the gate card is graded on:
   * the same click resolves to *recorded — applying…* against a live runner and to *recorded —
   * nothing is running* against none, and only a fixture can hold both.
   */
  readonly runners: ReadonlyArray<RunnerRegistration>;
  readonly phases: ReadonlyArray<PhaseRecord>;
  readonly gates: ReadonlyArray<GateRecord>;
  readonly sandboxes: ReadonlyArray<SandboxRecord>;
  /** Every repetition of every phase, in the order they were recorded — the position is the cursor. */
  readonly occurrences: ReadonlyArray<Occurrence>;
  /**
   * The three things the trace does not store, per phase — and what is left out is the point.
   *
   * A phase absent from this map has no prompt, no transcript and no diff, which is a state the
   * panel has to survive: console.md §10 says one missing artifact degrades that pane and never the
   * whole panel. A fixture that gave every phase all three could not exercise it.
   */
  readonly artifacts: InMemoryArtifactReader.Artifacts;
}

/**
 * ------------------------------------------------------------------------------------------------
 * The runs the waterfall is graded against.
 *
 * console.md §11 names six states a run view gets wrong, and every one of them is written out below
 * with the run it belongs to said in its own comment. They are stated against `frozenNow` so that a
 * break's label — *41h 0m* — is the same string on every machine forever.
 * ------------------------------------------------------------------------------------------------
 */

/**
 * **The worked example, finished** — console.md §5's own hotfix run, from `in_progress` to `merge`.
 *
 * It is the run that carries three of the six states at once: a gate held for forty-one hours, the
 * **second acquisition** of one scope that the gate forced, and a phase interrupted by the
 * suspension. The rebuild is not marked anywhere — it is a second sandbox record, and the row model
 * turns that into a second row without a special case, which is the whole point of §5.
 */
const mergedStart = frozenNow - 43 * hour;
const mergedRoute = mergedStart + 200;
const mergedSetupOne = mergedRoute + 8 * second;
const mergedScout = mergedSetupOne + 90 * second;
const mergedHotfix = mergedScout + 3 * minute;
const mergedSuspended = mergedHotfix + 6 * minute;
/** Forty-one hours and twelve minutes with a human. The number the break has to be able to state. */
const mergedResumed = mergedSuspended + 41 * hour + 12 * minute;
const mergedSetupTwo = mergedResumed + 90 * second;
const mergedTest = mergedSetupTwo + 2 * minute;
const mergedEnd = mergedTest + 1 * second;
const mergedBuildOne = makeSandboxId("run-merged", "build", mergedSetupOne, 1);
const mergedBuildTwo = makeSandboxId("run-merged", "build", mergedResumed, 2);

const mergedRun = summary({
  runId: "run-merged",
  workflow: "hotfix",
  startedAt: mergedStart,
  outcome: "succeeded",
  finishedAt: mergedEnd,
  imageDigest: "sha256:1f0a9c4e",
});

const mergedPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-merged",
    name: "in_progress",
    kind: "code",
    startedAt: mergedStart,
    endedAt: mergedRoute,
  }),
  phase({
    runId: "run-merged",
    name: "route",
    kind: "agent",
    startedAt: mergedRoute,
    endedAt: mergedSetupOne,
  }),
  phase({
    runId: "run-merged",
    name: "scout",
    kind: "agent",
    startedAt: mergedScout,
    endedAt: mergedHotfix,
    sandboxId: mergedBuildOne,
  }),
  // The phase everything about the panel is graded on: an agent call that answered, changed what it
  // said it would, committed it, and left a prompt, a transcript and a diff behind.
  phase({
    runId: "run-merged",
    name: "hotfix",
    kind: "agent",
    startedAt: mergedHotfix,
    endedAt: mergedSuspended,
    sandboxId: mergedBuildOne,
    changed: ["src/server.ts"],
    commits: ["9f2c1ab"],
    contextTokens: 22_500,
  }),
  phase({
    runId: "run-merged",
    name: "test",
    kind: "code",
    startedAt: mergedSetupTwo,
    endedAt: mergedTest,
    sandboxId: mergedBuildTwo,
  }),
  phase({
    runId: "run-merged",
    name: "merge",
    kind: "code",
    startedAt: mergedTest,
    endedAt: mergedEnd,
    sandboxId: mergedBuildTwo,
  }),
];

/**
 * What the hotfix did inside its phase, which lives in the panel and nowhere else.
 *
 * Two of them and no more: the rule is that no question may need an occurrence to answer it, so
 * these are here to be *read*, not to carry anything the phase row is missing.
 */
const mergedOccurrences: ReadonlyArray<Occurrence> = [
  occurrence({
    runId: "run-merged",
    phase: "hotfix",
    kind: "tool",
    name: "Read src/server.ts",
    startedAt: mergedHotfix + 2 * second,
    endedAt: mergedHotfix + 3 * second,
  }),
  occurrence({
    runId: "run-merged",
    phase: "hotfix",
    kind: "exec",
    name: "bun test src/server.test.ts",
    startedAt: mergedHotfix + 4 * minute,
    endedAt: mergedHotfix + 4 * minute + 12 * second,
  }),
];

const mergedSandboxes: ReadonlyArray<SandboxRecord> = [
  // Torn down because the run stopped to wait for a human — not a fault, and the row says so.
  acquisition({
    runId: "run-merged",
    name: "build",
    acquiredAt: mergedSetupOne,
    releasedAt: mergedSuspended,
    sequence: 1,
    outcome: "interrupted",
  }),
  // The rebuild the gate cost. Ninety seconds of setup that produced no work, on its own row.
  acquisition({
    runId: "run-merged",
    name: "build",
    acquiredAt: mergedResumed,
    releasedAt: mergedEnd,
    sequence: 2,
  }),
];

/**
 * **A run held at a gate right now.**
 *
 * Twelve minutes of work and then forty-one hours of nothing, which is where the run still is. The
 * dead time is a *gap* rather than a span — no record covers it, because the phase that would have
 * covered it never started — so it is the case that proves an idle stretch cannot hide between two
 * phases.
 */
const approveStart = frozenNow - 41 * hour - 12 * minute;
const approveRoute = approveStart + 200;
const approveSetup = approveRoute + 8 * second;
const approveScout = approveSetup + 90 * second;
const approveHotfix = approveScout + 2 * minute;
const approveSuspended = approveStart + 12 * minute;
const approveBuild = makeSandboxId("run-approve", "build", approveSetup, 1);

const approvePhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-approve",
    name: "in_progress",
    kind: "code",
    startedAt: approveStart,
    endedAt: approveRoute,
  }),
  phase({
    runId: "run-approve",
    name: "route",
    kind: "agent",
    startedAt: approveRoute,
    endedAt: approveSetup,
  }),
  phase({
    runId: "run-approve",
    name: "scout",
    kind: "agent",
    startedAt: approveScout,
    endedAt: approveHotfix,
    sandboxId: approveBuild,
  }),
  // **Interrupted, not failed.** The suspension killed it; it did nothing wrong, and a waterfall that
  // outlined it in red would accuse it of something.
  phase({
    runId: "run-approve",
    name: "hotfix",
    kind: "agent",
    startedAt: approveHotfix,
    endedAt: approveSuspended,
    outcome: "interrupted",
    sandboxId: approveBuild,
  }),
];

const approveSandboxes: ReadonlyArray<SandboxRecord> = [
  // The container went down with the run. `interrupted` is what a suspension looks like from inside
  // the scope, and it is the reason the wait that follows is *dead* time rather than a long phase.
  acquisition({
    runId: "run-approve",
    name: "build",
    acquiredAt: approveSetup,
    releasedAt: approveSuspended,
    sequence: 1,
    outcome: "interrupted",
  }),
];

/**
 * **A phase in flight, inside a container that has no record yet.**
 *
 * Two exited phases and one that is still running, so the waterfall has to draw a span from a record
 * that does not exist yet — it comes off the run row instead (adr/trace/0002) and grows to *now*.
 *
 * The lane it runs in has no `SandboxRecord` either, and that is not an oversight: an acquisition is
 * written when it is **released**, so a container being used right now is named by a phase and by
 * nothing else. A waterfall that put that phase on the host row would say the work needed no
 * container while it is sitting inside one.
 */
const scoutStart = frozenNow - 10 * second;
const scoutRoute = scoutStart + 200;
const scoutSetup = scoutStart + 2 * second;
const scoutExplore = scoutSetup + 1_500;
const scoutLane = makeSandboxId("run-scout", "lane", scoutSetup, 1);

const scoutRun = summary({
  runId: "run-scout",
  workflow: "scout",
  startedAt: scoutStart,
  inFlight: new InFlightPhase({
    phaseId: makePhaseId("run-scout", "explore", 1),
    name: "explore",
    kind: "agent",
    attempt: 1,
    startedAt: scoutExplore,
    sandboxId: scoutLane,
  }),
});

const scoutPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-scout",
    name: "in_progress",
    kind: "code",
    startedAt: scoutStart,
    endedAt: scoutRoute,
  }),
  phase({
    runId: "run-scout",
    name: "route",
    kind: "agent",
    startedAt: scoutRoute,
    endedAt: scoutSetup,
  }),
];

/**
 * What the phase that is **still running** has done so far.
 *
 * The stream console.md §6 describes: a panel opened on this phase asks again on the poll interval
 * and appends whatever arrived, while a panel opened on a phase that has exited asks once and stops.
 * The same three records appear in `settled` under the same phase id, which is what lets the two
 * behaviours be told apart by the trace rather than by the page.
 */
const scoutOccurrences: ReadonlyArray<Occurrence> = [
  occurrence({
    runId: "run-scout",
    phase: "explore",
    kind: "tool",
    name: "Glob src/**/*.ts",
    startedAt: scoutExplore + 100,
    endedAt: scoutExplore + 400,
  }),
  occurrence({
    runId: "run-scout",
    phase: "explore",
    kind: "exec",
    name: "rg --files-with-matches TODO",
    startedAt: scoutExplore + 500,
    endedAt: scoutExplore + 900,
  }),
  occurrence({
    runId: "run-scout",
    phase: "explore",
    kind: "iteration",
    name: "turn 2",
    startedAt: scoutExplore + 1_000,
    endedAt: scoutExplore + 2_000,
  }),
];

/**
 * **The same run, one phase later.**
 *
 * `settled` carries `run-scout` with `explore` **exited**: same run id, same phase id, a record
 * where the run row had a status, and a released acquisition where the row had none. It is the other
 * half of the in-flight proof — a spec that only ever saw the growing span could not tell a span
 * that is replaced on exit from one that is drawn twice.
 */
const scoutSettledEnd = scoutExplore + 4 * second;

const scoutSettledRun = summary({
  runId: "run-scout",
  workflow: "scout",
  startedAt: scoutStart,
  outcome: "succeeded",
  finishedAt: scoutSettledEnd + 500,
});

const scoutSettledPhases: ReadonlyArray<PhaseRecord> = [
  ...scoutPhases,
  phase({
    runId: "run-scout",
    name: "explore",
    kind: "agent",
    startedAt: scoutExplore,
    endedAt: scoutSettledEnd,
    sandboxId: scoutLane,
  }),
];

const scoutSettledSandboxes: ReadonlyArray<SandboxRecord> = [
  acquisition({
    runId: "run-scout",
    name: "lane",
    acquiredAt: scoutSetup,
    releasedAt: scoutSettledEnd + 500,
    sequence: 1,
  }),
];

/**
 * **A correction loop, and a check that never held.**
 *
 * `plan` answered on its third attempt — two corrections inside **one** record and therefore one
 * span, which is the distinction adr/trace/0001 draws against `fix_1` / `retest_1` / `fix_2`, four
 * phases the author wrote. `implement` exhausted its corrections and died on a check.
 */
const brokenStart = frozenNow - 5 * hour;
const brokenRoute = brokenStart + 200;
const brokenSetup = brokenRoute + 8 * second;
const brokenPlan = brokenSetup + 90 * second;
const brokenImplement = brokenPlan + 2 * minute;
const brokenEnd = brokenImplement + 4 * minute;
const brokenFeature = makeSandboxId("run-broken", "feature", brokenSetup, 1);

const brokenRun = summary({
  runId: "run-broken",
  workflow: "feature",
  startedAt: brokenStart,
  outcome: "failed",
  finishedAt: brokenEnd,
});

const brokenPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-broken",
    name: "in_progress",
    kind: "code",
    startedAt: brokenStart,
    endedAt: brokenRoute,
  }),
  phase({
    runId: "run-broken",
    name: "route",
    kind: "agent",
    startedAt: brokenRoute,
    endedAt: brokenSetup,
  }),
  phase({
    runId: "run-broken",
    name: "plan",
    kind: "agent",
    startedAt: brokenPlan,
    endedAt: brokenImplement,
    sandboxId: brokenFeature,
    // Three attempts: the first answer and two corrections. One record, one span.
    corrections: 2,
    // The three attempts went back into **one** conversation, and the window it left is the number
    // that predicts the next failure. Both are claims only the captured session can settle.
    resumed: true,
    contextTokens: 118_000,
  }),
  // Claimed two paths and changed one. The pair of columns is what makes an agent that reported work
  // it did not do visible after the run rather than during the review.
  phase({
    runId: "run-broken",
    name: "implement",
    kind: "agent",
    startedAt: brokenImplement,
    endedAt: brokenEnd,
    outcome: "failed",
    sandboxId: brokenFeature,
    errorTag: "CheckViolation",
    corrections: 3,
    // A second check died before it could report a verdict, so it is in `failed` and never joined
    // `ran`. The panel must show it anyway; drawing `ran` alone would lose a failure silently.
    unlistedFailure: "the type checker is clean",
    claimed: ["src/queue.ts", "tests/queue.test.ts"],
    changed: ["src/queue.ts"],
    commits: ["4d51e0c"],
    resumed: true,
    contextTokens: 174_000,
  }),
];

/** What the failing phase did before the check refused it — the last one is why it died. */
const brokenOccurrences: ReadonlyArray<Occurrence> = [
  occurrence({
    runId: "run-broken",
    phase: "implement",
    kind: "tool",
    name: "Edit src/queue.ts",
    startedAt: brokenImplement + 20 * second,
    endedAt: brokenImplement + 21 * second,
  }),
  occurrence({
    runId: "run-broken",
    phase: "implement",
    kind: "exec",
    name: "bun test",
    startedAt: brokenImplement + 60 * second,
    endedAt: brokenImplement + 95 * second,
    outcome: "failed",
    detail: "exit 1: 2 tests failed",
  }),
  occurrence({
    runId: "run-broken",
    phase: "implement",
    kind: "iteration",
    name: "correction 3",
    startedAt: brokenImplement + 2 * minute,
    endedAt: brokenEnd,
    outcome: "failed",
    detail: "the tests pass — still failing",
  }),
];

const brokenSandboxes: ReadonlyArray<SandboxRecord> = [
  acquisition({
    runId: "run-broken",
    name: "feature",
    acquiredAt: brokenSetup,
    releasedAt: brokenEnd,
    sequence: 1,
    outcome: "failed",
  }),
];

/**
 * **A permission breach.**
 *
 * A separate run because a breach kills the phase it happened in, so it cannot sit beside the check
 * violation above in one history. That is also exactly why it needs its own mark on the timeline:
 * both runs end in a failed agent phase, and only one of them left the repository holding something
 * a re-prompt cannot take back.
 */
const breachStart = frozenNow - 6 * hour;
const breachRoute = breachStart + 200;
const breachSetup = breachRoute + 8 * second;
const breachEdit = breachSetup + 90 * second;
const breachEnd = breachEdit + 3 * minute;
const breachSandbox = makeSandboxId("run-breach", "feature", breachSetup, 1);

const breachRun = summary({
  runId: "run-breach",
  workflow: "feature",
  startedAt: breachStart,
  outcome: "failed",
  finishedAt: breachEnd,
});

const breachPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-breach",
    name: "in_progress",
    kind: "code",
    startedAt: breachStart,
    endedAt: breachRoute,
  }),
  phase({
    runId: "run-breach",
    name: "route",
    kind: "agent",
    startedAt: breachRoute,
    endedAt: breachSetup,
  }),
  phase({
    runId: "run-breach",
    name: "edit",
    kind: "agent",
    startedAt: breachEdit,
    endedAt: breachEnd,
    outcome: "failed",
    sandboxId: breachSandbox,
    errorTag: "PermissionBreach",
    breaches: [
      new PathRollback({ path: ".github/workflows/ci.yml", outcome: { _tag: "Restored" } }),
      // The one that must never be silent: work nothing can bring back.
      new PathRollback({ path: "docs/notes.md", outcome: { _tag: "WorkLost" } }),
    ],
  }),
];

const breachSandboxes: ReadonlyArray<SandboxRecord> = [
  acquisition({
    runId: "run-breach",
    name: "feature",
    acquiredAt: breachSetup,
    releasedAt: breachEnd,
    sequence: 1,
    outcome: "failed",
  }),
];

/**
 * **An answer that never decoded.**
 *
 * The other half of the verdict, and the reason it is a separate run: a phase that died on
 * `EnvelopeParseError` never reached a check, so its `failed` list is empty for a reason that has
 * nothing to do with the answer being accepted. A panel that read an empty list as *every check
 * held* would say this phase passed. It ran on the host, so it is also the case that says *where it
 * ran* is a fact rather than a missing sandbox.
 */
const refusedStart = frozenNow - 20 * minute;
const refusedRoute = refusedStart + 200;
const refusedDraft = refusedRoute + 8 * second;
const refusedEnd = refusedDraft + 3 * minute;

const refusedRun = summary({
  runId: "run-refused",
  workflow: "feature",
  startedAt: refusedStart,
  outcome: "failed",
  finishedAt: refusedEnd,
});

const refusedPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-refused",
    name: "in_progress",
    kind: "code",
    startedAt: refusedStart,
    endedAt: refusedRoute,
  }),
  phase({
    runId: "run-refused",
    name: "draft",
    kind: "agent",
    startedAt: refusedDraft,
    endedAt: refusedEnd,
    outcome: "failed",
    errorTag: "EnvelopeParseError",
    // Zero corrections, and not because the first answer was accepted. The invoker cannot re-enter a
    // session, so no correction was possible at all — the pair of fields is what tells that apart
    // from `run-broken/implement`, which corrected three times and still died.
    corrections: 0,
    correctable: false,
  }),
];

/**
 * **One phase long enough to flatten everything beside it.**
 *
 * Three hours of one agent phase after eight seconds of routing. The break here falls *inside* a
 * span rather than in a gap, which is the case a design that only broke gaps would draw as a
 * hairline `route` beside a bar three hours wide.
 */
const staleStart = frozenNow - 50 * hour;
const staleRoute = staleStart + 200;
const staleExplore = staleRoute + 8 * second;
const staleEnd = staleExplore + 3 * hour;

const stalePhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-stale",
    name: "in_progress",
    kind: "code",
    startedAt: staleStart,
    endedAt: staleRoute,
  }),
  phase({
    runId: "run-stale",
    name: "route",
    kind: "agent",
    startedAt: staleRoute,
    endedAt: staleExplore,
  }),
  phase({
    runId: "run-stale",
    name: "explore",
    kind: "agent",
    startedAt: staleExplore,
    endedAt: staleEnd,
  }),
];

/**
 * **A gate somebody has already answered, over a run that has not moved.**
 *
 * The state adr/gate/0001 exists for, and the one no other fixture holds: the asking carries a
 * verdict, and the trace carries **no `GateRecord` for it**. That pair is what *recorded, not
 * applied* looks like from outside — the record is written by the run itself, in the activity that
 * follows the suspension, so its absence is proof the run has not woken up.
 *
 * The same records are served by two fixtures with different runner tables, which is what makes the
 * two recorded states gradable: `busy` has nobody registered and `watching` has a live runner, so
 * one set of records renders *nothing is running* and the other renders *applying…*.
 */
const recordedStart = frozenNow - 3 * hour;
const recordedRoute = recordedStart + 200;
const recordedBuild = recordedRoute + 4 * second;
const recordedSuspended = recordedBuild + 6 * minute;
/** Five minutes ago somebody clicked. Nothing has applied it, and the card must not pretend. */
const recordedAnsweredAt = frozenNow - 5 * minute;

const recordedRun = summary({
  runId: "run-recorded",
  workflow: "release",
  startedAt: recordedStart,
  outcome: "suspended",
  finishedAt: recordedSuspended,
});

const recordedPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-recorded",
    name: "in_progress",
    kind: "code",
    startedAt: recordedStart,
    endedAt: recordedRoute,
  }),
  phase({
    runId: "run-recorded",
    name: "build",
    kind: "agent",
    startedAt: recordedBuild,
    endedAt: recordedSuspended,
    outcome: "interrupted",
  }),
];

const recordedAsking = asking({
  runId: "run-recorded",
  gate: "approve-release",
  actor: "release-manager",
  requestedAt: recordedSuspended,
  deadlineAt: frozenNow + 21 * hour,
});

/**
 * **A gate that exists to be answered by a test, and by nothing else.**
 *
 * Every other asking in this fixture is read by some assertion about how it is *drawn*, and a
 * browser test that answered one of those would change what the next test sees — the askings live in
 * one repository for the life of the server. So the click has a subject of its own.
 *
 * It is stated once and served by both `busy` and `watching`, which is what makes the pair of
 * recorded states gradable from the same gesture: the same click on the same records resolves to
 * *nothing is running* against one server and to *applying…* against the other.
 */
const waitingStart = frozenNow - 70 * minute;
const waitingRoute = waitingStart + 200;
const waitingSuspended = waitingStart + 10 * minute;

const waitingRun = summary({
  runId: "run-waiting",
  workflow: "release",
  startedAt: waitingStart,
  outcome: "suspended",
  finishedAt: waitingSuspended,
});

const waitingPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-waiting",
    name: "in_progress",
    kind: "code",
    startedAt: waitingStart,
    endedAt: waitingRoute,
  }),
  phase({
    runId: "run-waiting",
    name: "draft",
    kind: "agent",
    startedAt: waitingRoute,
    endedAt: waitingSuspended,
    outcome: "interrupted",
  }),
];

/**
 * **A gate nobody answered in time, that the run has already settled.**
 *
 * The fourth shape, and the one that catches a reader who takes a `GateRecord` at face value.
 * `phase/gate.ts` writes the record for *both* halves of the race, so this run carries an asking
 * with **no verdict** and a settled record whose outcome is `expired`. A Console that read the
 * record's presence as proof of an answer would draw *"Applied — the run resumed. A runner picked
 * the answer up"* over a question nobody ever decided — the same lie as *applied for recorded*,
 * pointed the other way, and worse, because there is no decision behind it at all.
 *
 * It expires on `reject` rather than on `fail` on purpose: the rejection is answered on the human's
 * behalf and the run **keeps going**, which is the only shape in which a settled asking is still
 * drawn. A `fail` branch ends the run, and a run that has ended shows no card to be wrong on.
 *
 * The times are chosen so it does not disturb the queue: six hours waited puts it below
 * `run-stale`'s forty-seven, so *worst first* still names the same row first.
 */
const expiredStart = frozenNow - 9 * hour;
const expiredRoute = expiredStart + 200;
const expiredRequested = frozenNow - 6 * hour;
/** Two hours ago the clock won the race, and the run took its rejection branch and carried on. */
const expiredDeadline = frozenNow - 4 * hour;

const expiredRun = summary({
  runId: "run-expired",
  workflow: "release",
  startedAt: expiredStart,
});

const expiredPhases: ReadonlyArray<PhaseRecord> = [
  phase({
    runId: "run-expired",
    name: "in_progress",
    kind: "code",
    startedAt: expiredStart,
    endedAt: expiredRoute,
  }),
  phase({
    runId: "run-expired",
    name: "deploy",
    kind: "agent",
    startedAt: expiredRoute,
    endedAt: expiredRequested,
    outcome: "interrupted",
  }),
];

const expiredAsking = asking({
  runId: "run-expired",
  gate: "approve-deploy",
  actor: "on-call",
  requestedAt: expiredRequested,
  deadlineAt: expiredDeadline,
  onExpiry: "reject",
});

/**
 * The applied half of the same pair, for the run that finished.
 *
 * `run-merged` already carries the settled `GateRecord`. Giving its asking the matching verdict is
 * what completes the evidence the Console reads: a verdict **and** a record is *applied — the run
 * resumed*, and the two together are the only thing that may ever be drawn that way.
 */
const mergedAsking = asking({
  runId: "run-merged",
  gate: "approve-hotfix",
  actor: "release-manager",
  requestedAt: mergedSuspended,
  deadlineAt: mergedSuspended + 72 * hour,
});

const mergedVerdict = new Verdict({
  choice: "approve",
  reason: "the change is small and the tests are green",
  answerer: "release-manager",
  answeredAt: mergedResumed,
});

/**
 * ------------------------------------------------------------------------------------------------
 * The three things the trace does not store, and the phases that are missing them.
 *
 * console.md §6 fetches all three on demand and §10 requires that a missing one degrades **that pane
 * only**. So the map below is written for the absences as much as for the contents:
 *
 * - `run-merged/hotfix/1` has all three. It is the case where nothing is degraded.
 * - `run-broken/implement/1` has a prompt and a transcript and **no diff**, over a phase whose record
 *   lists a commit. That is what a deleted branch looks like from here: the record still says which
 *   paths changed, and git can no longer say what changed in them.
 * - `run-refused/draft/1` has a prompt and a transcript and committed nothing, so its diff is absent
 *   for the other reason — and the two reasons must not read alike.
 * - `run-breach/edit/1` is not in this map at all. Every pane degrades and the record still renders.
 * ------------------------------------------------------------------------------------------------
 */
const artifacts: InMemoryArtifactReader.Artifacts = {
  [makePhaseId("run-merged", "hotfix", 1)]: {
    prompt: "# system\nYou are the builder.\n\n# user\nFix the panic in src/server.ts.\n",
    session: [
      '{"role":"user","text":"Fix the panic in src/server.ts."}',
      '{"role":"assistant","text":"Guarded the nil socket and added a test."}',
    ].join("\n"),
    diff: "--- a/src/server.ts\n+++ b/src/server.ts\n@@\n-  socket.write(body)\n+  socket?.write(body)\n",
  },
  [makePhaseId("run-broken", "implement", 1)]: {
    prompt: "# system\nYou are the builder.\n\n# user\nImplement the queue from the plan.\n",
    // What `corrections: 3` cost, said in the only place that can say it. Without the transcript the
    // count is a number nobody can audit.
    session: [
      '{"role":"user","text":"Implement the queue from the plan."}',
      '{"role":"assistant","text":"Done — src/queue.ts and tests/queue.test.ts."}',
      '{"role":"user","text":"the tests pass — did not hold. Correct your answer."}',
      '{"role":"assistant","text":"Fixed the ordering."}',
    ].join("\n"),
  },
  [makePhaseId("run-refused", "draft", 1)]: {
    prompt: "# system\nYou are the drafter.\n\n# user\nAnswer with an Answer envelope.\n",
    session: '{"role":"assistant","text":"Sure! Here is the plan: ..."}',
  },
};

/**
 * A factory in the middle of its working day.
 *
 * It holds every status the list can draw, and two of them are the ones a run list gets wrong:
 * a run suspended on a gate that is still inside its deadline, and a run suspended on one that has
 * gone past it. It also holds a run that has only just started and has no phases at all, which is
 * the state console.md names as a thing a UI renders as an error when it should render as *nothing
 * yet*.
 */
const busy: Fixture = {
  factory: "present",
  runs: [
    scoutRun,
    // A run that has only just started: no phases, nothing in flight. The state a UI renders as an
    // error when it should render as *nothing yet*.
    summary({ runId: "run-build", workflow: "feature", startedAt: frozenNow - 3 * minute }),
    summary({
      runId: "run-approve",
      workflow: "hotfix",
      startedAt: approveStart,
      outcome: "suspended",
      finishedAt: approveSuspended,
    }),
    summary({
      runId: "run-stale",
      workflow: "feature",
      startedAt: staleStart,
      outcome: "suspended",
      finishedAt: staleEnd,
    }),
    // Answered five minutes ago and still suspended: an answer that is recorded and not applied.
    recordedRun,
    // Waiting, and the only asking a browser test is allowed to answer.
    waitingRun,
    // Still going, over a gate the deadline settled two hours ago without anybody deciding.
    expiredRun,
    mergedRun,
    brokenRun,
    breachRun,
    refusedRun,
  ],
  askings: [
    // Forty-one hours with a human and seven still to go: console.md's worked example, and the span
    // that makes a linear time axis useless.
    asking({
      runId: "run-approve",
      gate: "approve-hotfix",
      actor: "release-manager",
      requestedAt: approveSuspended,
      deadlineAt: frozenNow + 7 * hour,
      // Three choices, because a card that hard-coded approve and reject would draw two buttons over
      // a gate that declared three — and the third is the one nobody could ever pick.
      choices: ["approve", "reject", "hold"],
    }),
    // The one a browser test answers. Nothing asserts how it is drawn before the click.
    asking({
      runId: "run-waiting",
      gate: "approve-change",
      actor: "reviewer",
      requestedAt: waitingSuspended,
      deadlineAt: frozenNow + 11 * hour,
    }),
    // Nobody answered in time. The run is stuck on a question that has gone stale.
    asking({
      runId: "run-stale",
      gate: "approve-feature",
      actor: "tech-lead",
      requestedAt: staleEnd,
      deadlineAt: frozenNow - 2 * hour,
    }),
    // Nobody answered in time **and the run has already moved on**. The record below is what tells
    // the two apart, and reading only its presence is what draws this one as answered.
    expiredAsking,
  ],
  answers: [
    // Recorded, and nothing carries it further: no `GateRecord` for this asking exists below.
    {
      asking: recordedAsking,
      verdict: new Verdict({
        choice: "approve",
        reason: "release notes are signed off",
        answerer: "release-manager",
        answeredAt: recordedAnsweredAt,
      }),
    },
    // Recorded **and** applied: the run woke up, and the record beneath is what says so.
    { asking: mergedAsking, verdict: mergedVerdict },
  ],
  expiries: [
    // The run's own settlement, beside the `expired` GateRecord below. It is what takes this asking
    // out of the *waiting* list and the *N waiting on a human* count: nobody can answer it any more,
    // and a queue that listed it would be listing work nobody can do.
    { asking: expiredAsking, expiredAt: expiredDeadline },
  ],
  runners: [],
  phases: [
    ...scoutPhases,
    ...approvePhases,
    ...stalePhases,
    ...recordedPhases,
    ...waitingPhases,
    ...expiredPhases,
    ...mergedPhases,
    ...brokenPhases,
    ...breachPhases,
    ...refusedPhases,
  ],
  gates: [
    answered({
      runId: "run-merged",
      gate: "approve-hotfix",
      actor: "release-manager",
      requestedAt: mergedSuspended,
      answeredAt: mergedResumed,
    }),
    // Settled by the clock, not by a person. Same record, different outcome — and the whole of what
    // keeps *applied* from being read out of a record's mere presence.
    expired({
      runId: "run-expired",
      gate: "approve-deploy",
      actor: "on-call",
      requestedAt: expiredRequested,
      deadlineAt: expiredDeadline,
      onExpiry: "reject",
    }),
  ],
  sandboxes: [...approveSandboxes, ...mergedSandboxes, ...brokenSandboxes, ...breachSandboxes],
  occurrences: [...scoutOccurrences, ...mergedOccurrences, ...brokenOccurrences],
  artifacts,
};

/**
 * The same factory, with `kojo watch` running.
 *
 * One registration, four seconds old — comfortably inside the cluster's thirty-five second window,
 * so `live` keeps it and the health document answers `live`. Nothing else differs, and that is the
 * point: the two fixtures are one variable apart, so a difference in what the gate card says can
 * only come from the runner table.
 */
const watching: Fixture = {
  ...busy,
  runners: [new RunnerRegistration({ address: "127.0.0.1:34431", heartbeatAgeMillis: 4 * second })],
};

/**
 * A factory where everything has stopped.
 *
 * Every run has reached a terminal outcome, which is the exact condition under which the Console
 * must stop asking for good. A fixture with one live run in it could not tell a poll that stopped
 * from a poll that was merely slow.
 */
const settled: Fixture = {
  factory: "present",
  runs: [scoutSettledRun, mergedRun, brokenRun],
  askings: [],
  answers: [],
  expiries: [],
  runners: [],
  phases: [...scoutSettledPhases, ...mergedPhases, ...brokenPhases],
  gates: [
    answered({
      runId: "run-merged",
      gate: "approve-hotfix",
      actor: "release-manager",
      requestedAt: mergedSuspended,
      answeredAt: mergedResumed,
    }),
  ],
  sandboxes: [...scoutSettledSandboxes, ...mergedSandboxes, ...brokenSandboxes],
  // The same occurrences under the same phase id as `busy` carries them, over a phase that has now
  // exited. Nothing about them changes; what changes is that the panel must stop asking for more.
  occurrences: [...scoutOccurrences, ...mergedOccurrences, ...brokenOccurrences],
  artifacts,
};

/** A factory somebody has stamped and never used. */
const empty: Fixture = {
  factory: "present",
  runs: [],
  askings: [],
  answers: [],
  expiries: [],
  runners: [],
  phases: [],
  gates: [],
  sandboxes: [],
  occurrences: [],
  artifacts: {},
};

/** A repository nobody has run `kojo init` in. Not an error; a sentence. */
const absent: Fixture = {
  factory: "absent",
  runs: [],
  askings: [],
  answers: [],
  expiries: [],
  runners: [],
  phases: [],
  gates: [],
  sandboxes: [],
  occurrences: [],
  artifacts: {},
};

const fixtures = { busy, watching, settled, empty, absent } as const;

/** The names `kojo ui --fixtures` accepts. */
export const fixtureNames = ["busy", "watching", "settled", "empty", "absent"] as const;

export type FixtureName = (typeof fixtureNames)[number];

/** Whether this fixture claims a factory exists, which is what the health document reports. */
export const fixturePresence = (name: FixtureName): FactoryPresence => fixtures[name].factory;

/**
 * Who this fixture says is registered to apply an answer.
 *
 * Read by `kojo ui --fixtures` and handed to `InMemoryRunnerRepository`, so the presence the health
 * document and every answer receipt report comes from the same staleness rule the SQLite adapter
 * runs — `RunnerRegistration.live`, never `RunnerHealth`.
 */
export const fixtureRunners = (name: FixtureName): ReadonlyArray<RunnerRegistration> =>
  fixtures[name].runners;

/**
 * The four ports the Console reads, over stated records.
 *
 * The askings are seeded through `GateRepository.asked` rather than by handing the adapter a map,
 * so the fixtures go in the way a run puts them in. A repository filled by any other route would be
 * a repository whose own rules — one asking per token, first answer wins — had never run.
 */
export const fixtureLayer = (
  name: FixtureName,
): Layer.Layer<TraceReader | ArtifactReader | GateRepository> => {
  const fixture = fixtures[name];

  const askings = Layer.effectDiscard(
    Effect.flatMap(GateRepository, (repository) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [...fixture.askings, ...fixture.answers.map((answer) => answer.asking)],
          (request) => repository.asked(request),
          { discard: true },
        );
        // Written the way an answering half writes it — `asked`, then `recorded` against the token
        // — so a seeded verdict goes through the repository's own rule that the first answer wins.
        yield* Effect.forEach(
          fixture.answers,
          (answer) => repository.recorded({ token: answer.asking.token, verdict: answer.verdict }),
          { discard: true },
        );
        // And the settlements, the way the run's own record activity writes them: `asked` above,
        // then `expired` against the token. The asking itself is stated in `fixture.askings`.
        yield* Effect.forEach(
          fixture.expiries,
          (expiry) =>
            repository.expired({ token: expiry.asking.token, expiredAt: expiry.expiredAt }),
          { discard: true },
        );
      }),
    ).pipe(
      // The in-memory repository cannot fail, but the port says it can. A fixture that could not be
      // written down is a broken build rather than a condition the Console should survive.
      Effect.orDie,
    ),
  ).pipe(Layer.provideMerge(InMemoryGateRepository.layer));

  return Layer.mergeAll(
    InMemoryTraceReader.of({
      runs: fixture.runs,
      phases: fixture.phases,
      gates: fixture.gates,
      sandboxes: fixture.sandboxes,
      occurrences: fixture.occurrences,
    }),
    InMemoryArtifactReader.of(fixture.artifacts),
    askings,
  );
};
