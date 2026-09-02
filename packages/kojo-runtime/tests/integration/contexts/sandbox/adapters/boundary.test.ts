// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { acquireSandbox } from "../../../../../src/contexts/sandbox/adapters/boundary.ts";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import { defaultTrunk } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { sandboxResourcesAt } from "../../../../support/InMemoryExecutionServices.ts";

const seed = Effect.gen(function* () {
  const workspace = yield* Workspace;
  yield* workspace.git(["init", "--quiet", `--initial-branch=${defaultTrunk}`]);
  yield* workspace.write("src/health.ts", "export const ok = true\n");
  yield* workspace.git(["add", "."]);
  yield* workspace.git([
    "-c",
    "user.name=Kojo",
    "-c",
    "user.email=kojo@example.invalid",
    "commit",
    "--quiet",
    "--message",
    "seed",
  ]);
});

/**
 * A real repository in a temporary directory, and the real boundary over it.
 *
 * `noSandbox()` is the provider, so this exercises the whole Sandcastle path — worktree creation,
 * branch handling, `exec`, teardown — on a machine with no container runtime. What Docker adds is
 * isolation, not a different lifecycle.
 */
const inRepo = <A, E>(
  use: (root: string) => Effect.Effect<A, E, Workspace | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-sandbox-" });
    return yield* seed.pipe(
      Effect.andThen(use(root)),
      Effect.provide(BindMountWorkspace.layer({ root })),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("the Sandcastle boundary", () => {
  it.effect("releases the sandbox when the scope closes, and keeps the branch", () =>
    inRepo((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* Workspace;

        const worktreePath = yield* Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* acquireSandbox({
              branch: "kojo/boundary",
              provider: noSandbox(),
              cwd: root,
              resources: sandboxResourcesAt(root, "kojo/boundary"),
            });

            expect(sandbox.branch).toBe("kojo/boundary");
            expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
            expect(yield* fileSystem.exists(sandbox.worktreePath)).toBe(true);

            const head = yield* sandbox.exec("git rev-parse --abbrev-ref HEAD");
            expect(head.exitCode).toBe(0);
            expect(head.stdout.trim()).toBe("kojo/boundary");

            return sandbox.worktreePath;
          }),
        );

        // This is the whole tear-down-and-rebuild story in two assertions. A suspension interrupts
        // the fiber, a local scope unwinds, and what is left behind is the branch — from which the
        // sandbox can be built again on replay.
        expect(yield* fileSystem.exists(worktreePath)).toBe(false);
        const branch = yield* workspace.git(["branch", "--list", "kojo/boundary"]);
        expect(branch.stdout.trim()).toContain("kojo/boundary");
      }),
    ),
  );

  it.effect("hands back a non-zero exit code instead of failing", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* acquireSandbox({
            branch: "kojo/exit-code",
            provider: noSandbox(),
            cwd: root,
            resources: sandboxResourcesAt(root, "kojo/exit-code"),
          });

          const result = yield* sandbox.exec("exit 3");

          // Sandcastle surfaces the code rather than throwing, and so does this boundary. A check
          // that grades a failing suite needs the number, not an error channel.
          expect(result.exitCode).toBe(3);
          expect(result.succeeded).toBe(false);
          expect(result.argv).toEqual(["exit 3"]);
        }),
      ),
    ),
  );

  it.effect("carries the capabilities Kojo declared for the provider", () =>
    inRepo((root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* acquireSandbox({
            branch: "kojo/capabilities",
            provider: noSandbox(),
            cwd: root,
            resources: sandboxResourcesAt(root, "kojo/capabilities"),
          });

          // No capture, and resume all the same. Nothing in the acquired handle could have worked
          // this out for itself — the tag came in with the provider.
          expect(sandbox.capabilities.capturesSessions).toBe(false);
          expect(sandbox.capabilities.resumesSessions).toBe(true);
        }),
      ),
    ),
  );

  it.effect("runs the hooks in the three slots that exist", () =>
    inRepo((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* acquireSandbox({
              branch: "kojo/hooks",
              provider: noSandbox(),
              cwd: root,
              resources: sandboxResourcesAt(root, "kojo/hooks"),
              hooks: {
                host: { onWorktreeReady: [{ command: "echo ready > from-host.txt" }] },
                sandbox: { onSandboxReady: [{ command: "echo ready > from-sandbox.txt" }] },
              },
            });

            // Both files land in the worktree, which is what says the slots were filled rather
            // than accepted and ignored. `host.onSandboxReady` is the third slot and needs
            // nothing proving that these two do not.
            for (const written of ["from-host.txt", "from-sandbox.txt"]) {
              expect([
                written,
                yield* fileSystem.exists(path.join(sandbox.worktreePath, written)),
              ]).toEqual([written, true]);
            }
          }),
        );
      }),
    ),
  );

  it.effect("puts a sandbox that never started in the error channel", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bare = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-not-a-repo-" });

      const outcome = yield* Effect.scoped(
        acquireSandbox({
          branch: "kojo/nowhere",
          provider: noSandbox(),
          cwd: bare,
          resources: sandboxResourcesAt(bare, "kojo/nowhere"),
        }),
      ).pipe(Effect.result);

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.operation).toBe("create");
        expect(outcome.failure.target).toBe("kojo/nowhere");
        expect(outcome.failure.reason).toContain(
          "the Daemon worktree allocation has no source Git directory",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

/**
 * **A worktree Kojo cannot read is never deleted by a release** — ticket 60.
 *
 * Sandcastle decides whether to keep a worktree by running `git status --porcelain` in it, wrapped
 * in a `catchAll` that turns *any* failure into "clean", and then removes a clean one with
 * `git worktree remove --force`. So a repository git cannot answer about is one it deletes,
 * uncommitted work and all, silently.
 *
 * This was recorded as latent for a day, then made to fire. **The distinction that matters, and both
 * halves are measured below:**
 *
 * - break the worktree's *registration* and both commands fail, so nothing is lost. That is why the
 *   first attempt to reproduce this found nothing and the ticket nearly closed as unreachable;
 * - break only what `git status` needs — an unreadable index is enough — and the parent repository
 *   can still force-remove the tree. **That is the case that loses work.**
 */
describe("releasing a worktree git cannot answer about", () => {
  /** The gitdir a linked worktree points at, read out of its own `.git` file. */
  const gitdirOf = (worktreePath: string): string =>
    readFileSync(join(worktreePath, ".git"), "utf8")
      .trim()
      .replace(/^gitdir:\s*/, "");

  it.effect("keeps it, and the uncommitted work in it, rather than guessing it is clean", () =>
    inRepo((root) =>
      Effect.gen(function* () {
        const worktreePath = yield* Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* acquireSandbox({
              branch: "kojo/unreadable",
              provider: noSandbox(),
              cwd: root,
              resources: sandboxResourcesAt(root, "kojo/unreadable"),
            });

            writeFileSync(join(sandbox.worktreePath, "work.txt"), "what a run had not committed\n");

            // Only the index, so the *parent* can still remove the worktree — which is what makes
            // this the case that loses work rather than the one that quietly fails to.
            execFileSync("chmod", ["000", join(gitdirOf(sandbox.worktreePath), "index")]);

            const asked = spawnSync("git", ["status", "--porcelain"], {
              cwd: sandbox.worktreePath,
              encoding: "utf8",
            });
            expect(asked.status, "the premise: git must be unable to answer").not.toBe(0);

            return sandbox.worktreePath;
          }),
        );

        // The whole ticket, in two lines.
        expect(existsSync(worktreePath), "the worktree was deleted").toBe(true);
        expect(existsSync(join(worktreePath, "work.txt")), "the work was deleted").toBe(true);

        execFileSync("chmod", ["644", join(gitdirOf(worktreePath), "index")]);
      }),
    ),
  );

  /** And the ordinary case is untouched: a readable worktree is released exactly as before. */
  it.effect("releases one that answers, exactly as it always did", () =>
    inRepo((root) =>
      Effect.gen(function* () {
        const worktreePath = yield* Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* acquireSandbox({
              branch: "kojo/readable",
              provider: noSandbox(),
              cwd: root,
              resources: sandboxResourcesAt(root, "kojo/readable"),
            });
            return sandbox.worktreePath;
          }),
        );

        expect(existsSync(worktreePath)).toBe(false);
      }),
    ),
  );
});
