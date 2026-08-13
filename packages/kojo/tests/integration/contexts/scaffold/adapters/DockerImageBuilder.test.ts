// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";
import * as DockerImageBuilder from "../../../../../src/contexts/scaffold/adapters/DockerImageBuilder.ts";
import { ImageBuilder } from "../../../../../src/contexts/scaffold/ports/ImageBuilder.ts";

/**
 * The real builder, against a real daemon.
 *
 * **What this file proves and what it does not.** It proves the adapter: that it spells the command
 * line the way `docker build` wants it, that it passes the uid and gid build args the sandbox
 * provider then checks, that a build which fails surfaces the daemon's own words, and that a
 * missing binary is reported as a missing binary rather than as a build failure.
 *
 * It does **not** prove that the Dockerfile `kojo init` stamps builds. That image pulls
 * `node:22-bookworm` and installs an agent CLI over the network — minutes, and a different answer
 * on a machine with no route out — so it is not something a suite can hold an opinion about. What
 * the stamped Dockerfile contains is graded by the unit tests beside `plan.ts`; whether it builds
 * is a measurement, recorded in the ticket rather than asserted here.
 */
const dockerIsThere = ((): boolean => {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

/** Two lines, from scratch. Nothing is pulled, so this measures the adapter and not the network. */
const trivial = ["FROM scratch", 'LABEL kojo.test="image-builder"', ""].join("\n");

const withDockerfile = <A, E>(
  content: string,
  use: (options: {
    readonly dockerfile: string;
    readonly context: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "kojo-image-" })
      .pipe(Effect.orDie);
    const dockerfile = path.join(root, "Dockerfile");
    yield* fileSystem.writeFileString(dockerfile, content).pipe(Effect.orDie);
    return yield* use({ dockerfile, context: root });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const tag = "kojo-test:image-builder";

describe.skipIf(!dockerIsThere)("building an image through the real adapter", () => {
  it.effect("builds what it is pointed at, and tags it what it was told", () =>
    withDockerfile(trivial, (paths) =>
      Effect.gen(function* () {
        const builder = yield* ImageBuilder;
        const outcome = yield* builder
          .build({ imageName: tag, ...paths, uid: 1000, gid: 1000 })
          .pipe(Effect.result);

        expect(Result.isSuccess(outcome), JSON.stringify(outcome)).toBe(true);

        // Asked of Docker rather than of the adapter's return value: an adapter that reported
        // success without building would pass every assertion it could make about itself.
        const inspected = yield* Effect.sync(() =>
          execFileSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], {
            encoding: "utf8",
          }),
        );
        expect(inspected.trim().length).toBeGreaterThan(0);

        yield* Effect.sync(() =>
          execFileSync("docker", ["image", "rm", "--force", tag], { stdio: "pipe" }),
        );
      }).pipe(Effect.provide(DockerImageBuilder.layer().pipe(Layer.provide(BunServices.layer)))),
    ),
  );

  it.effect("carries the uid and gid the provider will check the image against", () =>
    withDockerfile(
      ["FROM scratch", "ARG AGENT_UID=1", "ARG AGENT_GID=1", 'LABEL uid="$AGENT_UID"', ""].join(
        "\n",
      ),
      (paths) =>
        Effect.gen(function* () {
          const builder = yield* ImageBuilder;
          yield* builder
            .build({ imageName: tag, ...paths, uid: 4242, gid: 4243 })
            .pipe(Effect.orDie);

          // Sandcastle starts containers as `--user <host uid>:<host gid>` and refuses an image
          // built for a different one, so the build args are not decoration — an image built with
          // the base's 1000 on a machine whose user is 501 cannot write the bind-mounted worktree.
          const label = yield* Effect.sync(() =>
            execFileSync(
              "docker",
              ["image", "inspect", tag, "--format", '{{index .Config.Labels "uid"}}'],
              { encoding: "utf8" },
            ),
          );
          expect(label.trim()).toBe("4242");

          yield* Effect.sync(() =>
            execFileSync("docker", ["image", "rm", "--force", tag], { stdio: "pipe" }),
          );
        }).pipe(Effect.provide(DockerImageBuilder.layer().pipe(Layer.provide(BunServices.layer)))),
    ),
  );

  it.effect("hands back what the daemon said when a build fails", () =>
    withDockerfile(["FROM scratch", "RUN this-is-not-a-command", ""].join("\n"), (paths) =>
      Effect.gen(function* () {
        const builder = yield* ImageBuilder;
        const outcome = yield* builder
          .build({ imageName: tag, ...paths, uid: 1000, gid: 1000 })
          .pipe(Effect.result);

        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(outcome.failure.operation).toBe("build");
          expect(outcome.failure.target).toBe(tag);
          // The tail of the log, not a wrapper. The line that says why is always near the end,
          // and a failure that dropped it would send a person back to run the build by hand.
          expect(outcome.failure.reason).toContain("build exited");
          expect(outcome.failure.reason.length).toBeGreaterThan("build exited 1: ".length);
        }
      }).pipe(Effect.provide(DockerImageBuilder.layer().pipe(Layer.provide(BunServices.layer)))),
    ),
  );
});

describe("building an image with no runtime to build it", () => {
  it.effect("says the runtime could not be run, rather than blaming the Dockerfile", () =>
    withDockerfile(trivial, (paths) =>
      Effect.gen(function* () {
        const builder = yield* ImageBuilder;
        const outcome = yield* builder
          .build({ imageName: tag, ...paths, uid: 1000, gid: 1000 })
          .pipe(Effect.result);

        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(outcome.failure.reason).toContain("could not be run");
        }
      }).pipe(
        // A container command that is not there. `kojo init --sandbox docker` on a machine with no
        // Docker is an ordinary mistake, and the answer to it must name the missing binary rather
        // than print a build log that does not exist.
        Effect.provide(
          DockerImageBuilder.layer({
            command: "kojo-no-such-container-runtime" as DockerImageBuilder.ContainerCommand,
          }).pipe(Layer.provide(BunServices.layer)),
        ),
      ),
    ),
  );
});
