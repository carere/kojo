import { Cause, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { factoryDirectory, runtimePackage } from "../../shared/models/FactoryLayout.ts";
import { installedPackage } from "../../shared/services/resolvePackage.ts";
import type { SandboxChoice } from "../models/FactoryChoices.ts";
import type { Finding } from "../models/Finding.ts";
import { detectPackageManager } from "./detectPackageManager.ts";
import {
  dependencyFinding,
  factoryFinding,
  repositoryFinding,
  runtimeFinding,
} from "./readiness.ts";
import { engineDependency } from "./resolveEngine.ts";

export type Examiner = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

export interface Examination {
  readonly root: string;
  readonly findings: ReadonlyArray<Finding>;
  readonly loadable: boolean;
}

const probe = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [head, ...rest] = argv;
    const handle = yield* spawner.spawn(ChildProcess.make(head ?? "", rest, { extendEnv: true }));
    const [stdout, stderr] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: 2 },
    );
    return { exitCode: yield* handle.exitCode, output: (stdout.trim() || stderr.trim()).trim() };
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.succeed({ exitCode: -1, output: String(Cause.squash(cause)) }),
    ),
  );

const successfulOutput = (result: { readonly exitCode: number; readonly output: string }) =>
  result.exitCode === 0 && result.output !== "" ? result.output : undefined;

/** Repository-local static diagnosis. Project-runtime validation is a separate child process. */
export const diagnose = (options: {
  readonly root: string;
  readonly contracts?: "all" | "global" | undefined;
  readonly sandbox?: SandboxChoice | undefined;
  readonly image?: string | undefined;
}): Effect.Effect<Examination, never, Examiner> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(options.root);
    const at = (...parts: ReadonlyArray<string>) => path.join(root, factoryDirectory, ...parts);
    const exists = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
    const git = yield* probe(["git", "--version"]);
    const worktree = yield* probe(["git", "-C", root, "rev-parse", "--is-inside-work-tree"]);
    const head = yield* probe(["git", "-C", root, "rev-parse", "--short", "HEAD"]);
    const workflows = (yield* fileSystem
      .readDirectory(at("workflows"))
      .pipe(Effect.orElseSucceed(() => [])))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -3))
      .sort();
    const toolchain = yield* detectPackageManager(root);
    const engine = yield* Effect.sync(engineDependency);
    return {
      root,
      loadable: true,
      findings: [
        runtimeFinding(process.versions.bun),
        repositoryFinding({
          git: successfulOutput(git),
          insideWorkTree: successfulOutput(worktree) === "true",
          head: successfulOutput(head),
        }),
        factoryFinding({
          directory: yield* exists(at()),
          config: yield* exists(at("kojo.config.yaml")),
          commands: yield* exists(at("commands.ts")),
          workflows,
        }),
        dependencyFinding({
          engine,
          runtime: installedPackage(at(), runtimePackage),
          effect: installedPackage(at(), "effect"),
          manager: toolchain.manager,
        }),
      ],
    };
  });
