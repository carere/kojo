import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, type PlatformError, type Scope } from "effect";

/**
 * **The acceptance test for ticket 21.**
 *
 * A whole factory on a real repository, failed on purpose: the ticket goes back to the status it
 * had, the failure is posted to it, and the branch and its commit are still there afterwards. The
 * inverse of ticket 20's merge, on the same footing — a real repository, real worktrees, the durable
 * engine on a SQLite file, and two processes.
 *
 * **Two processes is the claim, not the setup.** The process that starts the run exits while the run
 * is suspended, so this measures three things a single process cannot: that the compensation does
 * not fire when the starting process goes away, that it fires exactly once when another process ends
 * the run days later, and that the process which fires it is the one that ended the run.
 *
 * The factory itself is `tests/support/durableCompensation.ts`.
 */

const script = new URL("../../../../support/durableCompensation.ts", import.meta.url).pathname;

/** The Bun running this suite, which the children must also be. See `SingleNodeEngine.test.ts`. */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

interface Reported {
  readonly runId: string;
  readonly status: string;
  readonly failure?: string;
  readonly pid: number;
}

const inItsOwnProcess = (args: ReadonlyArray<string>): Reported => {
  const finished = spawnSync(bun(), [script, ...args], { encoding: "utf8" });
  if (finished.status !== 0) {
    throw new Error(`durableCompensation ${args[0]} exited ${finished.status}: ${finished.stderr}`);
  }
  const lines = finished.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Reported;
};

/** The status with the reason folded in, so a failed assertion names what went wrong. */
const where = (reported: Reported): string =>
  reported.failure === undefined ? reported.status : `${reported.status}: ${reported.failure}`;

interface Ticket {
  readonly status: string;
  readonly comments: ReadonlyArray<string>;
}

interface Fixture {
  readonly config: string;
  readonly tracker: string;
  readonly log: string;
  readonly repo: string;
  readonly trunk: string;
}

const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });

const has = (repo: string, ref: string): boolean =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo }).status === 0;

const ticketOf = (fixed: Fixture): Ticket =>
  JSON.parse(readFileSync(fixed.tracker, "utf8")) as Ticket;

/** Every line the run appended, in order. An absent file is an empty log, not a broken one. */
const logOf = (fixed: Fixture): ReadonlyArray<string> => {
  try {
    return readFileSync(fixed.log, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
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
      prefix: "kojo-compensation-",
    });
    const repo = `${root}/repo`;
    const trunk = "main";

    yield* fileSystem.makeDirectory(repo, { recursive: true });
    yield* Effect.sync(() => seedRepository(repo, trunk));

    const fixed: Fixture = {
      config: `${root}/compensation.json`,
      tracker: `${root}/ticket.json`,
      log: `${root}/compensation.log`,
      repo,
      trunk,
    };

    yield* Effect.sync(() => {
      // The ticket as a human left it: ready for somebody to pick up.
      writeFileSync(fixed.tracker, JSON.stringify({ status: "ready", comments: [] }));
      writeFileSync(
        fixed.config,
        JSON.stringify({
          database: `${root}/kojo.db`,
          trace: `${root}/trace.jsonl`,
          tracker: fixed.tracker,
          log: fixed.log,
          repo,
          trunk,
        }),
      );
    });

    return fixed;
  });

const inFixture = <A, E>(
  use: (fixed: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.flatMap(fixture(), use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("a run that fails", () => {
  it.live(
    "returns the ticket to its previous status, reports the failure, and preserves the branch",
    () =>
      inFixture((fixed) =>
        Effect.sync(() => {
          const seeded = git(fixed.repo, ["rev-parse", fixed.trunk]).trim();

          const started = inItsOwnProcess(["start", fixed.config, "alpha"]);
          expect(where(started)).toBe("suspended");

          const branch = `kojo/${started.runId}`;

          // The claim happened, and the work is committed on the run's own branch.
          expect(ticketOf(fixed).status).toBe("in progress");
          expect(has(fixed.repo, branch)).toBe(true);
          expect(git(fixed.repo, ["log", "-1", "--format=%s", branch]).trim()).toBe("feat: alpha");

          // **Nothing fired when the starting process exited.** The run is suspended, its workflow
          // instance scope was never closed, and the process that registered both the undo and the
          // run-end cleanup is now gone without either of them running.
          expect(logOf(fixed)).toEqual([]);
          expect(ticketOf(fixed).comments).toEqual([]);

          const rejected = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "reject",
            "not what I asked for",
          ]);
          expect(rejected.status).toBe("failed");
          expect(rejected.failure).toContain("NotAccepted");

          // The world is put back. `ready` is the status the claim phase *found* — recorded by that
          // activity in the first process and handed back to the replay in the second.
          const ticket = ticketOf(fixed);
          expect(ticket.status).toBe("ready");

          // And the failure is reported, naming the branch to go and look at.
          expect(ticket.comments).toHaveLength(1);
          expect(ticket.comments[0]).toContain("NotAccepted");
          expect(ticket.comments[0]).toContain("kevin: not what I asked for");
          expect(ticket.comments[0]).toContain(`The branch ${branch} is preserved.`);

          // Once each, and both written by the process that ended the run rather than the one that
          // started it. This is the property the two processes exist to measure.
          expect(logOf(fixed)).toEqual([
            `undo:${rejected.pid}:NotAccepted`,
            `end:${rejected.pid}:failed`,
          ]);

          // **Preserving the branch is the point.** A failed run's branch and the work on it are the
          // inspection surface; deleting them would be the failure.
          expect(has(fixed.repo, branch)).toBe(true);
          expect(git(fixed.repo, ["show", `${branch}:notes/work.md`])).toContain("alpha");
          // And the trunk never moved, because nothing was accepted.
          expect(git(fixed.repo, ["rev-parse", fixed.trunk]).trim()).toBe(seeded);
        }),
      ),
    120000,
  );
});

describe("a run that is accepted", () => {
  it.live(
    "puts nothing back, and leaves the ticket claimed",
    () =>
      inFixture((fixed) =>
        Effect.sync(() => {
          const seeded = git(fixed.repo, ["rev-parse", fixed.trunk]).trim();

          const started = inItsOwnProcess(["start", fixed.config, "beta"]);
          expect(where(started)).toBe("suspended");

          const approved = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "approve",
            "ok",
          ]);
          expect(where(approved)).toBe("succeeded");

          // Compensation is the failure path and nothing else: the ticket stays where the run put
          // it, and nothing was posted to it.
          const ticket = ticketOf(fixed);
          expect(ticket.status).toBe("in progress");
          expect(ticket.comments).toEqual([]);

          // The run-end cleanup still ran — once, in the process that finished it — because it is
          // the other tool and runs on every terminal path.
          expect(logOf(fixed)).toEqual([`end:${approved.pid}:success`]);

          // And it landed.
          expect(git(fixed.repo, ["rev-parse", fixed.trunk]).trim()).not.toBe(seeded);
          expect(git(fixed.repo, ["show", `${fixed.trunk}:notes/work.md`])).toContain("beta");
          expect(has(fixed.repo, `kojo/${started.runId}`)).toBe(true);
        }),
      ),
    120000,
  );
});
