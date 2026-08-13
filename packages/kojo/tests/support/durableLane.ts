#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from "effect";
import { DurableDeferred } from "effect/unstable/workflow";
import { AgentInvocationError } from "../../src/contexts/agent/models/AgentInvocationError.ts";
import type { AgentSessionId } from "../../src/contexts/agent/models/AgentSessionId.ts";
import * as SqliteGateRepository from "../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import * as TerminalGate from "../../src/contexts/gate/adapters/TerminalGate.ts";
import { GateExpired } from "../../src/contexts/gate/models/GateExpired.ts";
import { GateRejected } from "../../src/contexts/gate/models/GateRejected.ts";
import { GateUnreachable } from "../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../src/contexts/gate/models/Verdict.ts";
import { answerGate } from "../../src/contexts/gate/services/answerGate.ts";
import { docker, noSandbox } from "../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import { SandboxError } from "../../src/contexts/sandbox/models/SandboxError.ts";
import type { SandboxProvider } from "../../src/contexts/sandbox/models/SandboxProvider.ts";
import { WorkspaceError } from "../../src/contexts/sandbox/models/WorkspaceError.ts";
import { WorkspaceUnreachable } from "../../src/contexts/sandbox/models/WorkspaceUnreachable.ts";
import { WorktreeUnusable } from "../../src/contexts/sandbox/models/WorktreeUnusable.ts";
import { Workspace } from "../../src/contexts/sandbox/ports/Workspace.ts";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../src/contexts/shared/models/RunId.ts";
import * as SingleNodeEngine from "../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import { CheckViolation } from "../../src/contexts/workflow/models/CheckViolation.ts";
import { EnvelopeParseError } from "../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { agent } from "../../src/contexts/workflow/services/phase/agent.ts";
import { code } from "../../src/contexts/workflow/services/phase/code.ts";
import { reviewed } from "../../src/contexts/workflow/services/reviewed.ts";
import { type RunStatus, start, status } from "../../src/contexts/workflow/services/run.ts";
import { sandboxed } from "../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../src/contexts/workflow/services/workflow.ts";
import * as InSandboxAgentInvoker from "./InSandboxAgentInvoker.ts";
import * as JsonlTracer from "./JsonlTracer.ts";
import { localIsolated } from "./localIsolatedProvider.ts";

/**
 * **One whole lane, runnable on its own, driven from a command line.**
 *
 * This is ticket 19's subject rather than its scaffolding. Everything waves 4 and 5 built meets here
 * at once — a `sandboxed` scope around real containers, a real agent process inside them, the
 * reviewed loop, the durable engine on a SQLite file, a trace that outlives the process — and the
 * only way to grade the claim the design rests on is to start the run in one process, let that
 * process **exit**, and finish the run in another.
 *
 * Nothing here is in-memory. The engine is `SingleNodeEngine` over a file, the sandbox source is
 * `SandcastleSandboxSource`, the gate is `TerminalGate`, the trace is a JSONL file two processes
 * append to, and the agent is a command in the container.
 *
 * The lane is a **top-level workflow**, started by `start(lane.definition, payload)`. It is not
 * reachable only as a child of some parent workflow, and that is one of the acceptance criteria: a
 * lane a factory cannot start on its own is a lane nobody can re-run after it fails.
 */

/** What the harness is pointed at. Passed as one JSON file, because argv is not a config format. */
interface LaneConfig {
  readonly database: string;
  readonly trace: string;
  readonly sessions: string;
  /** The host repository the worktree is cut from. */
  readonly repo: string;
  readonly branch: string;
  readonly provider: "no-sandbox" | "docker" | "isolated";
  /** Only read for `docker`. The image must already exist locally. */
  readonly imageName?: string;
  /** Whether the agent invocation stamps its own attempt over the acquisition's. */
  readonly stampAttempt?: boolean;
}

/**
 * What the agent hands back — and every field of it is an assertion.
 *
 * `runId` and `sandbox` are `$KOJO_RUN_ID` and `$KOJO_PHASE_ID` **as the process inside the
 * container read them**, so a lane that decodes this has proved the correlation crossed two
 * boundaries Effect cannot: Sandcastle's own bundled runtime, and the container.
 */
class Notes extends Schema.Class<Notes>("Notes")({
  finding: Schema.String,
  /** Which turn of the conversation produced it. Two means the session was genuinely re-entered. */
  turn: Schema.Finite,
  session: Schema.String,
  runId: Schema.String,
  sandbox: Schema.String,
  attempt: Schema.String,
}) {}

/** The agent: a shell process in the sandbox that reports what it was told and what it can see. */
const script = [
  `printf '{"finding":"%s","turn":%s,"session":"%s","runId":"%s","sandbox":"%s","attempt":"%s"}'`,
  // The **first line** of the prompt. Since ticket 15 the agent phase appends the envelope's own
  // JSON Schema to every cold prompt, so the whole of `$KOJO_PROMPT` spliced into a JSON string
  // unescaped is no longer JSON — and this fake would fail to decode for a reason unrelated to the
  // correlation it exists to prove.
  `"$(printf '%s' "$KOJO_PROMPT" | head -n 1)" "$KOJO_TURN" "$KOJO_SESSION" "$KOJO_RUN_ID" "$KOJO_PHASE_ID" "$KOJO_ATTEMPT"`,
].join(" ");

const failures = Schema.Union([
  GateExpired,
  GateUnreachable,
  GateRejected,
  EnvelopeParseError,
  AgentInvocationError,
  CheckViolation,
  WorkspaceError,
  SandboxError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

/**
 * Where the body got to, in wall-clock terms, on whichever execution is running now.
 *
 * Set **outside** every activity, so they are rewritten on every replay — which is the whole point.
 * The gap between `insideAt` and `scoutedAt` on a resumed run is the cost of replaying every phase
 * that already completed, and the acceptance criterion says it is milliseconds.
 */
const marks = new Map<string, number>();
const mark = (name: string) =>
  Effect.sync(() => {
    marks.set(name, Date.now());
  });

const providerFor = (config: LaneConfig): SandboxProvider => {
  switch (config.provider) {
    case "docker":
      return docker(config.imageName === undefined ? {} : { imageName: config.imageName });
    case "isolated":
      return localIsolated();
    case "no-sandbox":
      return noSandbox();
  }
};

/** Commits whatever the phase before it left, with an identity a bare worktree may not have. */
const commit = (message: string): ReadonlyArray<string> => [
  "-c",
  "user.name=Kojo",
  "-c",
  "user.email=kojo@example.invalid",
  "commit",
  "--quiet",
  "--allow-empty",
  "--message",
  message,
];

const laneFor = (config: LaneConfig) =>
  workflow(
    {
      name: "lane",
      payload: { subject: Schema.String },
      success: Schema.String,
      error: failures,
      idempotencyKey: (payload) => `lane/${payload.subject}`,
    },
    (payload) =>
      Effect.gen(function* () {
        yield* mark("bodyAt");

        return yield* sandboxed(
          {
            name: "lane",
            branch: config.branch,
            provider: providerFor(config),
            cwd: config.repo,
            // No `worktree` option: the default policy is all three checks, and running a real lane
            // under it is one of the properties this ticket exists to close.
          },
          Effect.gen(function* () {
            yield* mark("insideAt");

            // Work the branch keeps. Written and committed *before* the gate, so the rebuild two
            // processes later has to find it — the branch is the durable state or it is not.
            yield* code(
              {
                name: "prepare",
                description: "Leave work on the branch before anyone is asked anything",
                success: Schema.Void,
                error: WorkspaceError,
              },
              Effect.gen(function* () {
                const workspace = yield* Workspace;
                yield* workspace.write("notes/subject.md", `${payload.subject}\n`);
                yield* workspace.git(["add", "--all"]);
                yield* workspace.git(commit("prepare"));
              }),
            );

            const notes = yield* agent({
              name: "scout",
              description: "Read the subject and report",
              agent: "scout",
              prompt: `scout ${payload.subject}`,
              envelope: Notes,
            });

            yield* mark("scoutedAt");

            const approved = yield* reviewed({
              name: "review",
              description: "Does this land?",
              actor: "engineer",
              limit: 3,
              deadline: Duration.days(7),
              onExpiry: OnExpiry.fail(),
              subject: notes,
              context: (subject) => ({ finding: subject.finding, turn: String(subject.turn) }),
              // The revision re-enters the **same session**, which is the seam the whole correction
              // design sits on. The session id came out of the agent's own answer, travelled through
              // a recorded activity result, and survives the process that obtained it exiting.
              revise: (verdict, subject) =>
                agent({
                  name: "revise",
                  description: "Answer the reviewer",
                  agent: "scout",
                  prompt: `revise ${verdict.reason}`,
                  envelope: Notes,
                  // A cast, like every other id Kojo mints: the string came out of the agent's own
                  // answer through this run's invoker, so decoding it would check nothing.
                  session: Option.some(subject.session as AgentSessionId),
                }),
            });

            yield* code(
              {
                name: "land",
                description: "Commit the approved finding",
                success: Schema.Void,
                error: WorkspaceError,
              },
              Effect.gen(function* () {
                const workspace = yield* Workspace;
                // The file `prepare` committed, read back after two rebuilds. A branch that did not
                // carry the work would fail here rather than quietly land something else.
                const carried = yield* workspace.read("notes/subject.md");
                yield* workspace.write(
                  "notes/finding.md",
                  `${carried.trim()}: ${approved.finding}`,
                );
                yield* workspace.git(["add", "--all"]);
                yield* workspace.git(commit("land"));
              }),
            );

            return [
              approved.finding,
              `turn=${approved.turn}`,
              `runId=${approved.runId}`,
              `sandbox=${approved.sandbox}`,
              `attempt=${approved.attempt}`,
              `session=${approved.session}`,
            ].join("|");
          }).pipe(
            // The invoker needs the sandbox it will run inside, so it is built **here** rather than
            // in the top-level layer: an agent that could be invoked outside a sandbox scope is an
            // agent that can run on the host by accident.
            Effect.provide(
              InSandboxAgentInvoker.layer({
                sessions: config.sessions,
                scripts: { scout: script },
                ...(config.stampAttempt === undefined ? {} : { stampAttempt: config.stampAttempt }),
              }),
            ),
          ),
        );
      }),
  );

/**
 * One client under both the engine's storage and everything else, exactly as `SqliteDatabase` says.
 *
 * The poll intervals are the cluster's defaults compressed. Ten seconds is right for a factory and
 * wrong for a test that would otherwise wait ten seconds to notice an answer another process wrote.
 */
const layersFor = (config: LaneConfig, lane: ReturnType<typeof laneFor>) =>
  lane.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        JsonlTracer.layer(config.trace),
        SandcastleSandboxSource.layer.pipe(Layer.provide(BunServices.layer)),
        // The gate stays terminal — printed, never listed — but the run itself needs the repository
        // now: the record activity writes an expiry settlement where the queue reads.
        TerminalGate.layer,
        SqliteGateRepository.layer,
        SingleNodeEngine.layer({
          shardingConfig: {
            entityMessagePollInterval: Duration.millis(100),
            entityReplyPollInterval: Duration.millis(100),
            refreshAssignmentsInterval: Duration.millis(100),
          },
        }),
      ),
    ),
    Layer.provideMerge(SqliteDatabase.layer({ path: config.database })),
  );

/**
 * Waits for **this** execution of the body to stop, then reports where it stopped.
 *
 * Polling `status` alone cannot do it. A run that suspends, resumes, and suspends again reads
 * `suspended` on both sides of the resume, so an answering process that polled for a status would
 * return the previous execution's answer before the engine had even delivered the verdict — and
 * every assertion after it would be about a run that had not moved.
 *
 * The trace's execution list is the signal that can say it: one entry per execution of the body,
 * appended by `runFinished`. Wait for one more than there were, and only then ask the engine where
 * the run is — the two agree within a poll or two, and asking the engine is what keeps the reported
 * value the real `run.ts` answer rather than the trace's opinion of it.
 */
const waitFor = (lane: ReturnType<typeof laneFor>, config: LaneConfig, runId: RunId, was: number) =>
  Effect.gen(function* () {
    const stopped = yield* Effect.repeat(
      Effect.sync(() => JsonlTracer.executionsOf(config.trace, runId)),
      {
        schedule: Schedule.spaced(Duration.millis(50)),
        until: (executions: ReadonlyArray<unknown>) => executions.length > was,
        times: 1800,
      },
    );
    const expected = stopped[stopped.length - 1];

    // Patient on purpose. A rejected asking costs **two** executions, not one: the engine replays
    // the body once more immediately after the retried gate suspends, and while that replay is in
    // flight `poll` answers `None` — which reads as `running`. On Docker that replay is a whole
    // container build, so a short poll here reports the run as still running when it has in fact
    // stopped. Waiting for the engine to agree with the trace is the honest end condition.
    return yield* Effect.repeat(status(lane.definition, runId), {
      schedule: Schedule.spaced(Duration.millis(100)),
      until: (reported: RunStatus) => reported === expected,
      times: 1800,
    });
  });

/** How many executions this run has already finished, before this process does anything. */
const executionsSoFar = (config: LaneConfig, runId: RunId): number =>
  JsonlTracer.executionsOf(config.trace, runId).length;

/** The gap between two marks of this execution, or nothing when the body never reached both. */
const between = (from: string, to: string): number | undefined => {
  const started = marks.get(from);
  const ended = marks.get(to);
  return started === undefined || ended === undefined ? undefined : ended - started;
};

/**
 * Why a failed run failed, in one line, or nothing when it did not fail.
 *
 * Without this a lane that fails reports the word `failed` and nothing else, and the test that
 * spawned it can only say what it expected. The reason is in the engine's recorded exit, so it is
 * read back rather than intercepted — the harness never sees the fiber that failed.
 */
const failureOf = (lane: ReturnType<typeof laneFor>, runId: RunId) =>
  Effect.map(lane.definition.poll(runId), (polled) =>
    Option.match(polled, {
      onNone: () => undefined,
      onSome: (result) => {
        if (result._tag !== "Complete") return undefined;
        const exit = result.exit;
        if (!Exit.isFailure(exit)) return undefined;

        // The typed failure, serialised whole. `Cause.pretty` prints a `Schema.TaggedError`'s tag
        // and then a stack, and the fields — the `reason` that says what the sandbox or the agent
        // actually complained about — are exactly what is missing from it.
        return Option.match(Cause.findErrorOption(exit.cause), {
          onNone: () => Cause.pretty(exit.cause).split("\n").slice(0, 3).join(" / "),
          onSome: (error) => JSON.stringify(error),
        });
      },
    }),
  );

/** What every command prints. One line of JSON, read by the test that spawned it. */
const reported = (
  runId: RunId,
  reachedStatus: RunStatus,
  startedAt: number,
  failure: string | undefined,
) => ({
  runId,
  status: reachedStatus,
  failure,
  /** Body start to the review, on *this* execution. On a resume it is the replay's whole cost. */
  replayToScoutMillis: between("bodyAt", "scoutedAt"),
  /** The same window with the container build taken out: the phases' replay, and nothing else. */
  replayInsideSandboxMillis: between("insideAt", "scoutedAt"),
  processMillis: Date.now() - startedAt,
});

const started = (
  lane: ReturnType<typeof laneFor>,
  config: LaneConfig,
  subject: string,
  startedAt: number,
) =>
  Effect.gen(function* () {
    const runId = yield* start(lane.definition, { subject });
    const reached = yield* waitFor(lane, config, runId, 0);
    return reported(runId, reached, startedAt, yield* failureOf(lane, runId));
  });

/**
 * The answering half, from a process that never saw the run start.
 *
 * The token is rebuilt from the run id and the asking number alone — `tokenFromExecutionId` needs
 * nothing that has to be carried across the process boundary. The gate's deferred name is
 * `gate/<lane>/<name>/<asking>`: the lane is the enclosing `sandboxed` scope's own name, without
 * which two lanes of one run asking the same gate name would share one question (ticket 35), and the
 * asking is the engine's own attempt counter, which is why the reviewed loop can be answered twice
 * without the answerer keeping any state.
 */
const answered = (
  lane: ReturnType<typeof laneFor>,
  config: LaneConfig,
  runId: RunId,
  asking: number,
  choice: string,
  reason: string,
  startedAt: number,
) =>
  Effect.gen(function* () {
    const was = executionsSoFar(config, runId);
    const token = DurableDeferred.tokenFromExecutionId(
      DurableDeferred.make(`gate/lane/review/${asking}`, { success: Verdict }),
      { workflow: lane.definition, executionId: runId },
    );

    yield* answerGate({ token, choice, reason, answerer: "kevin" });
    const reached = yield* waitFor(lane, config, runId, was);
    return reported(runId, reached, startedAt, yield* failureOf(lane, runId));
  });

const startedAt = Date.now();
const [command, configPath, ...rest] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath ?? "", "utf8")) as LaneConfig;
const lane = laneFor(config);

const program =
  command === "start"
    ? started(lane, config, rest[0] ?? "one", startedAt)
    : command === "answer"
      ? answered(
          lane,
          config,
          (rest[0] ?? "") as RunId,
          Number(rest[1] ?? "1"),
          rest[2] ?? "approve",
          rest[3] ?? "no reason given",
          startedAt,
        )
      : Effect.die(`unknown command: ${command}`);

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layersFor(config, lane))));

if (Exit.isSuccess(exit)) {
  console.log(JSON.stringify(exit.value));
} else {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
