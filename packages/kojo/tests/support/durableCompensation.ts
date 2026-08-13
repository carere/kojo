#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from "effect";
import { DurableDeferred, type WorkflowEngine } from "effect/unstable/workflow";
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
import * as SingleNodeEngine from "../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import { Acceptance, Judgement } from "../../src/contexts/workflow/models/Acceptance.ts";
import { CommitRefused } from "../../src/contexts/workflow/models/CommitRefused.ts";
import { MergeRefused } from "../../src/contexts/workflow/models/MergeRefused.ts";
import { NotAccepted } from "../../src/contexts/workflow/models/NotAccepted.ts";
import { fromVerdict } from "../../src/contexts/workflow/services/acceptance.ts";
import { CurrentRun } from "../../src/contexts/workflow/services/CurrentRun.ts";
import { onRunEnd } from "../../src/contexts/workflow/services/compensation.ts";
import { code } from "../../src/contexts/workflow/services/phase/code.ts";
import { commit } from "../../src/contexts/workflow/services/phase/commit.ts";
import { gate } from "../../src/contexts/workflow/services/phase/gate.ts";
import { merge } from "../../src/contexts/workflow/services/phase/merge.ts";
import { type RunStatus, start, status } from "../../src/contexts/workflow/services/run.ts";
import { sandboxed } from "../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../src/contexts/workflow/services/workflow.ts";
import * as JsonlTracer from "./JsonlTracer.ts";

/**
 * **One whole factory that puts the world back when it fails — ticket 21's subject.**
 *
 * Ticket 20's harness proved the accepted path on a real repository. This one is its inverse, and it
 * is a separate program for a reason a single process cannot supply: the run is started by one
 * process, which then **exits while the run is suspended**, and finished by another. Everything the
 * compensation is claimed to do — fire once, fire only on failure, fire in whichever process ends the
 * run — is a claim about that boundary.
 *
 * The tracker is a JSON file, and it is deliberately not a Kojo port: reading a ticket and moving its
 * status is a code phase written against somebody's own tracker, which is exactly what this is.
 *
 * Two commands, one per process the test needs:
 *
 * - `start`  — start the run and report where it stopped.
 * - `answer` — answer its gate, ride the resume, report how it ended.
 *
 * The tracker and the log are plain files, so the test reads them itself rather than asking a third
 * command what they say.
 */

interface CompensationConfig {
  readonly database: string;
  readonly trace: string;
  /** The ticket this run is for: one JSON file, holding a status and the comments posted to it. */
  readonly tracker: string;
  /** One line per undo and per run-end, each stamped with the process that wrote it. */
  readonly log: string;
  /** The host repository the worktree is cut from, and the tree the merge lands in. */
  readonly repo: string;
  readonly trunk: string;
}

/** The ticket, as it sits on disk between processes. */
interface Ticket {
  readonly status: string;
  readonly comments: ReadonlyArray<string>;
}

const readTicket = (path: string): Ticket => JSON.parse(readFileSync(path, "utf8")) as Ticket;

const writeTicket = (path: string, ticket: Ticket): void =>
  writeFileSync(path, JSON.stringify(ticket));

const note = (path: string, line: string): void => appendFileSync(path, `${line}\n`);

const failures = Schema.Union([
  NotAccepted,
  MergeRefused,
  CommitRefused,
  GateExpired,
  GateUnreachable,
  WorkspaceError,
  SandboxError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

/** The identity a bare worktree does not have. */
const author = { name: "Kojo", email: "kojo@example.invalid" } as const;

const factoryFor = (config: CompensationConfig) =>
  workflow(
    {
      name: "compensated-factory",
      payload: { subject: Schema.String },
      success: Schema.String,
      error: failures,
      idempotencyKey: (payload) => `compensated-factory/${payload.subject}`,
    },
    (payload, compensation) =>
      Effect.gen(function* () {
        const run = yield* CurrentRun;
        const branch = runBranch(run.runId);

        // Run-lifetime cleanup. Registered on every execution of the body; it fires in whichever
        // process ends the run, and in no other.
        yield* onRunEnd((exit) =>
          Effect.sync(() =>
            note(
              config.log,
              `end:${process.pid}:${
                exit._tag === "Success"
                  ? "success"
                  : Cause.hasInterrupts(exit.cause)
                    ? "interrupted"
                    : "failed"
              }`,
            ),
          ),
        );

        // Claim the ticket, and pair the claim with its undo at the point it is written. The phase
        // hands back the status it *found*, so the undo restores the real previous status rather
        // than one anybody assumed.
        const previous = yield* compensation.compensated(
          code(
            {
              name: "claim",
              description: "Move the ticket to In Progress so nobody else picks it up",
              success: Schema.String,
              error: Schema.Never,
            },
            Effect.sync(() => {
              const ticket = readTicket(config.tracker);
              writeTicket(config.tracker, { ...ticket, status: "in progress" });
              return ticket.status;
            }),
          ),
          (was, failure) =>
            Effect.sync(() => {
              const ticket = readTicket(config.tracker);
              writeTicket(config.tracker, {
                status: was,
                comments: [...ticket.comments, failure.report],
              });
              // The tag is reachable because the cause stayed typed — the method form of
              // `withCompensation`, never the module one.
              note(config.log, `undo:${process.pid}:${failure.errorTag ?? "none"}`);
            }),
        );

        const written = yield* sandboxed(
          {
            name: "compensated",
            branch,
            baseBranch: config.trunk,
            provider: noSandbox(),
            cwd: config.repo,
          },
          Effect.gen(function* () {
            yield* code(
              {
                name: "work",
                description: "Do the work this ticket asked for",
                success: Schema.Void,
                error: WorkspaceError,
              },
              Effect.flatMap(Workspace, (workspace) =>
                workspace.write("notes/work.md", `${payload.subject}\n`),
              ),
            );

            return yield* commit({
              description: "Commit the work on the branch this run owns",
              message: `feat: ${payload.subject}`,
              author,
            });
          }),
        );

        const verdict = yield* gate({
          name: "review",
          description: `Land ${branch}? ${written.message}`,
          actor: "engineer",
          choices: ["approve", "reject"],
          deadline: Duration.days(7),
          onExpiry: OnExpiry.fail(),
          asking: 1,
        });

        const landed = yield* merge({
          into: config.trunk,
          acceptance: new Acceptance({
            mechanical: new Judgement({ by: "the suite", accepted: true, reason: "2 passing" }),
            human: fromVerdict(verdict),
          }),
        });

        return `${landed.sha}|${previous}`;
      }),
  );

const layersFor = (config: CompensationConfig, factory: ReturnType<typeof factoryFor>) =>
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

interface Reported {
  readonly runId: string;
  readonly status: RunStatus;
  readonly failure: string | undefined;
}

type Command = Effect.Effect<Reported, never, WorkflowEngine.WorkflowEngine>;

/**
 * Waits for **this** execution of the body to stop, then reports where it stopped.
 *
 * The trace's execution list rather than `poll`, for the reason ticket 19 and ticket 20 both wrote
 * down: `poll` reads `suspended` on both sides of a resume.
 */
const waitFor = (
  factory: ReturnType<typeof factoryFor>,
  config: CompensationConfig,
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

const [command, configPath, ...rest] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath ?? "", "utf8")) as CompensationConfig;
const factory = factoryFor(config);

const started = (subject: string): Command =>
  Effect.gen(function* () {
    const runId = yield* start(factory.definition, { subject });
    const reached = yield* waitFor(factory, config, runId, 0);
    return { runId, status: reached, failure: yield* failureOf(factory, runId) } satisfies Reported;
  });

const answered = (runId: RunId, choice: string, reason: string): Command =>
  Effect.gen(function* () {
    const was = JsonlTracer.executionsOf(config.trace, runId).length;
    const token = DurableDeferred.tokenFromExecutionId(
      DurableDeferred.make("gate/review/1", { success: Verdict }),
      { workflow: factory.definition, executionId: runId },
    );

    yield* answerGate({ token, choice, reason, answerer: "kevin" });
    const reached = yield* waitFor(factory, config, runId, was);
    return { runId, status: reached, failure: yield* failureOf(factory, runId) } satisfies Reported;
  });

const program =
  command === "start"
    ? started(rest[0] ?? "one")
    : command === "answer"
      ? answered((rest[0] ?? "") as RunId, rest[1] ?? "approve", rest[2] ?? "no reason given")
      : Effect.die(`unknown command: ${command}`);

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layersFor(config, factory))));

if (Exit.isSuccess(exit)) {
  console.log(JSON.stringify({ ...exit.value, pid: process.pid }));
} else {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
