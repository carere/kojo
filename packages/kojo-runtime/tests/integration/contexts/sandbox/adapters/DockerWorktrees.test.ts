import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { docker } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../../../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import type { AcquiredSandbox } from "../../../../../src/contexts/sandbox/models/SandboxHandle.ts";
import { SandboxSource } from "../../../../../src/contexts/sandbox/ports/SandboxSource.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import { sandboxResourcesAt } from "../../../../support/sandboxResources.ts";

// Explicit local opt-in: use the image built from examples/issue/.kojo/sandbox/Dockerfile.
// No provider credentials or paid agent calls are needed.
const imageName = process.env.KOJO_TEST_DOCKER_IMAGE;

describe.skipIf(imageName === undefined)("Docker issue worktrees", () => {
  it.effect(
    "isolates sibling writes, mounts one read-only file, and starts dependent work from integrated commits",
    () =>
      Effect.gen(function* () {
        if (imageName === undefined) return;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "kojo-docker-worktrees-" });
        const repo = `${root}/repo`;
        yield* fs.makeDirectory(repo);
        const auth = `${root}/auth.json`;
        yield* fs.writeFileString(auth, '{"test":"public-fixture"}\n');
        yield* Effect.gen(function* () {
          const workspace = yield* Workspace;
          const source = yield* SandboxSource;
          yield* workspace.git(["init", "--quiet", "--initial-branch=main"]);
          yield* workspace.git(["config", "user.name", "Kojo test"]);
          yield* workspace.git(["config", "user.email", "kojo@example.invalid"]);
          yield* workspace.write("seed.txt", "seed\n");
          yield* workspace.git(["add", "seed.txt"]);
          yield* workspace.git(["commit", "--quiet", "-m", "test: seed"]);
          yield* workspace.git(["branch", "codex/delivery"]);
          const acquire = (name: string, baseBranch: string) => {
            const branch = `codex/${name}`;
            const resources = sandboxResourcesAt(repo, branch);
            return source.acquire({
              id: makeSandboxId("docker-integration" as RunId, name, 1, 1),
              name,
              branch,
              baseBranch,
              cwd: repo,
              environment: {},
              hidden: [],
              provider: docker({
                imageName,
                mounts: [
                  { hostPath: auth, sandboxPath: "/home/agent/.codex/auth.json", readonly: true },
                ],
              }),
              resources: {
                sandbox: {
                  ...resources.sandbox,
                  inspectionLocator: `${root}/${name}-sandbox.json`,
                },
                worktree: {
                  ...resources.worktree,
                  inspectionLocator: `${root}/${name}-worktree.json`,
                },
              },
            });
          };
          const execute = (sandbox: AcquiredSandbox, command: string) =>
            Effect.map(sandbox.exec(command), (result) => {
              expect(result.exitCode, result.stderr).toBe(0);
              return result.stdout.trim();
            });
          const first = yield* acquire("first", "main");
          const second = yield* acquire("second", "main");
          expect(first.worktreePath).not.toBe(second.worktreePath);
          yield* Effect.all(
            [
              execute(first, "printf 'first\\n' > first.txt"),
              execute(second, "printf 'second\\n' > second.txt"),
            ],
            { concurrency: 2 },
          );
          yield* execute(first, "test ! -e second.txt && test -f first.txt");
          yield* execute(second, "test ! -e first.txt && test -f second.txt");
          expect(yield* fs.exists(`${repo}/first.txt`)).toBe(false);
          expect(yield* fs.exists(`${repo}/second.txt`)).toBe(false);
          expect(yield* execute(first, "cat /home/agent/.codex/auth.json")).toContain(
            "public-fixture",
          );
          expect(
            (yield* first.exec("printf changed > /home/agent/.codex/auth.json")).exitCode,
          ).not.toBe(0);
          expect(yield* fs.readFileString(auth)).toBe('{"test":"public-fixture"}\n');
          for (const sandbox of [first, second]) {
            yield* execute(
              sandbox,
              "git add . && git -c user.name=Kojo -c user.email=kojo@example.invalid commit --quiet -m 'test: accepted change'",
            );
          }
          yield* workspace.git(["checkout", "--quiet", "codex/delivery"]);
          for (const branch of ["codex/first", "codex/second"]) {
            const merged = yield* workspace.git(["merge", "--no-ff", "--no-edit", branch]);
            expect(merged.exitCode, merged.stderr).toBe(0);
          }
          const revision = (yield* workspace.git(["rev-parse", "HEAD"])).stdout.trim();
          const dependent = yield* acquire("dependent", revision);
          expect(yield* execute(dependent, "git rev-parse HEAD")).toBe(revision);
          yield* execute(
            dependent,
            'test -f first.txt && test -f second.txt && test -z "$(git status --porcelain)"',
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(BindMountWorkspace.layer({ root: repo }), SandcastleSandboxSource.layer),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    120_000,
  );
});
