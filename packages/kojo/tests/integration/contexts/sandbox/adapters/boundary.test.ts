// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { acquireSandbox } from "../../../../../src/contexts/sandbox/adapters/boundary.ts";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import { defaultTrunk } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";

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
        acquireSandbox({ branch: "kojo/nowhere", provider: noSandbox(), cwd: bare }),
      ).pipe(Effect.result);

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.operation).toBe("create");
        expect(outcome.failure.target).toBe("kojo/nowhere");
        // The reason is git's own sentence, not a wrapper's paraphrase of it.
        expect(outcome.failure.reason).toContain("not a git repository");
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
