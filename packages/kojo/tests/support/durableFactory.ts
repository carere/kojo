#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from "effect";
import { DurableDeferred, type WorkflowEngine } from "effect/unstable/workflow";
import { AgentInvocationError } from "../../src/contexts/agent/models/AgentInvocationError.ts";
import * as SqliteGateRepository from "../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import * as TerminalGate from "../../src/contexts/gate/adapters/TerminalGate.ts";
import { GateExpired } from "../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../src/contexts/gate/models/Verdict.ts";
import { answerGate } from "../../src/contexts/gate/services/answerGate.ts";
import * as BindMountWorkspace from "../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { noSandbox } from "../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import { SandboxError } from "../../src/contexts/sandbox/models/SandboxError.ts";
import { WorkspaceError } from "../../src/contexts/sandbox/models/WorkspaceError.ts";
import { WorkspaceUnreachable } from "../../src/contexts/sandbox/models/WorkspaceUnreachable.ts";
import { WorktreeUnusable } from "../../src/contexts/sandbox/models/WorktreeUnusable.ts";
import { Workspace } from "../../src/contexts/sandbox/ports/Workspace.ts";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";
import { runBranch } from "../../src/contexts/shared/models/RunBranch.ts";
import type { RunId } from "../../src/contexts/shared/models/RunId.ts";
import * as FileRunLock from "../../src/contexts/workflow/adapters/FileRunLock.ts";
import * as SingleNodeEngine from "../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import { diffMatchesClaims } from "../../src/contexts/workflow/guards/checks/diffMatchesClaims.ts";
import { Acceptance, Judgement } from "../../src/contexts/workflow/models/Acceptance.ts";
import { CheckViolation } from "../../src/contexts/workflow/models/CheckViolation.ts";
import { CommitRefused } from "../../src/contexts/workflow/models/CommitRefused.ts";
import { EnvelopeBase } from "../../src/contexts/workflow/models/Envelope.ts";
import { EnvelopeParseError } from "../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { MergeRefused } from "../../src/contexts/workflow/models/MergeRefused.ts";
import { NotAccepted } from "../../src/contexts/workflow/models/NotAccepted.ts";
import type { RunLocked } from "../../src/contexts/workflow/models/RunLocked.ts";
import type { RunLock } from "../../src/contexts/workflow/ports/RunLock.ts";
import { fromVerdict } from "../../src/contexts/workflow/services/acceptance.ts";
import { CurrentRun } from "../../src/contexts/workflow/services/CurrentRun.ts";
import { oneRunner } from "../../src/contexts/workflow/services/oneRunner.ts";
import { agent } from "../../src/contexts/workflow/services/phase/agent.ts";
import { code } from "../../src/contexts/workflow/services/phase/code.ts";
import { commit } from "../../src/contexts/workflow/services/phase/commit.ts";
import { gate } from "../../src/contexts/workflow/services/phase/gate.ts";
import { merge } from "../../src/contexts/workflow/services/phase/merge.ts";
import { type RunStatus, start, status } from "../../src/contexts/workflow/services/run.ts";
import { sandboxed } from "../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../src/contexts/workflow/services/workflow.ts";
import * as InSandboxAgentInvoker from "./InSandboxAgentInvoker.ts";
import * as JsonlTracer from "./JsonlTracer.ts";

/**
 * **One whole factory, driven from a command line — ticket 20's subject.**
 *
 * A run on its own branch: an agent proposes a change and a commit message, a *code* phase performs
 * the commit, a code phase runs the suite, a human answers a gate, and the merge happens only if
 * the mechanical verdict and the human one both say yes. Everything is real — a real repository,
 * real worktrees, the durable engine on a SQLite file, a trace that outlives the process — because
 * the claims this ticket makes are about git and about processes, and neither can be faked.
 *
 * Three commands, because three of the claims are about what a *second process* sees:
 *
 * - `start`   — claim the run, start it, report where it stopped.
 * - `answer`  — claim the run, answer its gate, ride the resume, report how it ended.
 * - `hold`    — claim the run and keep it, so another process can be refused.
 */

/** What the harness is pointed at. One JSON file, because argv is not a config format. */
interface FactoryConfig {
  readonly database: string;
  readonly trace: string;
  readonly sessions: string;
  /** Where run claims are written. A run's data directory on the host, never a worktree. */
  readonly claims: string;
  /** The host repository the worktree is cut from, and the tree the merge lands in. */
  readonly repo: string;
  /** What an accepted run merges into. The factory's trunk. */
  readonly trunk: string;
}

/** What an agent hands back: what it changed, and what it thinks the commit should say. */
class Proposal extends EnvelopeBase.extend<Proposal>("Proposal")({
  _tag: Schema.tag("Proposal"),
  changedFiles: Schema.Array(Schema.String),
  /** **The whole of D6 in one field.** The agent proposes it; the commit phase performs it. */
  commitMessage: Schema.String,
}) {}

/** What the suite reported. A code phase that ran a red suite succeeded — it did its job. */
class SuiteResult extends Schema.Class<SuiteResult>("SuiteResult")({
  passed: Schema.Boolean,
  summary: Schema.String,
}) {}

/**
 * The agent: a process in the sandbox that writes a file and proposes a message for it.
 *
 * It writes exactly the path it claims, so `diffMatchesClaims` holds — and the claim is graded
 * against the repository rather than believed, which is the proposing half of D6.
 */
const script = [
  `mkdir -p notes`,
  `printf '%s\\n' "$KOJO_PROMPT" > notes/work.md`,
  // **The first line of the prompt, not the whole of it.** Since ticket 15 the agent phase appends
  // the envelope's own JSON Schema to every cold prompt, so `$KOJO_PROMPT` is the task followed by
  // a page of JSON. Splicing that into a JSON string unescaped produces something that is not JSON,
  // and this fake would then fail to decode for a reason that has nothing to do with what it is
  // testing. The task is the first line, and that is what a commit message is made of anyway.
  `printf '{"_tag":"Proposal","changedFiles":["notes/work.md"],"commitMessage":"feat: %s"}' "$(printf '%s' "$KOJO_PROMPT" | head -n 1)"`,
].join(" && ");

const failures = Schema.Union([
  NotAccepted,
  MergeRefused,
  CommitRefused,
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

/** The identity a bare worktree does not have, and a container never has. */
const author = { name: "Kojo", email: "kojo@example.invalid" } as const;

const factoryFor = (config: FactoryConfig) =>
  workflow(
    {
      name: "factory",
      payload: { subject: Schema.String, suite: Schema.String },
      success: Schema.String,
      error: failures,
      idempotencyKey: (payload) => `factory/${payload.subject}`,
    },
    (payload) =>
      Effect.gen(function* () {
        const run = yield* CurrentRun;
        // The run names its own branch. Nothing tells it what to call it, so a resumed run in
        // another process two days later derives the same name from the same run id.
        const branch = runBranch(run.runId);

        const built = yield* sandboxed(
          {
            name: "factory",
            branch,
            baseBranch: config.trunk,
            provider: noSandbox(),
            cwd: config.repo,
          },
          Effect.gen(function* () {
            const proposal = yield* agent({
              name: "build",
              description: "Do the work, and say what the commit should say",
              agent: "builder",
              prompt: payload.subject,
              envelope: Proposal,
              // Code disposes twice over: the commit below, and this, which goes and looks at the
              // repository rather than taking the agent's word for what it changed.
              checks: [
                diffMatchesClaims<Proposal>({
                  claim: "changedFiles",
                  files: (claims) => claims.changedFiles,
                }),
              ],
            });

            const written = yield* commit({
              description: "Commit what the agent proposed, on the branch this run owns",
              message: proposal.commitMessage,
              author,
            });

            const suite = yield* code(
              {
                name: "test",
                description: "Run the suite",
                success: SuiteResult,
                error: WorkspaceError,
              },
              Effect.gen(function* () {
                const workspace = yield* Workspace;
                const result = yield* workspace.exec([
                  "sh",
                  "-c",
                  payload.suite === "red" ? "echo 1 failing; exit 1" : "echo 2 passing",
                ]);
                // The phase succeeds either way. Whether the suite was green is a *measurement*,
                // and it is one half of the acceptance rather than the phase's own outcome.
                return new SuiteResult({
                  passed: result.succeeded,
                  summary: result.stdout.trim(),
                });
              }),
            );

            return { written, suite };
          }).pipe(
            Effect.provide(
              InSandboxAgentInvoker.layer({
                sessions: config.sessions,
                scripts: { builder: script },
              }),
            ),
          ),
        );

        // The one place judgement happens. Everything after it is consequence.
        const verdict = yield* gate({
          name: "review",
          description: `Land ${branch}? ${built.written.message}`,
          actor: "engineer",
          choices: ["approve", "reject"],
          deadline: Duration.days(7),
          onExpiry: OnExpiry.fail(),
          asking: 1,
        });

        const acceptance = new Acceptance({
          mechanical: new Judgement({
            by: "the suite",
            accepted: built.suite.passed,
            reason: built.suite.summary,
          }),
          human: fromVerdict(verdict),
        });

        // Outside the sandbox scope, on the host workspace: the branch is checked out in the
        // worktree, so a merge inside the scope would be a branch into itself.
        const landed = yield* merge({ into: config.trunk, acceptance });

        return `${landed.sha}|${built.written.sha}`;
      }),
  );

/**
 * One client under the engine's storage and everything else, and the host workspace beside them.
 *
 * `BindMountWorkspace` on the repository itself is what the merge phase acts through. Inside
 * `sandboxed` it is shadowed by the sandbox's own workspace, which is the boundary drawn in one
 * layer stack: setup and merge on the host, the risky part in the worktree.
 */
const layersFor = (config: FactoryConfig, factory: ReturnType<typeof factoryFor>) =>
  factory.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        JsonlTracer.layer(config.trace),
        SandcastleSandboxSource.layer.pipe(Layer.provide(BunServices.layer)),
        BindMountWorkspace.layer({ root: config.repo }).pipe(Layer.provide(BunServices.layer)),
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

/** What one process of the harness reports on its last line of stdout. */
interface Reported {
  readonly runId: string;
  readonly status: RunStatus | "refused" | "held";
  /** Why a failed run failed, read back out of the engine's recorded exit. */
  readonly failure: string | undefined;
  /** Who is driving this run, on a process that was refused — or on the one holding it. */
  readonly holder: string | undefined;
}

/**
 * Every command, one type.
 *
 * Written down rather than inferred because the three branches otherwise infer three different
 * requirement sets, and a union of `Effect`s has no `pipe` that the refusal handler below can use.
 */
type Command = Effect.Effect<Reported, RunLocked, RunLock | WorkflowEngine.WorkflowEngine>;

/**
 * Waits for **this** execution of the body to stop, then reports where it stopped.
 *
 * The same reasoning as ticket 19's lane harness: `poll` reads `suspended` on both sides of a
 * resume, so the trace's execution list — one entry per execution of the body — is the only signal
 * that says *the process you just started has got as far as it is going to get*.
 */
const waitFor = (
  factory: ReturnType<typeof factoryFor>,
  config: FactoryConfig,
  runId: RunId,
  was: number,
) =>
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

    return yield* Effect.repeat(status(factory.definition, runId), {
      schedule: Schedule.spaced(Duration.millis(100)),
      until: (reported: RunStatus) => reported === expected,
      times: 1800,
    });
  });

/** Why a failed run failed, read back out of the engine's recorded exit. */
const failureOf = (factory: ReturnType<typeof factoryFor>, runId: RunId) =>
  Effect.map(factory.definition.poll(runId), (polled) =>
    Option.match(polled, {
      onNone: () => undefined,
      onSome: (result) => {
        if (result._tag !== "Complete") return undefined;
        const exit = result.exit;
        if (!Exit.isFailure(exit)) return undefined;
        return Option.match(Cause.findErrorOption(exit.cause), {
          onNone: () => Cause.pretty(exit.cause).split("\n").slice(0, 3).join(" / "),
          onSome: (error) => JSON.stringify(error),
        });
      },
    }),
  );

const startedAt = Date.now();
const [command, configPath, ...rest] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath ?? "", "utf8")) as FactoryConfig;
const factory = factoryFor(config);

/** What this process calls itself, and what a refused process reports about it. */
const holder = `${command}-${process.pid}`;

const runIdFor = (subject: string) =>
  Effect.map(
    factory.definition.executionId({ subject, suite: "green" }),
    (executionId) => executionId as RunId,
  );

const started = (subject: string, suite: string): Command =>
  Effect.gen(function* () {
    const runId = yield* runIdFor(subject);

    return yield* oneRunner(
      runId,
      Effect.gen(function* () {
        const executed = yield* start(factory.definition, { subject, suite });
        const reached = yield* waitFor(factory, config, executed, 0);
        return {
          runId: executed,
          status: reached,
          failure: yield* failureOf(factory, executed),
          holder,
        } satisfies Reported;
      }),
    );
  });

const answered = (runId: RunId, choice: string, reason: string): Command =>
  oneRunner(
    runId,
    Effect.gen(function* () {
      const was = JsonlTracer.executionsOf(config.trace, runId).length;
      const token = DurableDeferred.tokenFromExecutionId(
        DurableDeferred.make("gate/review/1", { success: Verdict }),
        { workflow: factory.definition, executionId: runId },
      );

      yield* answerGate({ token, choice, reason, answerer: "kevin" });
      const reached = yield* waitFor(factory, config, runId, was);
      return {
        runId,
        status: reached,
        failure: yield* failureOf(factory, runId),
        holder,
      } satisfies Reported;
    }),
  );

/**
 * Holds the claim and keeps it, from a process that does nothing else.
 *
 * The marker file is the handshake, and it carries this process's holder name so the test can check
 * that the refusal names the runner that is really there. Written *after* the claim is taken, so a
 * test that sees the marker knows the claim is held rather than merely asked for.
 */
const held = (subject: string, marker: string, millis: number): Command =>
  Effect.gen(function* () {
    const runId = yield* runIdFor(subject);
    return yield* oneRunner(
      runId,
      Effect.gen(function* () {
        yield* Effect.sync(() => writeFileSync(marker, holder));
        yield* Effect.sleep(Duration.millis(millis));
        return { runId, status: "held", failure: undefined, holder } satisfies Reported;
      }),
    );
  });

const program =
  command === "start"
    ? started(rest[0] ?? "one", rest[1] ?? "green")
    : command === "answer"
      ? answered((rest[0] ?? "") as RunId, rest[1] ?? "approve", rest[2] ?? "no reason given")
      : command === "hold"
        ? held(rest[0] ?? "one", rest[1] ?? "", Number(rest[2] ?? "1000"))
        : Effect.die(`unknown command: ${command}`);

const exit = await Effect.runPromiseExit(
  program.pipe(
    // The refusal is an ordinary outcome of the harness, not a crash: the whole point is that the
    // second process is told no and stops, so it reports that and exits 0.
    Effect.catchTag("RunLocked", (locked: RunLocked) =>
      Effect.succeed({
        runId: locked.runId,
        status: "refused",
        failure: undefined,
        holder: locked.holder,
      } satisfies Reported),
    ),
    Effect.provide(
      layersFor(config, factory).pipe(
        Layer.provideMerge(
          FileRunLock.layer({ directory: config.claims, holder }).pipe(
            Layer.provide(BunServices.layer),
          ),
        ),
      ),
    ),
  ),
);

if (Exit.isSuccess(exit)) {
  console.log(JSON.stringify({ ...exit.value, processMillis: Date.now() - startedAt }));
} else {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
