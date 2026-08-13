// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { acquireSandbox } from "../../../../../src/contexts/sandbox/adapters/boundary.ts";
import * as SandboxExecWorkspace from "../../../../../src/contexts/sandbox/adapters/SandboxExecWorkspace.ts";
import {
  requireResume,
  sessionCapabilities,
} from "../../../../../src/contexts/sandbox/guards/sessions.ts";
import type { AcquiredSandbox } from "../../../../../src/contexts/sandbox/models/SandboxHandle.ts";
import { WorkspaceError } from "../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { localIsolated } from "../../../../support/localIsolatedProvider.ts";

const seed = Effect.gen(function* () {
  const workspace = yield* Workspace;
  yield* workspace.git(["init", "--quiet"]);
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
 * A real repository on the host, and a sandbox over it from an isolated provider.
 *
 * The host repo is prepared through the bind-mount adapter, which is what a factory does before a
 * run starts. Everything after `acquireSandbox` is on the other side of a boundary Sandcastle will
 * not cross with a file handle: the repo was bundled, copied in, and cloned inside the sandbox.
 */
const isolated = <A, E, R>(use: (sandbox: AcquiredSandbox) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-isolated-" });
    yield* seed.pipe(Effect.provide(BindMountWorkspace.layer({ root })));

    const sandbox = yield* acquireSandbox({
      branch: "kojo/isolated",
      provider: localIsolated(),
      cwd: root,
    });
    return yield* use(sandbox);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** The same repository, reached the ordinary way, so the two answers can be compared. */
const onHost = <A, E>(use: Effect.Effect<A, E, Workspace>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-host-" });
    return yield* seed.pipe(
      Effect.andThen(use),
      Effect.provide(BindMountWorkspace.layer({ root })),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const addedModule = "export const added = 1\n";

/**
 * One check, written against the port and nothing else.
 *
 * This is the criterion the whole adapter exists for, made executable: the text below never learns
 * where the tree is. It is run twice — over a worktree on the host and over a sandbox with no host
 * filesystem at all — and the two answers are compared to each other rather than to a literal, so a
 * drift in either adapter shows up as a disagreement.
 */
const lane = Effect.gen(function* () {
  const workspace = yield* Workspace;

  yield* workspace.write("src/added.ts", addedModule);
  const listed = yield* workspace.exec(["ls", "src"]);
  const added = yield* workspace.stat("src/added.ts");
  const nowhere = yield* workspace.stat("src/nowhere.ts");
  const graded = yield* workspace.exec(["sh", "-c", "grep -q added src/added.ts"]);
  const failing = yield* workspace.exec(["sh", "-c", "exit 3"]);
  // Through `git`, which is its own method on the port precisely because an adapter may have to
  // send it somewhere other than `exec`. This one does not, and the tracked list is what proves
  // git ran beside the tree rather than beside some other copy of it.
  const tracked = yield* workspace.git(["ls-files"]);

  return {
    listed: listed.stdout.split("\n").filter((line) => line !== ""),
    read: yield* workspace.read("src/added.ts"),
    added: Option.map(added, (stat) => `${stat.kind}:${stat.size}`),
    nowhere: Option.isNone(nowhere),
    graded: graded.exitCode,
    gradedArgv: graded.argv,
    failing: failing.exitCode,
    tracked: tracked.stdout.split("\n").filter((line) => line !== ""),
  };
});

class Built extends Schema.Class<Built>("Built")({
  file: Schema.String,
  content: Schema.String,
}) {}

/**
 * A workflow of two code phases, both acting only through the port.
 *
 * Written the way an author writes one — a phase that changes the tree, then a phase that grades
 * it — and nothing in it mentions a sandbox. That is the point: the same program is what runs over
 * a bind mount.
 */
const factory = workflow(
  {
    name: "isolated-lane",
    payload: { file: Schema.String },
    success: Built,
    error: WorkspaceError,
    idempotencyKey: (payload) => `isolated-lane/${payload.file}`,
  },
  (payload) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;

      yield* code(
        {
          name: "build",
          description: "Write the module the check will grade",
          success: Schema.Void,
          error: WorkspaceError,
        },
        workspace.write(payload.file, "export const built = true\n"),
      );

      return yield* code(
        {
          name: "check",
          description: "Read back what the build phase claims it wrote",
          success: Built,
          error: WorkspaceError,
        },
        workspace
          .read(payload.file)
          .pipe(Effect.map((content) => new Built({ file: payload.file, content }))),
      );
    }),
);

const runFactory = (sandbox: AcquiredSandbox) =>
  Effect.gen(function* () {
    const outcome = yield* factory.definition.execute({ file: "src/built.ts" }).pipe(Effect.result);
    const trace = yield* InMemoryTracer.RecordedTrace;
    return { outcome, phases: yield* trace.phases };
  }).pipe(
    Effect.provide(
      factory.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            // The trace sink is in memory because the durable one is a later ticket. The adapter
            // under test — the workspace — is the real one, over a real sandbox.
            InMemoryTracer.layer,
            WorkflowEngine.layerMemory,
            SandboxExecWorkspace.layer(sandbox),
          ),
        ),
      ),
    ),
  );

describe("the workspace an isolated provider gives", () => {
  it.effect("has no host path, because there is no host tree to name", () =>
    isolated((sandbox) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace;

        // Absence, represented. Sandcastle's handle still carries a `worktreePath` — the staging
        // worktree it bundled the repo out of — and that directory is emphatically not the tree
        // the phases below act on. Handing it back would be the faked answer this field exists to
        // refuse.
        expect(Option.isNone(workspace.hostPath)).toBe(true);
        expect(workspace.root).not.toBe(sandbox.worktreePath);
        expect(sandbox.capabilities.kind).toBe("isolated");

        // The root was asked of the sandbox rather than assumed of it.
        const here = yield* workspace.exec(["pwd"]);
        expect(here.stdout.trim()).toBe(workspace.root);

        // And the tree standing there is the run's branch, cloned in rather than mounted.
        const branch = yield* workspace.git(["rev-parse", "--abbrev-ref", "HEAD"]);
        expect(branch.stdout.trim()).toBe("kojo/isolated");
      }).pipe(Effect.provide(SandboxExecWorkspace.layer(sandbox))),
    ),
  );

  it.effect("answers a check exactly as the bind-mount adapter does", () =>
    Effect.gen(function* () {
      const throughSandbox = yield* isolated((sandbox) =>
        lane.pipe(Effect.provide(SandboxExecWorkspace.layer(sandbox))),
      );
      const onDisk = yield* onHost(lane);

      // One assertion, and it is the acceptance criterion: a check written against the port cannot
      // tell the two apart.
      expect(throughSandbox).toEqual(onDisk);
      expect(onDisk.listed).toEqual(["added.ts", "health.ts"]);
      expect(onDisk.read).toBe(addedModule);
      expect(onDisk.added).toEqual(Option.some(`file:${addedModule.length}`));
      expect(onDisk.nowhere).toBe(true);
      expect(onDisk.graded).toBe(0);
      expect(onDisk.tracked).toEqual(["src/health.ts"]);
      // A command that ran and disagreed is a value on both, never an error channel.
      expect(onDisk.failing).toBe(3);
      expect(onDisk.gradedArgv).toEqual(["sh", "-c", "grep -q added src/added.ts"]);
    }),
  );

  it.effect("keeps a path that leaves the root out of the sandbox", () =>
    isolated((sandbox) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace;

        // Both forms, because the two adapters that already exist refuse both: `..` walks out of
        // the root, and an absolute path never entered it.
        for (const outside of ["../../etc/passwd", "/etc/passwd"]) {
          const outcome = yield* workspace.read(outside).pipe(Effect.result);
          expect([outside, Result.isFailure(outcome)]).toEqual([outside, true]);
        }
      }).pipe(Effect.provide(SandboxExecWorkspace.layer(sandbox))),
    ),
  );

  it.effect("removes a file, and then reports its absence rather than removing it twice", () =>
    isolated((sandbox) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace;

        yield* workspace.write("src/spare.ts", "export const spare = 0\n");
        yield* workspace.unlink("src/spare.ts");
        expect(Option.isNone(yield* workspace.stat("src/spare.ts"))).toBe(true);

        const again = yield* workspace.unlink("src/spare.ts").pipe(Effect.result);
        expect(Result.isFailure(again)).toBe(true);
        if (Result.isFailure(again)) {
          expect(again.failure.operation).toBe("unlink");
          expect(again.failure.reason).toBe("no such file");
        }
      }).pipe(Effect.provide(SandboxExecWorkspace.layer(sandbox))),
    ),
  );

  it.effect("carries the environment a phase asked for into the command", () =>
    isolated((sandbox) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace;

        // `SandboxExecOptions` has no `env`, so the adapter has to build one. A value with a space
        // and a quote in it is the case that says the quoting is real.
        const seen = yield* workspace.exec(["sh", "-c", 'printf %s "$KOJO_LANE"'], {
          env: { KOJO_LANE: "it's a lane" },
        });
        expect(seen.stdout).toBe("it's a lane");
      }).pipe(Effect.provide(SandboxExecWorkspace.layer(sandbox))),
    ),
  );

  it.effect("runs a lane end to end, and leaves the host repository alone", () =>
    isolated((sandbox) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { outcome, phases } = yield* runFactory(sandbox);

        expect(Result.isSuccess(outcome)).toBe(true);
        expect(Result.isSuccess(outcome) && outcome.success.content).toBe(
          "export const built = true\n",
        );
        expect(phases.map((phase) => phase.name)).toEqual(["build", "check"]);
        expect(phases.map((phase) => phase.outcome)).toEqual(["succeeded", "succeeded"]);
        expect(phases.map((phase) => phase.kind)).toEqual(["code", "code"]);

        // Where the phase wrote, asked of the sandbox directly rather than of the port that put it
        // there. Reading it back through `read` alone would agree with any consistent mistake about
        // the root; `git status` runs where Sandcastle says the repo is.
        const pending = yield* sandbox.exec("git status --porcelain");
        expect(pending.stdout.trim()).toBe("?? src/built.ts");

        // And the file lives in the sandbox alone. Sandcastle's staging worktree on the host never
        // saw it, which is what "no host filesystem" means in practice.
        expect(yield* fileSystem.exists(`${sandbox.worktreePath}/src/built.ts`)).toBe(false);
      }),
    ),
  );

  it.effect("reports capture and resume as unavailable, and refuses to degrade quietly", () =>
    isolated((sandbox) =>
      Effect.gen(function* () {
        expect(sessionCapabilities(sandbox.capabilities)).toEqual({
          resume: false,
          capture: false,
        });

        const outcome = yield* requireResume("hotfixer", sandbox.capabilities).pipe(Effect.result);

        // Not a cold start dressed up as a resume: the run stops, and says which kind of sandbox
        // stopped it.
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(outcome.failure.fault).toBe("resume-unsupported");
          expect(outcome.failure.agent).toBe("hotfixer");
          expect(outcome.failure.reason).toContain("isolated");
        }
      }),
    ),
  );
});
