// `@effect/platform-bun` is imported by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, type PlatformError } from "effect";
import { DurableDeferred } from "effect/unstable/workflow";
import * as SqliteGateRepository from "../../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import { GateRequest } from "../../../src/contexts/gate/models/GateRequest.ts";
import { GateRepository } from "../../../src/contexts/gate/ports/GateRepository.ts";
import * as SqliteDatabase from "../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import { linkEngine } from "../../support/linkEngine.ts";

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;
const packageRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The code an ordinary failure exits with.
 *
 * A number rather than `not.toBe(0)`, because the two failing codes in this build are a pair: `1` is
 * the run itself ending badly, and `75` is a watch that gave up on a run that is still fine. An
 * assertion that could not tell them apart would pass on either.
 */
const failed = 1;

/**
 * The Bun that is running this test, which is what the child must also be.
 *
 * The CLI reaches `bun:sqlite` through the engine's SQL client, so a child spawned on Node dies at
 * import with `ERR_UNSUPPORTED_ESM_URL_SCHEME` — inside a spawn whose failure this file would report
 * as "kojo exited 1", which reads like a defect in the CLI rather than in how the suite was
 * launched. The moon task runs Vitest through `bun` so that `process.execPath` is Bun; this asserts
 * that rather than assuming it.
 */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One whole `kojo` process, start to exit.
 *
 * A real process every time, because the process **exiting** is the assertion. A second layer built
 * in the same process would prove nothing about what the file holds.
 */
const kojo = (args: ReadonlyArray<string>, cwd?: string): Effect.Effect<Ran> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], { cwd, encoding: "utf8" });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

/** Exit code and all, so a failing child reports what it said rather than "exited 1". */
const succeeded = (ran: Ran): string => {
  if (ran.status !== 0) {
    throw new Error(`kojo exited ${ran.status}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  }
  return ran.stdout;
};

/** `run <id>` is the first line of `kojo run`, and the id is what everything else is about. */
const runIdOf = (stdout: string): string => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("run "));
  return (line ?? "").slice("run ".length).trim();
};

/** The token, read out of the gate list exactly as a person reads it. */
const tokenOf = (listing: string, runId: string): string => {
  const row = listing.split("\n").find((candidate) => candidate.includes(runId));
  const cells = (row ?? "").trim().split(/\s+/);
  return cells[cells.length - 1] ?? "";
};

/** The listing's data rows, header dropped. */
const rowsOf = (listing: string): ReadonlyArray<string> =>
  listing
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !line.startsWith("STATE"));

const onOwnFile = <A, E>(
  use: (database: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-cli-" });
    return yield* use(`${root}/kojo.db`);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Writes an asking straight into the file, so a listing can be asked about a stale one. */
const writeAsking = (database: string, request: GateRequest) =>
  Effect.flatMap(GateRepository, (repository) => repository.asked(request)).pipe(
    Effect.provide(
      SqliteGateRepository.layer.pipe(Layer.provide(SqliteDatabase.layer({ path: database }))),
    ),
    Effect.orDie,
  );

describe("answering a gate from another process", () => {
  it.live("resumes the run where it stopped, and re-runs nothing", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        // One: the run starts, reaches the gate, and this process **exits**. A suspended run is a
        // success — the exit code says so — and nothing is held open while a human thinks.
        const started = succeeded(
          yield* kojo(["run", "demo-review", "the change", "--database", database]),
        );
        const runId = runIdOf(started);

        expect(runId).not.toBe("");
        expect(started).toContain('suspended at gate "approve"');
        expect(started).toContain("waiting on engineer");
        expect(started).toContain("draft");
        expect(started).not.toContain("land ");

        // Two: a different process, with nothing but the file, finds the question.
        const listing = succeeded(yield* kojo(["gate", "list", "--database", database]));
        expect(rowsOf(listing)).toHaveLength(1);
        expect(listing).toContain("waiting");
        expect(listing).toContain(runId);
        expect(listing).toContain("engineer");
        expect(listing).toContain("in 1d 23h");

        // Three: a third process answers, holding nothing but the token, and the run continues.
        const token = tokenOf(listing, runId);
        const answered = succeeded(
          yield* kojo([
            "gate",
            "answer",
            token,
            "--choice",
            "approve",
            "--reason",
            "ships",
            "--as",
            "kevin",
            "--database",
            database,
          ]),
        );

        expect(answered).toContain(`recorded approve on run ${runId}`);
        expect(answered).toContain("run succeeded");

        // **Nothing re-ran.** The trace this process printed holds the phases *it* executed, and the
        // phase before the gate is not among them: its recorded activity result came back instead of
        // its body. A `draft` line here would mean the work was done twice.
        expect(answered).toContain("land");
        expect(answered).not.toContain("draft");

        // The same property, measured against the real adapter rather than an in-memory trace: the
        // asking is written from inside the request activity, and the body ran twice. One row.
        const after = succeeded(yield* kojo(["gate", "list", "--all", "--database", database]));
        expect(rowsOf(after)).toHaveLength(1);
        expect(after).toContain("recorded");
        expect(after).toContain("approve by kevin");

        // And nothing waits on anybody any more.
        const waiting = succeeded(yield* kojo(["gate", "list", "--database", database]));
        expect(waiting).toContain("no gate waits on anybody");
      }),
    ),
  );

  /**
   * **Answering is the moment a human hands the run back to the machine, and it must say what the
   * machine then did.**
   *
   * `kojo run` learned this and `kojo gate answer` did not, so a run that a verdict ended printed
   * `run failed` on stdout, with no reason, and exited **0**. Every assertion below is on the half
   * that stdout cannot show: the exit code, and the typed error on stderr.
   */
  it.live("exits non-zero and names the error when the answer ends the run", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const started = succeeded(
          yield* kojo(["run", "demo-review", "risky", "--database", database]),
        );
        const runId = runIdOf(started);
        const listing = succeeded(yield* kojo(["gate", "list", "--database", database]));

        const answered = yield* kojo([
          "gate",
          "answer",
          tokenOf(listing, runId),
          "--choice",
          "reject",
          "--reason",
          "not yet",
          "--database",
          database,
        ]);

        // **The assertion the old behaviour could not pass.** It printed the words below and exited
        // 0; a test that read only stdout stayed green through the whole defect.
        expect(answered.status).toBe(failed);

        // A rejection is a verdict, not a fault — but it does end the branch that assumed approval,
        // so the run is failed rather than succeeded, and it says so without a stack trace.
        expect(answered.stdout).toContain("recorded reject");
        expect(answered.stdout).toContain("run failed");

        // The reason is `demo-review`'s own declared error, with the fields it carries: which gate,
        // who was asked, and the words they wrote. "the run failed" is what this replaces.
        expect(answered.stderr).toContain("GateRejected");
        expect(answered.stderr).toContain("gate: approve");
        expect(answered.stderr).toContain("actor: engineer");
        expect(answered.stderr).toContain("reason: not yet");

        // stderr for the reason, stdout for the table, so a script can separate them.
        expect(answered.stdout).not.toContain("GateRejected");
      }),
    ),
  );

  it.live("exits 0 when the answer carries the run through to success", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const started = succeeded(
          yield* kojo(["run", "demo-review", "welcome", "--database", database]),
        );
        const runId = runIdOf(started);
        const listing = succeeded(yield* kojo(["gate", "list", "--database", database]));

        const answered = yield* kojo([
          "gate",
          "answer",
          tokenOf(listing, runId),
          "--choice",
          "approve",
          "--reason",
          "ships",
          "--database",
          database,
        ]);

        expect(answered.status).toBe(0);
        expect(answered.stdout).toContain("run succeeded");
        // Nothing was reported as a reason, because there was nothing to report.
        expect(answered.stderr).not.toContain(`run ${runId} failed`);
      }),
    ),
  );

  it.live("keeps the first answer when a second one arrives", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const started = succeeded(
          yield* kojo(["run", "demo-review", "twice", "--database", database]),
        );
        const listing = succeeded(yield* kojo(["gate", "list", "--database", database]));
        const token = tokenOf(listing, runIdOf(started));

        yield* kojo([
          "gate",
          "answer",
          token,
          "--choice",
          "approve",
          "--as",
          "kevin",
          "--database",
          database,
        ]).pipe(Effect.map(succeeded));

        const second = succeeded(
          yield* kojo([
            "gate",
            "answer",
            token,
            "--choice",
            "reject",
            "--as",
            "dana",
            "--database",
            database,
          ]),
        );

        // The engine refuses to overwrite a recorded result, so the second answer changed nothing.
        // Saying "recorded" here would be the one failure that destroys trust in a control surface.
        expect(second).toContain("already answered: approve by kevin");
        const after = succeeded(yield* kojo(["gate", "list", "--all", "--database", database]));
        expect(after).toContain("approve by kevin");
        expect(after).not.toContain("dana");
      }),
    ),
  );

  /**
   * Every command that writes readies the file first; the one that only looks does not.
   *
   * The mark beside the database is written by `SqliteDatabase.firstRun` and by nothing else, so it
   * is the witness that a command took the first-run lock, built every schema alone, and only then
   * opened the file — the guard that keeps two cold starts out of the same window. It is deleted
   * between commands on purpose: found again afterwards, it was written by *that* command rather
   * than left over from the one before.
   *
   * `kojo gate list` is asserted the other way round. Looking must never be an act of execution
   * (adr/gate/0001), so it does not ready anything — which is also the honest edge of this fix, and
   * is written down here rather than left to be discovered.
   */
  it.live("readies the file from run and from answer, and never from a listing", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const mark = SqliteDatabase.readyMarkOf(database);

        const started = succeeded(
          yield* kojo(["run", "demo-review", "the change", "--database", database]),
        );
        expect(existsSync(mark)).toBe(true);

        rmSync(mark);
        const listing = succeeded(yield* kojo(["gate", "list", "--database", database]));
        expect(existsSync(mark)).toBe(false);

        succeeded(
          yield* kojo([
            "gate",
            "answer",
            tokenOf(listing, runIdOf(started)),
            "--choice",
            "approve",
            "--reason",
            "ships",
            "--database",
            database,
          ]),
        );
        expect(existsSync(mark)).toBe(true);
      }),
    ),
  );

  it.live("refuses a token this build has no workflow for, and exits non-zero", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        // A token for a workflow that is not registered here would record a real verdict and leave
        // the run exactly where it was: recorded, never applied. It is refused instead.
        const foreign = new DurableDeferred.TokenParsed({
          workflowName: "not-a-workflow",
          executionId: "run-x",
          deferredName: "gate/approve/1",
        }).asToken;

        const ran = yield* kojo([
          "gate",
          "answer",
          foreign,
          "--choice",
          "approve",
          "--database",
          database,
        ]);

        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain("not-a-workflow");
      }),
    ),
  );
});

describe("the gate list", () => {
  it.live("puts a run past its deadline at the top rather than burying it", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const asking = (options: {
          readonly gate: string;
          readonly requestedAt: number;
          readonly deadlineAt: number;
        }) =>
          new GateRequest({
            runId: `run-${options.gate}` as RunId,
            gate: options.gate,
            asking: `gate/${options.gate}/1`,
            description: "does this land?",
            actor: "engineer",
            choices: ["approve", "reject"],
            token: `token-${options.gate}` as DurableDeferred.Token,
            requestedAt: options.requestedAt,
            deadlineAt: options.deadlineAt,
            onExpiry: "fail",
          });

        const now = Date.now();
        const hour = 3_600_000;
        yield* writeAsking(
          database,
          asking({ gate: "fresh", requestedAt: now - hour, deadlineAt: now + 40 * hour }),
        );
        yield* writeAsking(
          database,
          asking({ gate: "stale", requestedAt: now - 80 * hour, deadlineAt: now - 6 * hour }),
        );

        const listing = succeeded(yield* kojo(["gate", "list", "--database", database]));
        const rows = rowsOf(listing);

        // A run nobody answered in time is the one nobody looked at. Ordered by when each question
        // was asked, it sits under everything asked since — which is the opposite of what a latency
        // list is for.
        expect(rows[0]).toContain("overdue");
        expect(rows[0]).toContain("OVERDUE by 6h");
        expect(rows[1]).toContain("waiting");
      }),
    ),
  );
});

/**
 * A workflow with **two** gates in it, written for this file, because no demo has two.
 *
 * The claim it exists to grade is the one an over-reaching fix breaks: a run that is answered at one
 * gate and comes to rest at the next has *succeeded at suspending*, and the command that answered it
 * must exit `0`. Every other workflow this build ships either ends or fails on the far side of its
 * only gate, so nothing else can tell a resume that suspended from a resume that went wrong.
 *
 * No template literals in it, deliberately: the strings below are the TypeScript this test *writes*,
 * and a `${…}` here would interpolate this file's variables into a workflow that has its own.
 */
const twoGatesWorkflow = [
  'import { Duration, Effect, Schema } from "effect";',
  'import { GateRejected } from "@carere/kojo/contexts/gate/models/GateRejected";',
  'import * as OnExpiry from "@carere/kojo/contexts/gate/models/OnExpiry";',
  'import { code } from "@carere/kojo/contexts/workflow/services/phase/code";',
  'import { gate } from "@carere/kojo/contexts/workflow/services/phase/gate";',
  'import { workflow } from "@carere/kojo/contexts/workflow/services/workflow";',
  "",
  "export const twoGates = workflow(",
  "  {",
  '    name: "two-gates",',
  "    payload: { form: Schema.String },",
  "    success: Schema.String,",
  "    error: GateRejected,",
  '    idempotencyKey: (payload) => "two-gates/" + payload.form,',
  "  },",
  "  (payload) =>",
  "    Effect.gen(function* () {",
  "      const signed = yield* gate({",
  '        name: "sign-off",',
  '        description: "Sign " + payload.form + "?",',
  '        actor: "clerk",',
  '        choices: ["approve", "reject"],',
  "        deadline: Duration.days(2),",
  "        onExpiry: OnExpiry.fail(),",
  "      });",
  '      if (signed.choice !== "approve") {',
  '        return yield* new GateRejected({ gate: "sign-off", actor: "clerk", reason: signed.reason });',
  "      }",
  "      const countersigned = yield* gate({",
  '        name: "counter-sign",',
  '        description: "Counter-sign " + payload.form + "?",',
  '        actor: "registrar",',
  '        choices: ["approve", "reject"],',
  "        deadline: Duration.days(2),",
  "        onExpiry: OnExpiry.fail(),",
  "      });",
  '      if (countersigned.choice !== "approve") {',
  '        return yield* new GateRejected({ gate: "counter-sign", actor: "registrar", reason: countersigned.reason });',
  "      }",
  "      return yield* code(",
  "        {",
  '          name: "file-it",',
  '          description: "File what both of them signed",',
  "          success: Schema.String,",
  "          error: Schema.Never,",
  "        },",
  '        Effect.succeed(payload.form + " filed"),',
  "      );",
  "    }),",
  ");",
  "",
].join("\n");

/**
 * A repository whose factory holds that workflow, and nothing else.
 *
 * No git and no `kojo init`: the workflow enters no sandbox, so it cuts no branch and needs no
 * commit to fork from. What it does need is `node_modules/kojo` pointing at the package under test,
 * because that is what makes its `kojo/...` imports resolve to the engine this test is grading —
 * the same link a real target repository gets from `bun install`.
 */
const inTwoGateFactory = <A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-two-gates-" });

    const workflows = path.join(root, ".kojo", "workflows");
    yield* fileSystem.makeDirectory(workflows, { recursive: true });
    yield* fileSystem.writeFileString(path.join(workflows, "two-gates.ts"), twoGatesWorkflow);

    yield* fileSystem.makeDirectory(path.join(root, "node_modules"), { recursive: true });
    yield* Effect.sync(() => linkEngine({ root, packageRoot }));

    return yield* use(root);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("an answer that carries the run to its next gate", () => {
  /**
   * **A resume that suspends again is a success, and the exit code has to say so.**
   *
   * This is the assertion that keeps ticket 41 from over-reaching. The whole design exists so a
   * person can close the terminal at a gate and answer days later; a factory whose workflow asks two
   * people would report its own normal path as a fault at the first of them, and every script built
   * on Kojo would learn to treat a waiting gate as a failure.
   */
  it.live("suspends at the second gate and exits 0", () =>
    inTwoGateFactory((root) =>
      Effect.gen(function* () {
        // No `--database`: the default is this repository's own `.kojo/kojo.db`, which is what a
        // person standing in their factory types.
        const started = succeeded(yield* kojo(["run", "two-gates", "form 12"], root));
        const runId = runIdOf(started);

        expect(started).toContain('suspended at gate "sign-off"');

        const listing = succeeded(yield* kojo(["gate", "list"], root));
        const answered = yield* kojo(
          ["gate", "answer", tokenOf(listing, runId), "--choice", "approve", "--as", "kevin"],
          root,
        );

        expect(answered.status).toBe(0);
        expect(answered.status).not.toBe(failed);
        expect(answered.stdout).toContain(`recorded approve on run ${runId}`);

        // The *second* gate, which is how this is known to be a fresh suspension rather than the
        // answered one read back: `counter-sign` waits on somebody the first one never named.
        expect(answered.stdout).toContain('suspended at gate "counter-sign"');
        expect(answered.stdout).toContain("waiting on registrar");
        // A suspension is not a reason, so nothing was written where reasons go.
        expect(answered.stderr).not.toContain(`run ${runId} failed`);

        // And the run really is waiting on the second question, from a process that resumed nothing.
        const waiting = succeeded(yield* kojo(["gate", "list"], root));
        expect(waiting).toContain("registrar");
      }),
    ),
  );
});
