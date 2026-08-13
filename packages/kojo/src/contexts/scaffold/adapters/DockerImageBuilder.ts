import { Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ScaffoldError } from "../models/ScaffoldError.ts";
import { ImageBuilder, type ImageRequest } from "../ports/ImageBuilder.ts";

/**
 * What the builder is, and what it names itself.
 *
 * `podman` speaks the same command line for `build`, which is the only subcommand this adapter
 * uses, so one adapter covers both providers. Anything beyond `build` would not be safe to share.
 */
export type ContainerCommand = "docker" | "podman";

const argvFor = (command: ContainerCommand, request: ImageRequest): ReadonlyArray<string> => [
  command,
  "build",
  "--file",
  request.dockerfile,
  "--tag",
  request.imageName,
  // Sandcastle's Docker provider passes `--user <host uid>:<host gid>` and refuses a container
  // whose image was built for a different one. These two args are what make the image match the
  // machine that built it.
  "--build-arg",
  `AGENT_UID=${request.uid}`,
  "--build-arg",
  `AGENT_GID=${request.gid}`,
  request.context,
];

/**
 * The real builder: one `docker build`, with the output kept.
 *
 * The output is kept and attached to the error rather than streamed to the terminal. A build that
 * fails does so hundreds of lines in, and the line that matters is near the end — so the failure
 * carries the tail of what the daemon said, and a build that succeeds says nothing at all.
 */
export const make = (options?: { readonly command?: ContainerCommand }) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = options?.command ?? "docker";

    return {
      build: (request: ImageRequest): Effect.Effect<void, ScaffoldError> => {
        const argv = argvFor(command, request);
        const [head, ...rest] = argv;

        return Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(head ?? command, rest, { extendEnv: true }),
          );

          // Both pipes concurrently, for the reason `BindMountWorkspace` gives: a build that fills
          // the pipe nobody is reading blocks forever, and a container build is the chattiest
          // command in this codebase.
          const [stdout, stderr] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 2 },
          );
          const exitCode = yield* handle.exitCode;

          if (exitCode !== 0) {
            return yield* new ScaffoldError({
              operation: "build",
              target: request.imageName,
              reason: `${command} build exited ${exitCode}: ${tail(stderr === "" ? stdout : stderr)}`,
              cause: undefined,
            });
          }
        }).pipe(
          Effect.scoped,
          // The one error that is not about the build: the runtime is not installed, or not on the
          // PATH. A person who ran `kojo init --sandbox docker` on a machine with no Docker gets
          // told that, rather than a build log that does not exist.
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(
              new ScaffoldError({
                operation: "build",
                target: request.imageName,
                reason: `${command} could not be run: ${cause.message}`,
                cause,
              }),
            ),
          ),
        );
      },
    } satisfies ImageBuilder["Service"];
  });

/** The last few lines of a build log — where the reason a build failed always is. */
const tail = (output: string): string => output.trim().split("\n").slice(-12).join("\n");

/** The reference `ImageBuilder`. `kojo init` provides it; `podman` is the same command line. */
export const layer = (options?: {
  readonly command?: ContainerCommand;
}): Layer.Layer<ImageBuilder, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ImageBuilder, make(options));
