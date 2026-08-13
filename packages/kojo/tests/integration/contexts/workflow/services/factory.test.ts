import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, type PlatformError, Schedule, type Scope } from "effect";
import * as JsonlTracer from "../../../../support/JsonlTracer.ts";

/**
 * **The acceptance test for ticket 20.**
 *
 * A whole factory on a real repository: a run on its own branch, an agent that proposes a commit
 * message, a code phase that performs the commit, a suite that is green or red on demand, a human
 * gate, and a merge that happens only when the mechanical verdict and the human one agree.
 *
 * Everything is spawned, because two of the claims are about a *second process*: one answers a gate
 * the first process opened, and one is refused because the first is still driving the run. The
 * factory itself is `tests/support/durableFactory.ts`.
 */

const script = new URL("../../../../support/durableFactory.ts", import.meta.url).pathname;

/** The Bun running this suite, which the children must also be. See `lane.test.ts`. */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

/** What one process of the harness reports on its last line of stdout. */
interface Reported {
  readonly runId: string;
  readonly status: string;
  readonly failure?: string;
  readonly holder?: string;
}

const inItsOwnProcess = (args: ReadonlyArray<string>): Reported => {
  const finished = spawnSync(bun(), [script, ...args], { encoding: "utf8" });
  if (finished.status !== 0) {
    throw new Error(`durableFactory ${args[0]} exited ${finished.status}: ${finished.stderr}`);
  }
  const lines = finished.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Reported;
};

/** The status with the reason folded in, so a failed assertion names what went wrong. */
const where = (reported: Reported): string =>
  reported.failure === undefined ? reported.status : `${reported.status}: ${reported.failure}`;

interface Fixture {
  readonly config: string;
  readonly trace: string;
  readonly repo: string;
  readonly claims: string;
  readonly trunk: string;
}

const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });

/** Whether a ref exists, without throwing when it does not. */
const has = (repo: string, ref: string): boolean => {
  const asked = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
  return asked.status === 0;
};

const seedRepository = (repo: string, trunk: string): void => {
  git(repo, ["init", "--quiet", `--initial-branch=${trunk}`]);
  git(repo, ["config", "user.name", "Somebody Else"]);
  git(repo, ["config", "user.email", "somebody@example.invalid"]);
  git(repo, ["commit", "--quiet", "--allow-empty", "--message", "seed"]);
};

/** `/private/tmp` where it exists, for the reason `lane.test.ts` measured. */
const fixtureRoot = ((): string => {
  try {
    return realpathSync("/tmp");
  } catch {
    return tmpdir();
  }
})();

const fixture = (): Effect.Effect<
  Fixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      directory: fixtureRoot,
      prefix: "kojo-factory-",
    });
    const repo = `${root}/repo`;
    const trunk = "main";

    yield* fileSystem.makeDirectory(repo, { recursive: true });
    yield* Effect.sync(() => seedRepository(repo, trunk));

    const fixed: Fixture = {
      config: `${root}/factory.json`,
      trace: `${root}/trace.jsonl`,
      repo,
      claims: `${root}/claims`,
      trunk,
    };

    yield* Effect.sync(() =>
      writeFileSync(
        fixed.config,
        JSON.stringify({
          database: `${root}/kojo.db`,
          trace: fixed.trace,
          sessions: `${root}/sessions`,
          claims: fixed.claims,
          repo,
          trunk,
        }),
      ),
    );

    return fixed;
  });

const inFixture = <A, E>(
  use: (fixed: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.flatMap(fixture(), use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("a run that is accepted", () => {
  it.live(
    "keeps its work on its own branch until a human says yes, then lands it on the trunk",
    () =>
      inFixture((fixed) =>
        Effect.sync(() => {
          const seeded = git(fixed.repo, ["rev-parse", fixed.trunk]).trim();

          const started = inItsOwnProcess(["start", fixed.config, "alpha", "green"]);
          expect(where(started)).toBe("suspended");

          const branch = `kojo/${started.runId}`;

          // The run owns a branch named after itself, and the agent's work is on it — committed by
          // a code phase, under the message the agent proposed.
          expect(has(fixed.repo, branch)).toBe(true);
          expect(git(fixed.repo, ["log", "-1", "--format=%s", branch]).trim()).toBe("feat: alpha");
          expect(git(fixed.repo, ["show", `${branch}:notes/work.md`])).toContain("alpha");

          // And the trunk has not moved. Nothing lands before a human has answered.
          expect(git(fixed.repo, ["rev-parse", fixed.trunk]).trim()).toBe(seeded);

          const approved = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "approve",
            "ok",
          ]);
          expect(where(approved)).toBe("succeeded");

          // Landed, with a merge commit rather than a fast-forward: the run is a shape in the
          // history instead of a set of commits that vanished into somebody else's work.
          expect(git(fixed.repo, ["rev-parse", fixed.trunk]).trim()).not.toBe(seeded);
          expect(git(fixed.repo, ["log", "-1", "--format=%s", fixed.trunk]).trim()).toContain(
            `Merge branch '${branch}'`,
          );
          expect(git(fixed.repo, ["show", `${fixed.trunk}:notes/work.md`])).toContain("alpha");
          // Two parents, the second of which is the run's branch.
          expect(git(fixed.repo, ["rev-parse", `${fixed.trunk}^2`]).trim()).toBe(
            git(fixed.repo, ["rev-parse", branch]).trim(),
          );

          // The branch outlives the merge. It is what a human reads a run back from.
          expect(has(fixed.repo, branch)).toBe(true);

          const trace = JsonlTracer.read(fixed.trace);
          expect(trace.phases.map((phase) => `${phase.name}/${phase.kind}`)).toEqual([
            "build/agent",
            "commit/code",
            "test/code",
            "merge/code",
          ]);
          // **Agents propose, code disposes.** The only agent phase is the one that proposed; the
          // commit and the merge are code, and no agent runs either.
          expect(trace.phases.filter((phase) => phase.kind === "agent")).toHaveLength(1);
          expect(trace.phases.every((phase) => phase.outcome === "succeeded")).toBe(true);
        }),
      ),
    120000,
  );

  it.live(
    "attributes the commit to the factory, on a worktree that has no identity of its own",
    () =>
      inFixture((fixed) =>
        Effect.sync(() => {
          const started = inItsOwnProcess(["start", fixed.config, "identity", "green"]);
          const branch = `kojo/${started.runId}`;

          // The repository is configured as somebody else. The commit phase passes its own identity
          // with `-c`, so the run's commits are the factory's and nothing is left behind.
          expect(git(fixed.repo, ["log", "-1", "--format=%an <%ae>", branch]).trim()).toBe(
            "Kojo <kojo@example.invalid>",
          );
        }),
      ),
    120000,
  );
});

describe("a run whose phases all passed and which is still not good", () => {
  /**
   * D7, measured on a real repository.
   *
   * The suite is red and the human approves anyway. Every phase succeeded — the test phase ran the
   * suite and reported it, which is exactly its job — and the run is still not accepted, so nothing
   * lands.
   */
  it.live(
    "merges nothing when the suite was red, however the human answered",
    () =>
      inFixture((fixed) =>
        Effect.sync(() => {
          const seeded = git(fixed.repo, ["rev-parse", fixed.trunk]).trim();

          const started = inItsOwnProcess(["start", fixed.config, "red", "red"]);
          expect(where(started)).toBe("suspended");

          const branch = `kojo/${started.runId}`;
          const answered = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "approve",
            "looks fine to me",
          ]);

          expect(answered.status).toBe("failed");
          expect(answered.failure).toContain("NotAccepted");
          expect(answered.failure).toContain("the suite: 1 failing");

          // Merged nothing.
          expect(git(fixed.repo, ["rev-parse", fixed.trunk]).trim()).toBe(seeded);
          expect(git(fixed.repo, ["log", "--format=%s", fixed.trunk]).trim()).toBe("seed");

          // And left everything intact for inspection: the branch, and the work on it.
          expect(has(fixed.repo, branch)).toBe(true);
          expect(git(fixed.repo, ["show", `${branch}:notes/work.md`])).toContain("red");

          const trace = JsonlTracer.read(fixed.trace);
          const outcomes = new Map(
            trace.phases.map((phase) => [phase.name, phase.outcome] as const),
          );
          // The phase that ran the red suite **passed**. Only the merge refused.
          expect(outcomes.get("test")).toBe("succeeded");
          expect(outcomes.get("commit")).toBe("succeeded");
          expect(outcomes.get("merge")).toBe("failed");
        }),
      ),
    120000,
  );

  it.live(
    "merges nothing when the human said no, however green the suite was",
    () =>
      inFixture((fixed) =>
        Effect.sync(() => {
          const seeded = git(fixed.repo, ["rev-parse", fixed.trunk]).trim();

          const started = inItsOwnProcess(["start", fixed.config, "refused", "green"]);
          const answered = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "reject",
            "not what I asked for",
          ]);

          expect(answered.status).toBe("failed");
          expect(answered.failure).toContain("NotAccepted");
          expect(answered.failure).toContain("kevin: not what I asked for");

          expect(git(fixed.repo, ["rev-parse", fixed.trunk]).trim()).toBe(seeded);
          expect(has(fixed.repo, `kojo/${started.runId}`)).toBe(true);

          const trace = JsonlTracer.read(fixed.trace);
          expect(trace.sandboxes.length).toBeGreaterThanOrEqual(1);
          for (const sandbox of trace.sandboxes) {
            expect(sandbox.branch).toBe(`kojo/${started.runId}`);
            // **Measured, not assumed.** Sandcastle removes a worktree it finds clean when the
            // sandbox closes, and every commit of this run is on the branch — so the directory is
            // gone and the trace's record of where it was is what points a human at the branch.
            // The inspection surface a rejected run leaves is therefore the branch, which is what
            // §4 calls the durable state. Flip this assertion and the reading changes with it.
            expect(existsSync(sandbox.worktreePath)).toBe(false);
          }
          // And the branch is reachable from a worktree anybody can make, which is the other half
          // of the same claim: nothing about the run was lost with the directory.
          expect(
            git(fixed.repo, ["log", "-1", "--format=%s", `kojo/${started.runId}`]).trim(),
          ).toBe("feat: refused");
        }),
      ),
    120000,
  );
});

describe("two processes against one run id", () => {
  /**
   * Edge 9, across a real process boundary.
   *
   * The holder takes the claim and keeps it; the second process asks for the same run and is told
   * no, by name. Refused rather than raced: the second one exits at once rather than waiting, and
   * it never reaches the worktree the first one owns.
   */
  it.live(
    "refuses the second one, and names the runner that is holding it",
    () =>
      inFixture((fixed) =>
        Effect.gen(function* () {
          const marker = `${fixed.claims}.marker`;

          const holding = spawn(
            bun(),
            [script, "hold", fixed.config, "contended", marker, "8000"],
            {
              stdio: "ignore",
            },
          );

          try {
            // The marker is written after the claim is taken, so seeing it means the claim is held
            // rather than merely asked for.
            const taken = yield* Effect.repeat(
              Effect.sync(() => existsSync(marker)),
              {
                schedule: Schedule.spaced(Duration.millis(50)),
                until: (seen: boolean) => seen,
                times: 400,
              },
            );
            expect(taken).toBe(true);

            const refused = inItsOwnProcess(["start", fixed.config, "contended", "green"]);

            expect(refused.status).toBe("refused");
            expect(refused.holder).toBe(readFileSync(marker, "utf8"));
            // Nothing was started: the run has no branch, because the second process never got as
            // far as the worktree the first one owns.
            expect(has(fixed.repo, `kojo/${refused.runId}`)).toBe(false);
            expect(JsonlTracer.read(fixed.trace).runs).toHaveLength(0);
          } finally {
            holding.kill();
          }
        }),
      ),
    120000,
  );
});
