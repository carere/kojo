// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${…}` below belongs to the
// TypeScript this file *writes into a target repository*, not to the TypeScript it is. Making these
// template literals would interpolate this test's variables into a workflow that has its own.

// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import * as InMemoryImageBuilder from "../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import { initialise } from "../../../src/contexts/scaffold/services/initialise.ts";
import { thisEngine } from "../../support/engineDependency.ts";

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;
const packageRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The Bun running this test, which is what the child must also be. Same reason as
 * `gateAndResume.test.ts`: the CLI reaches `bun:sqlite`, and a child on Node dies at import.
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
 * A `PATH` with no coding-agent binary on it.
 *
 * **This suite must never spend money.** Since ticket 15 the stamped `review` wires a real
 * `SandcastleAgentInvoker`, so a `kojo run review` here would spawn a real `claude` against a real
 * model — on every CI run, forever, for a test that is about the *loader*. Stripping the binary out
 * of the child's `PATH` is what keeps the assertion (the stamped workflow reached its agent phase
 * and cut its branch) while making the call itself impossible. `/usr/bin:/bin` still carries `git`
 * and `sh`, which the sandbox scope needs.
 *
 * **And a `PATH` alone was never enough.** Twice in this build a child with a `PATH` like this one
 * resolved a real binary anyway, and the reports written afterwards were honest and wrong. Since
 * ticket 49 the guard is the invoker's: this suite's children declare nothing, so they are
 * unattended and refused before a process exists. The `PATH` stays as the second line.
 */
const withoutAnAgent = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * A stand-in that is not there — how this suite asks for the *no binary* fault on purpose.
 *
 * Naming a file that does not exist is the honest way to write "there is nothing to spawn": the
 * invoker resolves `claude` for itself, finds nothing, and refuses. Declaring `allow` here instead
 * would put the whole suite one stray `/usr/bin/claude` away from spending somebody's money on
 * every CI run, which is the trade this switch exists to remove.
 */
const noSuchAgent = "stand-in:/nowhere/kojo-has-no-agent/claude";

/** One whole `kojo` process, launched from inside the target repository, the way a person does. */
const kojo = (
  root: string,
  args: ReadonlyArray<string>,
  options?: { readonly path?: string; readonly spend?: string },
): Effect.Effect<Ran> =>
  Effect.sync(() => {
    // Left unset, the child inherits this worker's environment and declares no spend — so it is
    // unattended and the invoker refuses every agent call. That is the default this suite wants.
    const environment =
      options?.path === undefined && options?.spend === undefined
        ? undefined
        : ({
            ...process.env,
            ...(options?.path === undefined ? {} : { PATH: options.path }),
            ...(options?.spend === undefined ? {} : { KOJO_AGENT_SPEND: options.spend }),
          } as NodeJS.ProcessEnv);
    const finished = spawnSync(bun(), [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      ...(environment === undefined ? {} : { env: environment }),
    });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

const succeeded = (ran: Ran): string => {
  if (ran.status !== 0) {
    throw new Error(`kojo exited ${ran.status}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  }
  return ran.stdout;
};

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

/**
 * A repository with a real factory stamped into it, and nothing copied.
 *
 * Three things it has that a plain temp directory does not, and each of them is load-bearing:
 *
 * - **A git repository with a commit.** The `sandboxed` scope of a stamped workflow cuts a branch,
 *   and a branch needs somewhere to fork from.
 * - **`node_modules/kojo` as a link to the package under test.** That is what `bun install` leaves a
 *   target repository holding, and it is how the stamped file's `kojo/...` imports resolve to the
 *   engine this test is grading rather than to a published copy of it.
 * - **`--sandbox none`.** A real answer, not an opt-out: the scope still cuts the branch and still
 *   hands the phases a workspace, on this machine instead of in a container. What Docker would add
 *   here is isolation, and isolation is not what is under test.
 */
const stamped = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-stamped-run-" })
    .pipe(Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Kojo"]);
    git(root, ["config", "user.email", "kojo@example.invalid"]);
  });

  yield* fileSystem
    .writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({ name: "kojo-target", type: "module" }, undefined, 2),
    )
    .pipe(Effect.orDie);
  yield* fileSystem
    .writeFileString(path.join(root, ".gitignore"), "node_modules\n")
    .pipe(Effect.orDie);

  yield* initialise({
    root,
    agent: "pi",
    model: "claude-sonnet-4-6",
    sandbox: "none",
    template: "review",
    engine: thisEngine(),
    uid: 1000,
    gid: 1000,
    skipImage: true,
  }).pipe(Effect.provide(InMemoryImageBuilder.layer), Effect.orDie);

  // The factory is committed before the links are made, so the branch a run forks from holds the
  // repository and none of its dependencies — which is what a real one looks like.
  yield* Effect.sync(() => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", "stamp a factory"]);
  });

  yield* fileSystem
    .makeDirectory(path.join(root, "node_modules"), { recursive: true })
    .pipe(Effect.orDie);
  yield* Effect.sync(() => {
    const link = (from: string, to: string) => {
      if (!existsSync(to)) symlinkSync(from, to);
    };
    link(packageRoot, path.join(root, "node_modules", "kojo"));
    for (const dependency of ["effect", "@ai-hero", "@effect", "@types"]) {
      link(
        path.join(packageRoot, "node_modules", dependency),
        path.join(root, "node_modules", dependency),
      );
    }
  });

  return root;
});

const inStampedRepository = <A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.flatMap(stamped, use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** The stamped review's own phase table row for the phase no demo can have. */
/**
 * The `draft` row of the phase table.
 *
 * The optional column between the name and the kind is LANE, which the table prints whenever any
 * phase of the run ran inside a sandbox (ticket 35). The stamped `review` does, so this row reads
 * `draft  review  agent  …`; a run with no container has no LANE column at all, and the pattern has
 * to read both.
 */
const agentPhaseRow = (stdout: string): string | undefined =>
  stdout.split("\n").find((line) => /^draft\s+(\S+\s+)?agent\s/.test(line));

describe("kojo run in a repository with a factory in it", () => {
  it.live(
    "runs the workflow from .kojo/workflows/, which the built-in demos cannot impersonate",
    () =>
      inStampedRepository((root) =>
        Effect.gen(function* () {
          // Exactly the command the stamped README teaches, from the repository root, with no flags
          // — the database is `.kojo/kojo.db` by default, and the name is the file name.
          //
          // **It exits non-zero, and that is the correct answer.** The stamped `review` reaches an
          // agent phase, this child is unattended and declares no spend, so the invoker refuses
          // before a process exists and the run fails with it. The phase table below is still the
          // subject of this test; the exit code and the sentence are graded further down.
          const ran = yield* kojo(root, ["run", "review", "the change"], {
            path: withoutAnAgent,
          });
          const started = ran.stdout;

          expect(started).toContain("run ");

          // **The assertion that separates the two `review`s.** The built-in demo is two `code`
          // phases with no sandbox and no agent; it *cannot* produce an `agent` phase, whatever
          // else it does. This row is the stamped workflow's `draft` phase and nothing else's.
          const drafted = agentPhaseRow(started);
          expect(drafted, `no agent phase in:\n${started}`).toBeDefined();
          expect(drafted).toContain("Make the change this run is about");

          // The demo's second phase is `land`, and it is the thing a same-named demo would print
          // here instead. Its absence says the demo did not run in place of the real one.
          expect(started).not.toContain("land");

          // A second record only the stamped workflow leaves: it enters a `sandboxed` scope, which
          // cuts a branch. The demo enters no scope and cuts nothing.
          //
          // **The branch is named after the run, not after the subject.** `runBranch(runId)` is what
          // `commit` and `merge` act on and what a failed run's report names, so a workflow that
          // called its branch anything else would be a workflow whose work those three cannot find.
          const branches = git(root, ["branch", "--list", "--format=%(refname:short)"]);
          expect(branches).toContain(`kojo/${runIdOf(started)}`);
        }),
      ),
  );

  it.live("says what this factory has when asked for help, rather than what Kojo ships", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const help = succeeded(yield* kojo(root, ["run", "--help"]));

        expect(help).toContain("this factory: review");
        expect(help).toContain("demo-hello");
      }),
    ),
  );

  it.live("refuses a name this factory does not have, and names the ones it does", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const ran = yield* kojo(root, ["run", "nowhere"]);

        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain("unknown workflow: nowhere");
        expect(ran.stderr).toContain("this factory: review");
      }),
    ),
  );

  /**
   * **Why the agent never answered, said to the person who started the run.**
   *
   * This is a whole `AgentInvocationError` end to end: raised at the invocation, stored by the
   * engine, read back off the finished run, and rendered field by field. Until the reporting path
   * carried the typed error, the command said `run failed` and exited 0.
   *
   * The cause here is a missing binary rather than a missing provider, because since ticket 15 the
   * stamped factory *has* a provider — see `withoutAnAgent`. The reader is the same person and the
   * three fields send them to the same three places.
   *
   * Since ticket 49 the fault is `refused-to-spend` rather than `provider-failed`, and the change is
   * the point: the invoker resolves `claude` itself, finds the stand-in this child declared is not
   * there, and refuses **before** a process exists. Nothing about the reporting path changed — the
   * whole typed error still travels from the invocation, through the engine, off the finished run
   * and onto stderr field by field, which is what this test is for.
   */
  it.live("says why the agent never answered, and exits non-zero for it", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const ran = yield* kojo(root, ["run", "review", "the change"], {
          path: withoutAnAgent,
          spend: noSuchAgent,
        });

        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain("AgentInvocationError");
        // The three fields the error carries, each of which sends the reader somewhere different.
        expect(ran.stderr).toContain("agent: drafter");
        expect(ran.stderr).toContain("fault: refused-to-spend");
        expect(ran.stderr).toContain("claude");
        // And the switch, by name, because that is the one thing to change to get past this.
        expect(ran.stderr).toContain("KOJO_AGENT_SPEND");
        // The reason on stderr, the phase table on stdout.
        expect(ran.stdout).toContain("draft");
        expect(ran.stdout).not.toContain("AgentInvocationError");
      }),
    ),
  );

  /**
   * **The build's own default, still there for a workflow that wires nothing.**
   *
   * `AbsentAgentInvoker` is what `cli/factory.ts` provides, and a workflow that calls `agent()`
   * without providing an invoker of its own meets it. Its sentence is written for exactly this
   * reader: somebody whose run reached an agent phase and needs to know that the run, the branch and
   * the phases are theirs and only the invocation is missing — not that their roster, prompt or
   * workflow is wrong. The alternative to a refusal is not a working agent; it is a workflow body
   * that dies with `Service not found` and a stack trace.
   */
  it.live("refuses, by name, when a factory's own workflow wires no invoker at all", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem
          .writeFileString(path.join(root, ".kojo", "workflows", "unwired.ts"), unwiredWorkflow)
          .pipe(Effect.orDie);

        const ran = yield* kojo(root, ["run", "unwired", "anything"], { path: withoutAnAgent });

        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain("AgentInvocationError");
        expect(ran.stderr).toContain("agent: nobody");
        expect(ran.stderr).toContain("no agent provider is wired into this build");
        expect(ran.stderr).toContain("only the invocation is missing");
      }),
    ),
  );
});

/** A workflow with an agent phase and no invoker under it. What `AbsentAgentInvoker` is for. */
const unwiredWorkflow = [
  'import { Effect, Schema } from "effect";',
  'import { AgentInvocationError } from "kojo/contexts/agent/models/AgentInvocationError";',
  'import { WorkspaceError } from "kojo/contexts/sandbox/models/WorkspaceError";',
  'import { CheckViolation } from "kojo/contexts/workflow/models/CheckViolation";',
  'import { EnvelopeParseError } from "kojo/contexts/workflow/models/EnvelopeParseError";',
  'import { agent } from "kojo/contexts/workflow/services/phase/agent";',
  'import { workflow } from "kojo/contexts/workflow/services/workflow";',
  'import { Drafted } from "../envelopes.ts";',
  "",
  "export const unwired = workflow(",
  "  {",
  '    name: "unwired",',
  "    payload: { subject: Schema.String },",
  "    success: Schema.String,",
  "    error: Schema.Union([",
  "      AgentInvocationError,",
  "      CheckViolation,",
  "      EnvelopeParseError,",
  "      WorkspaceError,",
  "    ]),",
  "    idempotencyKey: (payload) => `unwired/${payload.subject}`,",
  "  },",
  "  (payload) =>",
  "    Effect.gen(function* () {",
  "      const answer = yield* agent({",
  '        name: "ask",',
  '        description: "Ask an agent nothing has wired",',
  '        agent: "nobody",',
  "        prompt: payload.subject,",
  "        envelope: Drafted,",
  "      });",
  "      return answer.summary;",
  "    }),",
  ");",
  "",
].join("\n");

/**
 * A workflow of the factory's own, written for this test, with a gate in it and no agent.
 *
 * It exists because the stamped `review` cannot be driven past its first phase by a build with no
 * agent provider in it — and the claim that most needs grading is the one about the *whole* loop: a
 * run started from `.kojo/workflows/`, suspended, and continued days later by a different process
 * that has to find and load the same file to be able to replay it. Nothing about that is a demo:
 * the gate is called `sign-off`, and no workflow Kojo ships has one.
 */
const gatedWorkflow = [
  'import { Duration, Effect, Schema } from "effect";',
  'import { GateRejected } from "kojo/contexts/gate/models/GateRejected";',
  'import * as OnExpiry from "kojo/contexts/gate/models/OnExpiry";',
  'import { code } from "kojo/contexts/workflow/services/phase/code";',
  'import { gate } from "kojo/contexts/workflow/services/phase/gate";',
  'import { workflow } from "kojo/contexts/workflow/services/workflow";',
  "",
  "export const paperwork = workflow(",
  "  {",
  '    name: "paperwork",',
  "    payload: { form: Schema.String },",
  "    success: Schema.String,",
  "    error: GateRejected,",
  "    idempotencyKey: (payload) => `paperwork/${payload.form}`,",
  "  },",
  "  (payload) =>",
  "    Effect.gen(function* () {",
  "      const verdict = yield* gate({",
  '        name: "sign-off",',
  "        description: `Sign ${payload.form}?`,",
  '        actor: "clerk",',
  '        choices: ["approve", "reject"],',
  "        deadline: Duration.days(2),",
  "        onExpiry: OnExpiry.fail(),",
  "      });",
  '      if (verdict.choice !== "approve") {',
  '        return yield* new GateRejected({ gate: "sign-off", actor: "clerk", reason: verdict.reason });',
  "      }",
  "      return yield* code(",
  "        {",
  '          name: "file-it",',
  '          description: "File what the clerk signed",',
  "          success: Schema.String,",
  "          error: Schema.Never,",
  "        },",
  "        Effect.succeed(`${payload.form} filed by ${verdict.answerer}`),",
  "      );",
  "    }),",
  ");",
  "",
].join("\n");

/** The token, read out of `kojo gate list` exactly as a person reads it. */
const tokenOf = (listing: string, runId: string): string => {
  const row = listing.split("\n").find((candidate) => candidate.includes(runId));
  const cells = (row ?? "").trim().split(/\s+/);
  return cells[cells.length - 1] ?? "";
};

const runIdOf = (stdout: string): string => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("run "));
  return (line ?? "").slice("run ".length).trim();
};

describe("a factory's own workflow across three processes", () => {
  it.live("suspends at its own gate, and a later process loads the same file to resume it", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem
          .writeFileString(path.join(root, ".kojo", "workflows", "paperwork.ts"), gatedWorkflow)
          .pipe(Effect.orDie);

        const started = succeeded(yield* kojo(root, ["run", "paperwork", "form 12"]));
        const runId = runIdOf(started);

        expect(runId).not.toBe("");
        // `sign-off` is this factory's word. No built-in has a gate by that name, so a suspension
        // reported here cannot have come from anything Kojo ships.
        expect(started).toContain('suspended at gate "sign-off"');
        expect(started).toContain("waiting on clerk");

        const listing = succeeded(yield* kojo(root, ["gate", "list"]));
        expect(listing).toContain(runId);
        expect(listing).toContain("clerk");

        // A different process, holding nothing but the token. It has to find `paperwork.ts` and
        // load it, because applying a verdict is the runner replaying a body it must therefore
        // have — and this body only exists in the target repository.
        const answered = succeeded(
          yield* kojo(root, [
            "gate",
            "answer",
            tokenOf(listing, runId),
            "--choice",
            "approve",
            "--as",
            "kevin",
          ]),
        );

        expect(answered).toContain(`recorded approve on run ${runId}`);
        expect(answered).toContain("run succeeded");

        // The phase after the gate ran in *this* process, and the phase before it is not here
        // because there was none. `file-it` is the factory's own name for its own phase.
        expect(answered).toContain("file-it");
      }),
    ),
  );

  /**
   * **A resume that fails says why, and exits non-zero for it.**
   *
   * Ticket 39 removed exactly this defect from `kojo run`; ticket 15 measured it still in place on
   * the resume path, which is the point a factory reaches *after* an agent has already been paid
   * for. Before this, answering a gate whose run then failed printed the two words `run failed` and
   * exited `0` — so a person got no reason at all and a script's `&&` carried straight on.
   *
   * `paperwork` fails with `GateRejected` when the clerk says no, so the rejection is the run's own
   * typed error travelling the whole way out: raised in the body, persisted by the engine, read back
   * off the finished run, and rendered field by field on stderr.
   */
  it.live("says why a run that failed after its gate was answered failed", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem
          .writeFileString(path.join(root, ".kojo", "workflows", "paperwork.ts"), gatedWorkflow)
          .pipe(Effect.orDie);

        const started = succeeded(yield* kojo(root, ["run", "paperwork", "form 13"]));
        const runId = runIdOf(started);
        const listing = succeeded(yield* kojo(root, ["gate", "list"]));

        const answered = yield* kojo(root, [
          "gate",
          "answer",
          tokenOf(listing, runId),
          "--choice",
          "reject",
          "--reason",
          "the form is the wrong one",
          "--as",
          "kevin",
        ]);

        // The verdict was still recorded — the run failing is not the answer failing.
        expect(answered.stdout).toContain(`recorded reject on run ${runId}`);
        expect(answered.stdout).toContain("run failed");
        // And now the two things that were missing: the reason, and the exit code.
        expect(answered.status).not.toBe(0);
        expect(answered.stderr).toContain("GateRejected");
        expect(answered.stderr).toContain("sign-off");
        expect(answered.stderr).toContain("the form is the wrong one");
      }),
    ),
  );
});

describe("a workflow file that is not a workflow", () => {
  it.live("refuses at load, by path, before anything spawns", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = path.join(root, ".kojo", "workflows", "broken.ts");
        yield* fileSystem
          .writeFileString(source, "export const broken = { not: 'a workflow' };\n")
          .pipe(Effect.orDie);

        const ran = yield* kojo(root, ["run", "broken"]);

        expect(ran.status).not.toBe(0);
        // The path, absolute, is the answer — the message is useless without it.
        expect(ran.stderr).toContain(source);
        expect(ran.stderr).toContain("nothing here is a workflow");
        // Nothing was started: no branch was cut, so no scope was entered.
        expect(git(root, ["branch", "--list"])).not.toContain("kojo/");
      }),
    ),
  );

  it.live("refuses a workflow whose name is not the name of its file", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = path.join(root, ".kojo", "workflows", "renamed.ts");
        yield* fileSystem
          .writeFileString(
            source,
            [
              'import { Effect, Schema } from "effect";',
              'import { code } from "kojo/contexts/workflow/services/phase/code";',
              'import { workflow } from "kojo/contexts/workflow/services/workflow";',
              "",
              "export const renamed = workflow(",
              "  {",
              '    name: "something-else",',
              "    payload: { subject: Schema.String },",
              "    success: Schema.String,",
              "    error: Schema.Never,",
              "    idempotencyKey: (payload) => `renamed/${payload.subject}`,",
              "  },",
              "  (payload) =>",
              "    code(",
              '      { name: "only", description: "the one phase", success: Schema.String, error: Schema.Never },',
              "      Effect.succeed(payload.subject),",
              "    ),",
              ");",
              "",
            ].join("\n"),
          )
          .pipe(Effect.orDie);

        const ran = yield* kojo(root, ["run", "renamed"]);

        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain(source);
        expect(ran.stderr).toContain("something-else");
      }),
    ),
  );

  it.live("does not fall back to a built-in of the same name when the file is broken", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // `demo-review`, and the name is the whole point: there *is* a built-in by that name, so a
        // loader that fell back would run it here and report a clean, fast, empty success. That is
        // exactly the failure this ticket is about, reproduced against the one name where a
        // fallback is still possible after the rename.
        yield* fileSystem
          .writeFileString(
            path.join(root, ".kojo", "workflows", "demo-review.ts"),
            'throw new Error("this factory is mid-edit");\n',
          )
          .pipe(Effect.orDie);

        const ran = yield* kojo(root, ["run", "demo-review", "the change"]);

        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toContain("this factory is mid-edit");
        expect(ran.stdout).not.toContain("run ");
      }),
    ),
  );
});

/**
 * The one name a factory and this build can still both hold, and who wins it.
 *
 * The rename made a collision with a *stamped* name unrepresentable. It did not, and could not, stop
 * somebody naming a workflow of their own `demo-review` — so the precedence rule is still load
 * bearing, and this is what grades it. Without it, `resolve` could consult the demos first and every
 * other test in this file would stay green.
 */
const mineNotYours = [
  'import { Effect, Schema } from "effect";',
  'import { code } from "kojo/contexts/workflow/services/phase/code";',
  'import { workflow } from "kojo/contexts/workflow/services/workflow";',
  "",
  "export const mine = workflow(",
  "  {",
  '    name: "demo-review",',
  "    payload: { subject: Schema.String },",
  "    success: Schema.String,",
  "    error: Schema.Never,",
  "    idempotencyKey: (payload) => `mine/${payload.subject}`,",
  "  },",
  "  (payload) =>",
  "    code(",
  "      {",
  '        name: "only-mine",',
  '        description: "a phase no demo has",',
  "        success: Schema.String,",
  "        error: Schema.Never,",
  "      },",
  "      Effect.succeed(payload.subject),",
  "    ),",
  ");",
  "",
].join("\n");

describe("a factory that names a workflow after one of Kojo's demos", () => {
  it.live("runs the factory's, not Kojo's", () =>
    inStampedRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem
          .writeFileString(path.join(root, ".kojo", "workflows", "demo-review.ts"), mineNotYours)
          .pipe(Effect.orDie);

        const started = succeeded(yield* kojo(root, ["run", "demo-review", "the change"]));

        // `only-mine` is this repository's phase. The built-in `demo-review` has `draft` and `land`
        // and suspends at a gate; neither of those can appear if the factory's file was chosen.
        expect(started).toContain("only-mine");
        expect(started).toContain("run succeeded");
        expect(started).not.toContain("draft");
        expect(started).not.toContain('suspended at gate "approve"');
      }),
    ),
  );
});
