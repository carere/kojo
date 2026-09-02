// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync, spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Result } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../../../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import { worktreeIsUsable } from "../../../../../src/contexts/sandbox/guards/worktreeIsUsable.ts";
import type { AcquiredSandbox } from "../../../../../src/contexts/sandbox/models/SandboxHandle.ts";
import type { SandboxRequest } from "../../../../../src/contexts/sandbox/models/SandboxRequest.ts";
import { SandboxSource } from "../../../../../src/contexts/sandbox/ports/SandboxSource.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import {
  acquisitionAttempt,
  correlationEnvironment,
} from "../../../../../src/contexts/shared/models/Correlation.ts";
import { defaultTrunk } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import { sandboxResourcesAt } from "../../../../support/InMemoryExecutionServices.ts";

const runId = "run-integration" as RunId;
const branch = "kojo/source";
const sandboxId = makeSandboxId(runId, "lane", 1, 1);
const environment = correlationEnvironment({
  runId,
  phaseId: sandboxId,
  attempt: acquisitionAttempt,
});

const commit = (message: string): ReadonlyArray<string> => [
  "-c",
  "user.name=Kojo",
  "-c",
  "user.email=kojo@example.invalid",
  "commit",
  "--quiet",
  "--message",
  message,
];

const seed = Effect.gen(function* () {
  const workspace = yield* Workspace;
  yield* workspace.git(["init", "--quiet", `--initial-branch=${defaultTrunk}`]);
  yield* workspace.write("src/health.ts", "export const ok = true\n");
  yield* workspace.git(["add", "."]);
  yield* workspace.git(commit("seed"));
});

const request = (cwd: string): SandboxRequest => ({
  id: sandboxId,
  name: "lane",
  branch,
  provider: noSandbox(),
  cwd,
  environment,
  // This file is about the branch, the environment and the reading of the tree, and none of them
  // should change because a factory's own paths were taken out. Stated rather than defaulted:
  // `hidden` is required on a request precisely so no test can read an absent list as "nothing".
  // What the mask does is `hiddenFactoryPaths.test.ts`.
  hidden: [],
  resources: sandboxResourcesAt(cwd, branch),
});

/**
 * A real repository, the real source, and no container runtime in sight.
 *
 * `noSandbox()` exercises the whole Sandcastle path — worktree creation, branch handling, the
 * provider's own environment, `exec`, teardown — on any machine. What Docker adds is isolation, not
 * a different lifecycle, and the three things under test here are the branch, the environment and
 * the reading of the tree.
 */
const inRepo = <A, E>(
  use: (
    root: string,
  ) => Effect.Effect<
    A,
    E,
    SandboxSource | Workspace | FileSystem.FileSystem | SandcastleSandboxSource.HostServices
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-source-" });
    return yield* seed.pipe(
      Effect.andThen(use(root)),
      Effect.provide(
        Layer.mergeAll(BindMountWorkspace.layer({ root }), SandcastleSandboxSource.layer),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Runs git inside the worktree the sandbox was built on, the way a stray human would. */
const inWorktree = (sandbox: AcquiredSandbox, args: ReadonlyArray<string>) =>
  Effect.flatMap(BindMountWorkspace.make({ root: sandbox.worktreePath }), (workspace) =>
    workspace.git(args),
  );

describe("reading the worktree a sandbox was built on", () => {
  it.effect("finds nothing wrong with a tree it has just created", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));

          const state = yield* source.worktree(sandbox);
          expect(state.head).toBe(branch);
          expect(state.detached).toBe(false);
          expect(state.modified).toBe(false);
          // A local repository with no remote has no counterpart to be behind, and reading a
          // stale count here would stop runs on every developer machine.
          expect(state.tracked).toBe(false);
          expect(state.behind).toBe(0);

          expect(worktreeIsUsable({ branch, worktreePath: sandbox.worktreePath, state })).toEqual(
            Option.none(),
          );
        }),
      ),
    ),
  );

  it.effect("does not read files copied into the tree as damage", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));
          const fileSystem = yield* FileSystem.FileSystem;

          // What `copyToWorktree` does, done by hand: an untracked file appears in the tree.
          yield* fileSystem.writeFileString(`${sandbox.worktreePath}/.env`, "TOKEN=xyz\n");
          expect((yield* source.worktree(sandbox)).modified).toBe(false);

          // A tracked file changed is a different fact: work the branch does not carry.
          yield* fileSystem.writeFileString(
            `${sandbox.worktreePath}/src/health.ts`,
            "export const ok = false\n",
          );
          expect((yield* source.worktree(sandbox)).modified).toBe(true);
        }),
      ),
    ),
  );

  it.effect("catches the state a paused worktree is left in", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));

          // The first of Sandcastle's four silent skip paths, produced for real. Its refresh reuses
          // a worktree in this state behind a log line; Kojo stops.
          yield* inWorktree(sandbox, ["checkout", "--quiet", "--detach"]);

          const state = yield* source.worktree(sandbox);
          expect(state.detached).toBe(true);
          expect(state.head).toBe("");

          const unusable = Option.getOrThrow(
            worktreeIsUsable({ branch, worktreePath: sandbox.worktreePath, state }),
          );
          expect(unusable.fault).toBe("detached");
        }),
      ),
    ),
  );

  it.effect("stops a run on a tree carrying work the branch does not", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));
          const fileSystem = yield* FileSystem.FileSystem;

          // `requireCommitted` is on by default and no real lane had ever run under it. This is
          // what it is defending: rule 2 of architecture.md §4 says a sandbox derives from the
          // branch alone, and a tracked file changed but not committed is state the branch does
          // not carry — so a run that proceeded on it would be grading a tree that will not exist
          // after the next suspension.
          yield* fileSystem.writeFileString(
            `${sandbox.worktreePath}/src/health.ts`,
            "export const ok = false\n",
          );

          const unusable = Option.getOrThrow(
            worktreeIsUsable({
              branch,
              worktreePath: sandbox.worktreePath,
              state: yield* source.worktree(sandbox),
            }),
          );
          expect(unusable.fault).toBe("modified");
        }),
      ),
    ),
  );

  it.effect("cannot even be rebuilt while uncommitted work is in the way", () =>
    inRepo((root) =>
      Effect.gen(function* () {
        const source = yield* SandboxSource;
        const fileSystem = yield* FileSystem.FileSystem;

        // One acquisition, one uncommitted change, one release — the shape of a run that reached a
        // gate with work it never committed.
        const worktreePath = yield* Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* source.acquire(request(root));
            yield* fileSystem.writeFileString(
              `${sandbox.worktreePath}/src/health.ts`,
              "export const ok = false\n",
            );
            return sandbox.worktreePath;
          }),
        );

        // **The precondition, asserted rather than assumed.** Sandcastle decides whether to preserve
        // by running `git status --porcelain` in the worktree — and it wraps that in a `catchAll`
        // that turns *any* failure into "clean", after which the worktree is removed with `--force`.
        // So a bare `exists()` assertion cannot tell *preserved correctly* from *git could not
        // answer and the work was deleted*, and on a Linux runner it fails as the latter with no
        // clue which. Reading the same thing Sandcastle reads turns that into a named diagnosis.
        const status = spawnSync("git", ["status", "--porcelain"], {
          cwd: worktreePath,
          encoding: "utf8",
        });
        expect(
          status.status,
          `git could not read the worktree, so Sandcastle would call it clean and delete it: ${status.stderr}`,
        ).toBe(0);
        expect(
          status.stdout.trim(),
          "the uncommitted change is not visible to git, so there is nothing for Sandcastle to preserve",
        ).not.toBe("");

        // **Sandcastle preserves a dirty worktree on close.** It removes a clean one — the test
        // below this describe block asserts exactly that — but it will not throw away work, so the
        // directory and the git registration both survive the release.
        expect(yield* fileSystem.exists(worktreePath)).toBe(true);

        /**
         * **And this is what a second acquisition must never do: continue on it as if it were
         * clean.**
         *
         * Either answer is safe. The acquisition may **fail** — `git worktree add` refuses a branch
         * already checked out, which is what happens on both platforms measured — or it may hand a
         * sandbox back, in which case Kojo's own reading of the tree has to say `modified`. What
         * would be unsafe is a rebuild that succeeds and reports a tree it never looked at.
         *
         * **This used to assert the first answer only, and that was a test of git rather than of
         * Kojo** — ticket 61. It passed on one machine and failed on another, and the difference was
         * never the git version: 2.54.0 and 2.55.0 both refuse, measured with plain `git worktree
         * add` on Linux and macOS. What actually differs between the two runs is still unknown, and
         * that is precisely why the assertion no longer depends on knowing.
         *
         * The claim worth carrying is the comment's own strong version: `requireCommitted` is what
         * makes this safe, by turning the dirt into a named `WorktreeUnusable` at the moment it
         * appears rather than into an unexplained failure the next time somebody answers a gate.
         * *refuses to reuse a worktree that is not on its own branch* above is what grades that.
         */
        const rebuilt = yield* Effect.result(Effect.scoped(source.acquire(request(root))));

        if (Result.isFailure(rebuilt)) {
          // The answer both machines gave: git would not add a second worktree for a branch that is
          // already checked out, so the acquisition never happened.
          expect(rebuilt.failure.operation).toBe("create");
          expect(rebuilt.failure.reason).toContain(branch);
        } else {
          // The other safe answer: a sandbox came back, and Kojo can still see the dirt on it.
          const state = yield* source.worktree(rebuilt.success);
          const usable = worktreeIsUsable({
            branch,
            worktreePath: rebuilt.success.worktreePath,
            state,
          });
          expect(
            Option.isSome(usable),
            "a rebuild handed back a worktree Kojo reads as usable, while the work that dirtied it is still there",
          ).toBe(true);
          if (Option.isSome(usable)) expect(usable.value.fault).toBe("modified");
        }
      }),
    ),
  );

  it.effect("counts the run's own commits as ahead, not as a fault", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));
          const fileSystem = yield* FileSystem.FileSystem;

          yield* fileSystem.writeFileString(`${sandbox.worktreePath}/src/health.ts`, "changed\n");
          yield* inWorktree(sandbox, ["add", "."]);
          yield* inWorktree(sandbox, commit("the agent's work"));

          const state = yield* source.worktree(sandbox);
          expect(state.modified).toBe(false);
          expect(worktreeIsUsable({ branch, worktreePath: sandbox.worktreePath, state })).toEqual(
            Option.none(),
          );
        }),
      ),
    ),
  );
});

describe("what the sandbox is actually given", () => {
  it.effect("carries the run, the acquisition and the attempt across the boundary", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));

          // Read back from inside, not from the object Kojo built. Sandcastle runs on its own
          // bundled Effect runtime in a separate process, so this is the only proof that matters.
          // `echo`, not `printenv`: BSD's printenv takes one name and quietly ignores the rest,
          // so the three-name form passes on Linux and proves a third of the claim on a Mac.
          const seen = yield* sandbox.exec('echo "$KOJO_RUN_ID|$KOJO_PHASE_ID|$KOJO_ATTEMPT"');
          expect(seen.exitCode).toBe(0);
          expect(seen.stdout.trim().split("|")).toEqual([runId, sandboxId, "0"]);
        }),
      ),
    ),
  );

  it.effect("hands the region a workspace over the tree the sandbox is on", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const acquired = yield* source.acquire(request(root));
          const sandbox = { ...acquired, id: sandboxId, environment };

          yield* Effect.gen(function* () {
            const workspace = yield* Workspace;

            // `none` and bind-mount both put the tree on this machine, so a human can open it
            // while the run is suspended. Only an isolated provider answers `None` here.
            expect(workspace.hostPath).toEqual(Option.some(acquired.worktreePath));
            expect(yield* workspace.read("src/health.ts")).toContain("export const ok = true");
          }).pipe(Effect.provide(source.workspace(sandbox)));
        }),
      ),
    ),
  );

  it.effect("keeps the branch when the scope closes, and takes the worktree away", () =>
    inRepo((root) =>
      Effect.gen(function* () {
        const source = yield* SandboxSource;
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* Workspace;

        const worktreePath = yield* Effect.scoped(
          Effect.map(source.acquire(request(root)), (sandbox) => sandbox.worktreePath),
        );

        // Tear-down-and-rebuild, end to end: the container is gone and the durable state is not.
        expect(yield* fileSystem.exists(worktreePath)).toBe(false);
        expect((yield* workspace.git(["branch", "--list", branch])).stdout).toContain(branch);
      }),
    ),
  );
});

/**
 * The branch moving under a suspended run — edge 3 of architecture.md §8, against a real remote.
 *
 * Everything before this graded `behind-origin` against a fake `WorktreeState`, which proves the
 * guard and nothing about the reading. The reading is the part that can be wrong: `origin/<branch>`
 * has to exist as a *remote-tracking ref*, `rev-list --left-right --count` has to be read in the
 * right order, and a repository with no remote at all must not be condemned. So the remote here is a
 * real bare repository, and the branch really moves while the run is not looking.
 */
describe("a branch that moved on origin while the run was suspended", () => {
  /** A host repository with one commit, an `origin` bare repo, and the branch pushed to it. */
  const withOrigin = <A, E>(
    use: (paths: { readonly root: string; readonly origin: string }) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const enclosing = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-origin-" });
      const root = `${enclosing}/repo`;
      const origin = `${enclosing}/origin.git`;
      yield* fileSystem.makeDirectory(root, { recursive: true });

      yield* Effect.sync(() => {
        const git = (cwd: string, args: ReadonlyArray<string>) =>
          execFileSync("git", [...args], { cwd, encoding: "utf8" });

        execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
        git(root, ["init", "--quiet", "--initial-branch=main"]);
        git(root, ["config", "user.name", "Kojo"]);
        git(root, ["config", "user.email", "kojo@example.invalid"]);
        git(root, ["commit", "--quiet", "--allow-empty", "--message", "seed"]);
        git(root, ["remote", "add", "origin", origin]);
        git(root, ["push", "--quiet", "origin", "main"]);
        // The lane's branch, forked from the seed and published — so `origin/<branch>` exists and
        // `tracked` is true, which is the precondition the guard needs before it may say anything.
        git(root, ["branch", branch, "main"]);
        git(root, ["push", "--quiet", "origin", branch]);
        git(root, ["fetch", "--quiet", "origin"]);
      });

      return yield* use({ root, origin });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

  /** Somebody else lands a commit on the branch, and the host learns about it. */
  const originMovesOn = (root: string): void => {
    const git = (args: ReadonlyArray<string>) =>
      execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
    git(["commit", "--quiet", "--allow-empty", "--message", "somebody else's work"]);
    // A fast-forward of the remote branch from the host's own `main`, which is the same shape as a
    // colleague pushing while the run waited two days for a human.
    git(["push", "--quiet", "origin", `main:${branch}`]);
    git(["fetch", "--quiet", "origin"]);
  };

  it.effect("reads a clean tree as up to date while nothing has moved", () =>
    withOrigin(({ root }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* SandboxSource;
          const sandbox = yield* source.acquire(request(root));

          const state = yield* source.worktree(sandbox);
          // `tracked` is the fact the earlier local-only tests could never produce: there is an
          // `origin/<branch>` to be behind, and the run is not behind it.
          expect(state.tracked).toBe(true);
          expect([state.behind, state.ahead]).toEqual([0, 0]);
          expect(worktreeIsUsable({ branch, worktreePath: sandbox.worktreePath, state })).toEqual(
            Option.none(),
          );
        }),
      ).pipe(Effect.provide(SandcastleSandboxSource.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  );

  it.effect("stops the run loudly rather than rebuilding on a tree somebody else moved", () =>
    withOrigin(({ root }) =>
      Effect.gen(function* () {
        const source = yield* SandboxSource;

        // The run's first acquisition, released the way a suspension releases one.
        yield* Effect.scoped(Effect.asVoid(source.acquire(request(root))));

        originMovesOn(root);

        // The rebuild, two days later. Sandcastle's own worktree refresh has four paths that skip
        // silently; Kojo reads the tree itself and refuses. Failing loudly is the honest default —
        // rebase, merge and fail are all defensible, doing one of them quietly while nobody is
        // looking is not.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const rebuilt = yield* source.acquire(request(root));
            const state = yield* source.worktree(rebuilt);
            expect(state.tracked).toBe(true);
            expect(state.behind).toBe(1);

            const unusable = Option.getOrThrow(
              worktreeIsUsable({ branch, worktreePath: rebuilt.worktreePath, state }),
            );
            expect(unusable.fault).toBe("behind-origin");
            expect(unusable.state.behind).toBe(1);
          }),
        );
      }).pipe(Effect.provide(SandcastleSandboxSource.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  );

  it.effect("lets an author who declared otherwise carry on", () =>
    withOrigin(({ root }) =>
      Effect.gen(function* () {
        const source = yield* SandboxSource;
        yield* Effect.scoped(Effect.asVoid(source.acquire(request(root))));
        originMovesOn(root);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const rebuilt = yield* source.acquire(request(root));
            // The policy is declared, not assumed. A check an author cannot switch off is a check
            // authors switch off wholesale.
            expect(
              worktreeIsUsable({
                branch,
                worktreePath: rebuilt.worktreePath,
                state: yield* source.worktree(rebuilt),
                policy: { requireUpToDate: false },
              }),
            ).toEqual(Option.none());
          }),
        );
      }).pipe(Effect.provide(SandcastleSandboxSource.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  );
});
