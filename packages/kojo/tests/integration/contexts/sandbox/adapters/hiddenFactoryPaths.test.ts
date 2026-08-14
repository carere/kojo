import type { AgentProvider } from "@ai-hero/sandcastle";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Scope } from "effect";
import * as SandcastleAgentInvoker from "../../../../../src/contexts/agent/adapters/SandcastleAgentInvoker.ts";
import * as YamlRoster from "../../../../../src/contexts/agent/adapters/YamlRoster.ts";
import { AgentInvoker } from "../../../../../src/contexts/agent/ports/AgentInvoker.ts";
import { docker, noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../../../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import { worktreeIsUsable } from "../../../../../src/contexts/sandbox/guards/worktreeIsUsable.ts";
import type { AcquiredSandbox } from "../../../../../src/contexts/sandbox/models/SandboxHandle.ts";
import type { SandboxProvider } from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";
import type { SandboxRequest } from "../../../../../src/contexts/sandbox/models/SandboxRequest.ts";
import { Sandbox } from "../../../../../src/contexts/sandbox/ports/Sandbox.ts";
import { SandboxSource } from "../../../../../src/contexts/sandbox/ports/SandboxSource.ts";
import {
  acquisitionAttempt,
  correlationEnvironment,
} from "../../../../../src/contexts/shared/models/Correlation.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import { factoryOwnPaths } from "../../../../../src/contexts/workflow/models/PermissionPolicy.ts";
import { ensureImage, testImage } from "../../../../support/dockerImage.ts";
import { git, throwawayRepo } from "../../../../support/throwawayRepo.ts";

/**
 * An agent must not be able to see its own grader — proven by an agent that tries.
 *
 * The factory is a **real one**: `throwawayRepo` runs `kojo init` as a subprocess, so the paths being
 * hidden are the paths a stamped factory actually has, and `factoryOwnPaths` is the list under test
 * rather than a fixture that agrees with it by construction.
 *
 * Four claims, and each one has a way of being wrong that only a real repository shows:
 *
 *  1. **The agent cannot read them**, asserted through `SandcastleAgentInvoker` and a scripted
 *     `AgentProvider` — the same door ticket 15 built and the same one a real model comes through.
 *     Not by reading the mount options, which is what the ticket forbids.
 *  2. **The tree is still usable.** This is the rung a plain `rm -rf .kojo` fails: a deleted tracked
 *     file is ` D` in `git status`, `worktreeIsUsable` calls that `modified`, and every acquisition
 *     of every provider would refuse on its first attempt.
 *  3. **The branch still carries the factory, byte for byte**, and so does the trunk after the merge.
 *     A merge that deleted `.kojo/` is the worse of the two faults.
 *  4. **`.kojo/artifacts/` is untouched and still writable**, because the mask is `factoryOwnPaths`
 *     and never `.kojo/` wholesale.
 *
 * And one claim that is deliberately **negative**: `git show HEAD:.kojo/checks.ts` still prints the
 * file. The guarantee is filesystem-level, against an agent that reads files, and claiming more than
 * that would be the kind of green this build keeps catching.
 *
 * **No model is called and no money is spent.** The provider below is a shell script written on this
 * page; `KOJO_AGENT_SPEND` is never set and never read.
 */

const runId = "run-hidden" as RunId;
const branch = "kojo/hidden";
const sandboxId = makeSandboxId(runId, "lane", 1, 1);
const environment = correlationEnvironment({
  runId,
  phaseId: sandboxId,
  attempt: acquisitionAttempt,
});

const request = (options: {
  readonly root: string;
  readonly provider: SandboxProvider;
  readonly hidden?: ReadonlyArray<string>;
}): SandboxRequest => ({
  id: sandboxId,
  name: "lane",
  branch,
  provider: options.provider,
  cwd: options.root,
  environment,
  hidden: options.hidden ?? factoryOwnPaths,
});

/** POSIX single-quoting, with the close-reopen trick. See `SandcastleAgentInvoker.test.ts`. */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * An `AgentProvider` that spawns a shell script and speaks Sandcastle's stream protocol.
 *
 * The same shape as the one in `SandcastleAgentInvoker.test.ts`, and for the same reason: it is a
 * real provider by every test Sandcastle applies to one — `run()` calls `buildPrintCommand`, pipes
 * the prompt in on stdin and feeds stdout back through `parseStreamLine` — so nothing on the path
 * being graded knows the difference. What it is not is a model.
 */
const scripted = (script: string): AgentProvider => ({
  name: "scripted",
  env: {},
  captureSessions: false,
  buildPrintCommand: ({ prompt }) => ({ command: `sh -c ${quote(script)}`, stdin: prompt }),
  parseStreamLine: (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("@session ")) {
      return [{ type: "session_id", sessionId: trimmed.slice("@session ".length) }];
    }
    return trimmed === "" ? [] : [{ type: "text", text: `${line}\n` }];
  },
});

/**
 * What this file declares to the spend guard, and why it may.
 *
 * The provider is the `scripted` object above, built on this page, spawning `sh` with a script this
 * page wrote. There is no binary to resolve and no model to reach. The seam is `layer`'s and not
 * `fromConfig`'s, so no stamped workflow can reach it.
 */
const allowed = {
  _tag: "Allow",
  because: "the provider is a script this test file wrote",
} as const;

const anEnvelope = '{"_tag":"Drafted","summary":"done","files":["notes/hello.txt"]}';

/**
 * What the agent reports about the tree it was put in, written where the host can read it.
 *
 * A **file in the worktree** rather than stdout, because the invoker narrows stdout to the envelope
 * before handing the answer back — a probe echoed to stdout would be narrowed away, which is the
 * quiet way this test could grade nothing. The worktree is the one directory a bind mount and `none`
 * both share with the host.
 *
 * `2>&1` on every probe, so a refusal is captured as text instead of vanishing into a stream nobody
 * reads. Every line is `<name>:<what happened>`, so an assertion names the probe it is about.
 */
const probeScript = (extra: ReadonlyArray<string>): string =>
  [
    "prompt=$(cat)",
    ": > findings.txt",
    'printf "checks:%s\\n" "$(cat .kojo/checks.ts 2>&1)" >> findings.txt',
    'printf "commands:%s\\n" "$(cat .kojo/commands.ts 2>&1)" >> findings.txt',
    'printf "envelopes:%s\\n" "$(cat .kojo/envelopes.ts 2>&1)" >> findings.txt',
    'printf "roster:%s\\n" "$(cat .kojo/kojo.config.yaml 2>&1)" >> findings.txt',
    'printf "identity:%s\\n" "$(cat .kojo/prompts/drafter/system.md 2>&1)" >> findings.txt',
    'printf "workflow:%s\\n" "$(cat .kojo/workflows/review.ts 2>&1)" >> findings.txt',
    'printf "listing:%s\\n" "$(ls .kojo 2>&1 | tr "\\n" " ")" >> findings.txt',
    // Criterion 4. The run's own data directory is not in `factoryOwnPaths`, so it survives and
    // stays writable — an agent that cannot record its work is an agent nobody can review.
    'printf "artifact:%s\\n" "$(cat .kojo/artifacts/keep.txt 2>&1)" >> findings.txt',
    "mkdir -p .kojo/artifacts 2>/dev/null",
    'printf "the agent was here\\n" > .kojo/artifacts/wrote.txt 2>&1',
    'printf "wrote:%s\\n" "$(cat .kojo/artifacts/wrote.txt 2>&1)" >> findings.txt',
    ...extra,
    'printf "@session scripted-cold\\n"',
    `printf '%s\\n' ${JSON.stringify(anEnvelope)}`,
  ].join("\n");

/** How many `name:value` lines a probe script leaves behind. Nine, plus whatever was added. */
const probeLines = 9;

/** One `name:value` line of the agent's report, or a message that says the whole report instead. */
const finding = (report: string, name: string): string => {
  const line = report.split("\n").find((entry) => entry.startsWith(`${name}:`));
  return line === undefined ? `<no "${name}" line in>\n${report}` : line.slice(name.length + 1);
};

/** The lines the report actually holds. Asserted, so an empty report cannot pass every `toContain`. */
const linesIn = (report: string): ReadonlyArray<string> =>
  report.split("\n").filter((line) => line.trim() !== "");

interface Fixture {
  /** The host repository — which keeps every file the worktree does not. */
  readonly root: string;
  readonly sandbox: AcquiredSandbox;
  /** What the agent wrote into `findings.txt`, read from the host side of the worktree. */
  readonly report: Effect.Effect<string, never, FileSystem.FileSystem>;
  /**
   * Close the sandbox scope, here, and carry on looking.
   *
   * The repository outlives the sandbox by one step on purpose. `throwawayRepo` is scoped, so a test
   * that only wrapped the whole thing in `Effect.scoped` would find the worktree gone because the
   * *directory* was deleted — which proves nothing about the release. Closing the inner scope by hand
   * is what makes "what the release left behind" an answerable question. Idempotent.
   */
  readonly release: Effect.Effect<void>;
}

/**
 * A stamped factory, a real sandbox over its own branch, and the mask applied by the real adapter.
 *
 * The acquisition goes through `SandboxSource.acquire` rather than through `acquireSandbox`, because
 * the mask belongs to the adapter and a test that reached past it would be grading the fixture.
 */
const inFactory = <A, E>(
  provider: SandboxProvider,
  use: (fixture: Fixture) => Effect.Effect<A, E, SandboxSource | FileSystem.FileSystem | Path.Path>,
  hidden?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* throwawayRepo({ model: "sonnet" });

    // A tracked file under the artifacts root, committed before the branch is cut. `.kojo/artifacts`
    // is where a phase's prompt and raw output land, and it is deliberately not in `factoryOwnPaths`
    // — so this is the file a mask over `.kojo/` wholesale would destroy.
    yield* fileSystem
      .makeDirectory(path.join(repo.root, ".kojo", "artifacts"), { recursive: true })
      .pipe(Effect.orDie);
    yield* fileSystem
      .writeFileString(path.join(repo.root, ".kojo", "artifacts", "keep.txt"), "an earlier run\n")
      .pipe(Effect.orDie);
    yield* Effect.sync(() => {
      git(repo.root, ["add", "--all"]);
      git(repo.root, ["commit", "--quiet", "--message", "an artifact from an earlier run"]);
    });

    // Forked from the repository's own scope, so a test that never releases still releases: the
    // child closes with its parent. Same pattern `sandboxed` uses for a rebuild.
    const scope = yield* Scope.fork(yield* Scope.Scope);

    return yield* Effect.gen(function* () {
      const source = yield* SandboxSource;
      const acquired = yield* Scope.provide(
        source.acquire(
          request({ root: repo.root, provider, ...(hidden === undefined ? {} : { hidden }) }),
        ),
        scope,
      );
      return yield* use({
        root: repo.root,
        sandbox: acquired,
        report: fileSystem
          .readFileString(path.join(acquired.worktreePath, "findings.txt"))
          .pipe(Effect.orElseSucceed(() => "")),
        release: Scope.close(scope, Exit.void),
      });
    }).pipe(Effect.provide(SandcastleSandboxSource.layer));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * Ask the scripted agent one question, through the real invoker.
 *
 * The roster comes from the **host** repository's `.kojo/kojo.config.yaml`, and that is criterion 2
 * in one line: the run's own roster, prompts, checks, commands and envelopes are read where they
 * still are, by the process driving the run. Only the worktree the agent stands in is missing them.
 */
const askTheAgent = (fixture: Fixture, script: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const invoker = SandcastleAgentInvoker.layer({
      provider: () => scripted(script),
      spend: allowed,
    }).pipe(
      Layer.provide(
        YamlRoster.layer({ config: path.join(fixture.root, ".kojo", "kojo.config.yaml") }).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
      Layer.provide(Layer.succeed(Sandbox, { ...fixture.sandbox, id: sandboxId, environment })),
      Layer.orDie,
    );

    return yield* Effect.flatMap(AgentInvoker, (agent) =>
      agent.invoke({
        agent: "drafter",
        prompt: "Look around and report what you can read.",
        session: Option.none(),
      }),
    ).pipe(Effect.provide(invoker), Effect.orDie);
  });

/** Every probe whose answer must be a refusal. One per path in `factoryOwnPaths`. */
const barred = ["checks", "commands", "envelopes", "roster", "identity", "workflow"];

describe("what a real agent finds where its grader used to be", () => {
  /**
   * The load-bearing test of this ticket, and it runs on every machine.
   *
   * `noSandbox()` is the weakest provider for this protection and the best one to grade the mechanism
   * in: it needs no daemon, and it runs the same adapter code a container run does. Isolation is what
   * Docker adds, and that is asserted separately below.
   */
  it.live("cannot read the checks, the commands, the envelopes, the roster or the prompts", () =>
    inFactory(noSandbox(), (fixture) =>
      Effect.gen(function* () {
        const answer = yield* askTheAgent(
          fixture,
          probeScript([
            // The honest limit, asserted rather than hoped for. Kept out of the container test
            // because that image deliberately has no git in it.
            'printf "objects:%s\\n" "$(git show HEAD:.kojo/checks.ts 2>&1 | grep -c diffMatchesClaims)" >> findings.txt',
          ]),
        );
        expect(answer.output).toBe(anEnvelope);

        const report = yield* fixture.report;
        // The report exists at all. An empty one would pass every `toContain` below while proving
        // nothing, which is the exact shape of build-record.md §4's second half.
        expect(linesIn(report)).toHaveLength(probeLines + 1);

        for (const probe of barred) {
          expect(finding(report, probe)).toContain("No such file");
        }

        // Not there to be listed, either. `.kojo/` itself survives — the mask is a list of paths and
        // not a directory — but nothing a grader is made of is left in it.
        const listing = finding(report, "listing");
        for (const name of ["checks.ts", "commands.ts", "envelopes.ts", "kojo.config.yaml"]) {
          expect(listing).not.toContain(name);
        }

        // Criterion 4: the data directory is not the factory. Readable, and still writable.
        expect(finding(report, "artifact")).toBe("an earlier run");
        expect(finding(report, "wrote")).toBe("the agent was here");

        // **And this is what the ticket cannot claim.** The parent `.git` is reachable from every
        // provider, so the blobs are too: `cat` fails and `git show` does not.
        expect(finding(report, "objects")).not.toBe("0");
      }),
    ),
  );

  it.live("leaves the whole factory in place when a workflow says it wants it", () =>
    inFactory(
      noSandbox(),
      (fixture) =>
        Effect.gen(function* () {
          yield* askTheAgent(fixture, probeScript([]));
          const report = yield* fixture.report;

          // Far more lines than the test above, and that is the assertion: every `cat` printed a
          // whole file instead of one refusal. A count is the wrong tool here for exactly that
          // reason, so the shape of the evidence is what is checked.
          expect(linesIn(report).length).toBeGreaterThan(probeLines);

          // `hidden: []` is the opt-out, and this is what taking it looks like. Kojo's own factory
          // takes it — see `keepsItsOwnFactory` in `.kojo/workflows/lane/common.ts`.
          for (const probe of barred) {
            expect(finding(report, probe)).not.toContain("No such file");
          }
          expect(report).toContain("diffMatchesClaims");
          expect(finding(report, "listing")).toContain("checks.ts");
        }),
      [],
    ),
  );
});

describe("the tree the run works in, and the branch it lands", () => {
  it.live("reads a masked worktree as healthy, which a deletion never could", () =>
    inFactory(noSandbox(), (fixture) =>
      Effect.gen(function* () {
        const source = yield* SandboxSource;
        const state = yield* source.worktree(fixture.sandbox);

        // The rung a plain `rm -rf .kojo` fails. `git status --porcelain --untracked-files=no` is
        // empty because the index was told to stop consulting the worktree for those entries; a
        // deletion would answer ` D .kojo/checks.ts`, and this would be `true`.
        expect(state.modified).toBe(false);
        expect(state.head).toBe(branch);
        expect(
          worktreeIsUsable({ branch, worktreePath: fixture.sandbox.worktreePath, state }),
        ).toEqual(Option.none());
      }),
    ),
  );

  it.live("commits and merges a branch that still carries the factory, byte for byte", () =>
    inFactory(noSandbox(), (fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = fixture.sandbox.worktreePath;

        // The run's own work, committed the way the `commit` phase does it — `git add --all`, then
        // a commit. If the mask were a deletion, this is the commit that would carry it.
        yield* fileSystem
          .writeFileString(path.join(worktree, "notes", "hello.txt"), "goodbye\n")
          .pipe(Effect.orDie);
        yield* Effect.sync(() => {
          git(worktree, ["add", "--all"]);
          git(worktree, ["commit", "--quiet", "--message", "the agent's work"]);
        });

        // Nothing but the agent's own file. A staged deletion of `.kojo/` would be here.
        expect(
          git(worktree, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"),
        ).toEqual(["notes/hello.txt"]);

        const base = git(fixture.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        const blobOf = (revision: string) =>
          git(fixture.root, ["rev-parse", `${revision}:.kojo/checks.ts`]).trim();
        const original = blobOf(base);

        // Byte for byte — the assertion the ticket calls the worse fault if it goes.
        expect(blobOf(branch)).toBe(original);

        git(fixture.root, ["merge", "--no-ff", "--quiet", "--message", "land it", branch]);
        expect(blobOf("HEAD")).toBe(original);
        expect(git(fixture.root, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(
          ".kojo/checks.ts",
        );
        expect(yield* fileSystem.exists(path.join(fixture.root, ".kojo", "checks.ts"))).toBe(true);
      }),
    ),
  );
});

describe("putting the factory back on the way out", () => {
  /**
   * The un-mask, graded where it is observable.
   *
   * A **clean** worktree is removed by `sandbox.close()`, index and all, so the un-mask leaves no
   * trace there. A worktree carrying uncommitted work is *preserved* — Sandcastle refuses to throw
   * work away — and that is the tree a human opens after a run stops. So this is where the un-mask
   * has to be right: the human finds the repository they expect, rather than one with its factory
   * missing and an index quietly telling git to ignore the fact.
   */
  it.live("leaves a preserved worktree with its factory back and its own work intact", () =>
    inFactory(noSandbox(), (fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = fixture.sandbox.worktreePath;

        // Uncommitted work on a tracked file. This is what makes Sandcastle preserve the tree.
        yield* fileSystem
          .writeFileString(path.join(worktree, "notes", "hello.txt"), "half done\n")
          .pipe(Effect.orDie);
        // While the sandbox is up, the factory is not there.
        expect(yield* fileSystem.exists(path.join(worktree, ".kojo", "checks.ts"))).toBe(false);

        yield* fixture.release;

        expect(yield* fileSystem.exists(worktree)).toBe(true);
        const checks = path.join(worktree, ".kojo", "checks.ts");
        expect(yield* fileSystem.exists(checks)).toBe(true);
        expect(yield* fileSystem.readFileString(checks)).toContain("diffMatchesClaims");
        // The bit is off again, so git is consulting the worktree once more — and all it finds is
        // the work really left behind. `H` is an ordinary cached entry; `S` is a skipped one.
        expect(git(worktree, ["status", "--porcelain"]).trim()).toBe("M notes/hello.txt");
        expect(git(worktree, ["ls-files", "-v", ".kojo/checks.ts"]).trim()).toBe(
          "H .kojo/checks.ts",
        );
      }),
    ),
  );
});

const image = ensureImage();

if (!image.ok) {
  console.warn(
    ["NOT PROVEN: the factory hidden inside a real Docker container.", `  - ${image.reason}`].join(
      "\n",
    ),
  );
}

describe("the gate on the container test", () => {
  it("names what is missing rather than passing quietly", () => {
    // Always runs, so the file always loads and the skip below is always visible as a skip.
    expect(image.ok || image.reason.length > 0).toBe(true);
  });
});

/**
 * The same claim, in the environment criterion 7 asks about.
 *
 * `docker container prune -f` before this tier: three stale containers took it 4.5× longer once, and
 * the timeout that followed read as a test failure. See build-record.md §5, rung 7.
 */
describe.skipIf(!image.ok)("inside a real container", () => {
  it.live("cannot read the factory from inside the container either", () =>
    inFactory(docker({ imageName: testImage }), (fixture) =>
      Effect.gen(function* () {
        // Through the sandbox's own `exec`, which is the door every phase and every agent has. A
        // bind mount is live — the container reads the host's inodes — so a file the host took away
        // is a file the container cannot open, whatever order the two happened in.
        const read = yield* fixture.sandbox.exec("cat .kojo/checks.ts");
        expect(read.succeeded).toBe(false);
        expect(`${read.stdout}${read.stderr}`).toContain("No such file");

        const listing = yield* fixture.sandbox.exec("ls .kojo");
        expect(listing.stdout).not.toContain("checks.ts");
        expect(listing.stdout).not.toContain("kojo.config.yaml");

        // And the data directory is there, readable and writable, in the container too.
        const kept = yield* fixture.sandbox.exec("cat .kojo/artifacts/keep.txt");
        expect(kept.succeeded).toBe(true);
        expect(kept.stdout).toContain("an earlier run");
      }),
    ),
  );
});
