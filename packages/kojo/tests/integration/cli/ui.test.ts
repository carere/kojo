// Deep path, never the package barrel: the barrel re-exports BunRedis, which imports the `bun`
// builtin and would end this worker before a single test ran.
import { spawn, spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, type PlatformError } from "effect";

/**
 * `kojo ui` as a process: one command, one port, the API and the page together.
 *
 * A real child every time, because what is being graded is the **command** — the flags, the layers
 * it builds in each of its two shapes, and the fact that a browser can reach both halves of it on
 * one port. None of that is exercised by testing the router, which is where every other test of the
 * Console lives.
 *
 * Two shapes, because a Console has two: a repository with a factory in it, and one without. The
 * second is the one console.md §10 cares about — it must serve and say what to run, not fail.
 */

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;

const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

/** A port nothing else in this suite is using. Loopback, and thrown away with the process. */
const somePort = (): number => 30_000 + Math.floor(Math.random() * 9_000);

/**
 * The Console, running, with its own port — and shut down whichever way the test ends.
 *
 * The startup line is waited for rather than a sleep: `Bun.serve` binds before the command prints,
 * so the line is the earliest moment a request can succeed, and a fixed sleep would be either flaky
 * or slow.
 */
const running = <A, E>(
  args: ReadonlyArray<string>,
  use: (base: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const port = somePort();
      const child = spawn(bun(), [cli, "ui", "--port", String(port), ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child, port };
    }),
    ({ child, port }) =>
      Effect.gen(function* () {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("kojo ui never said it was listening")),
                20_000,
              );
              child.stdout?.on("data", (chunk: Buffer) => {
                if (chunk.toString().includes(`http://localhost:${port}`)) {
                  clearTimeout(timer);
                  resolve();
                }
              });
              child.on("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`kojo ui exited ${code} before it listened`));
              });
            }),
        );
        return yield* use(`http://127.0.0.1:${port}`);
      }),
    ({ child }) =>
      Effect.sync(() => {
        child.kill("SIGTERM");
      }),
  );

interface Answered {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

const gets = (url: string): Effect.Effect<Answered> =>
  Effect.promise(async () => {
    const response = await fetch(url);
    return {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      body: await response.text(),
    };
  });

const onOwnFile = <A, E>(
  use: (database: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-ui-cli-" });
    return yield* use(`${root}/kojo.db`);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("a repository with no factory in it", () => {
  it.live("serves, and says what to run", () =>
    onOwnFile((database) =>
      running(["--database", database], (base) =>
        Effect.gen(function* () {
          const health = yield* gets(`${base}/api/health`);
          expect(health.status).toBe(200);

          const body = JSON.parse(health.body);
          expect(body.factory).toBe("absent");
          expect(body.database).toBe(database);
          expect(body.notice).toBe("No factory in this repo. Run `kojo init`.");
          expect(body.runner).toBe("none");

          // Every list answers *nothing yet* rather than failing, which is the difference between a
          // message and an error page.
          const runs = yield* gets(`${base}/api/runs`);
          expect(runs.status).toBe(200);
          expect(JSON.parse(runs.body)).toEqual([]);

          // And the page is served from the same process, on the same port, for a deep link.
          const deep = yield* gets(`${base}/runs/r1.2/phases/draft.1`);
          expect(deep.status).toBe(200);
          expect(deep.type).toContain("text/html");
        }),
      ),
    ).pipe(Effect.orDie),
  );

  it.live("opens nothing, so looking never creates a factory", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        yield* running(["--database", database], (base) =>
          Effect.map(gets(`${base}/api/health`), (health) => expect(health.status).toBe(200)),
        );

        // The driver creates the file it is pointed at. A Console that opened the database to find
        // out whether a factory exists would answer the question by creating one.
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.exists(database)).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    ).pipe(Effect.orDie),
  );
});

/** `run <id>` is the first line `kojo run` prints, and the id is what the Console is asked for. */
const runIdOf = (stdout: string): string => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("run "));
  return (line ?? "").slice("run ".length).trim();
};

/** One whole `kojo run`, from a directory of its own, the way a person starts one. */
const started = (database: string): string => {
  const ran = spawnSync(bun(), [cli, "run", "demo-review", "the change", "--database", database], {
    encoding: "utf8",
  });
  if (ran.status !== 0) {
    throw new Error(`kojo run exited ${ran.status}\n${ran.stdout}\n${ran.stderr}`);
  }
  return ran.stdout ?? "";
};

describe("a repository with a suspended run in it", () => {
  /**
   * **The whole seam, end to end**: the command wrote the trace, and the Console reads it back.
   *
   * Nothing is seeded here. A real `kojo run` in its own process produces the run and exits; a real
   * `kojo ui` in another process opens the file that run left behind and answers `/api/runs` over
   * HTTP. Before the CLI wired `SqliteTracer`, this file held no trace at all: health said
   * `schema: "unwritten"` with nothing applied, and this endpoint answered 503 `trace-unreadable`.
   */
  it.live("serves the run `kojo run` actually produced, from the file that run wrote", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const runId = runIdOf(yield* Effect.sync(() => started(database)));
        expect(runId).not.toBe("");

        return yield* running(["--database", database], (base) =>
          Effect.gen(function* () {
            // The schema exists because a *command* created it, not because a test migrated it.
            const health = JSON.parse((yield* gets(`${base}/api/health`)).body);
            expect(health.schemaApplied).toBe(health.schemaExpected);
            expect(health.schemaApplied).toBeGreaterThan(0);
            expect(health.schema).toBe("current");

            const runs = yield* gets(`${base}/api/runs`);
            expect(runs.status).toBe(200);

            const listed = JSON.parse(runs.body);
            expect(listed).toHaveLength(1);
            // The run id the command printed, coming back out of the HTTP response.
            expect(listed[0].run.runId).toBe(runId);
            expect(listed[0].run.workflow).toBe("demo-review");
            // The run stopped for a human and said so on its own row, which is the state a
            // Console has to be able to draw.
            expect(listed[0].outcome).toBe("suspended");
          }),
        );
      }),
    ).pipe(Effect.orDie),
  );

  it.live("serves the gate queue the run left behind", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        // A real run, in a real process, that exits while it waits on a human.
        const started = spawnSync(
          bun(),
          [cli, "run", "demo-review", "the change", "--database", database],
          { encoding: "utf8" },
        );
        if (started.status !== 0) {
          throw new Error(`kojo run exited ${started.status}\n${started.stderr}`);
        }

        return yield* running(["--database", database], (base) =>
          Effect.gen(function* () {
            const health = yield* gets(`${base}/api/health`);
            const body = JSON.parse(health.body);
            expect(body.factory).toBe("present");
            // The run's own process is gone, and this one registered nothing. Nobody is running.
            expect(body.runner).toBe("none");

            const gates = yield* gets(`${base}/api/gates`);
            expect(gates.status).toBe(200);
            const queue = JSON.parse(gates.body);
            expect(queue).toHaveLength(1);
            expect(queue[0].request.gate).toBe("approve");
            expect(queue[0].request.actor).toBe("engineer");
            expect(queue[0].verdict).toBeUndefined();
          }),
        );
      }),
    ).pipe(Effect.orDie),
  );
});
