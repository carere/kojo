// `@effect/platform-bun` by deep path, never its barrel: the barrel re-exports BunRedis and would
// drag a Redis client in behind it.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, type PlatformError, Schema, type Scope } from "effect";
import * as SandcastleSandboxSource from "../../../../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { CurrentRun } from "../../../../../src/contexts/workflow/services/CurrentRun.ts";
import { sandboxed } from "../../../../../src/contexts/workflow/services/sandboxed.ts";
import { ensureImage, sandcastleContainers, testImage } from "../../../../support/dockerImage.ts";
import * as InSandboxAgentInvoker from "../../../../support/InSandboxAgentInvoker.ts";
import * as JsonlTracer from "../../../../support/JsonlTracer.ts";
import { localIsolated } from "../../../../support/localIsolatedProvider.ts";

/**
 * **The acceptance test for waves 4 and 5.**
 *
 * A whole lane — a sandbox around real phases, a real agent process inside the container, the
 * reviewed loop, the durable engine on a SQLite file — started by one process, suspended at a gate
 * with the container torn down, and finished by two further processes that never saw it start.
 *
 * Everything below is spawned. A second layer built inside this process would prove nothing about
 * what survives the process exiting, which is the only claim worth making about durability. The lane
 * itself is `tests/support/durableLane.ts`.
 */

const script = new URL("../../../../support/durableLane.ts", import.meta.url).pathname;

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

/** What one process of the harness reports on its last line of stdout. */
interface Reported {
  readonly runId: string;
  readonly status: string;
  /** Why a failed run failed, read back out of the engine's recorded exit. */
  readonly failure?: string;
  readonly replayToScoutMillis?: number;
  readonly replayInsideSandboxMillis?: number;
  readonly processMillis: number;
}

const inItsOwnProcess = (args: ReadonlyArray<string>): Reported => {
  const finished = spawnSync(bun(), [script, ...args], { encoding: "utf8" });
  if (finished.status !== 0) {
    throw new Error(`durableLane ${args[0]} exited ${finished.status}: ${finished.stderr}`);
  }
  const lines = finished.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Reported;
};

/**
 * The status, with the reason attached when there is one.
 *
 * A run that fails reports the single word `failed`, and an assertion against it says only what was
 * expected. Folding the recorded cause into the compared value means the failure message names the
 * thing that actually went wrong.
 */
const where = (reported: Reported): string =>
  reported.failure === undefined ? reported.status : `${reported.status}: ${reported.failure}`;

interface Fixture {
  readonly config: string;
  readonly trace: string;
  readonly sessions: string;
  readonly repo: string;
  readonly branch: string;
}

const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });

/** A repository with one commit, and an identity, because a worktree commits with the repo's. */
const seedRepository = (repo: string): void => {
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Kojo"]);
  git(repo, ["config", "user.email", "kojo@example.invalid"]);
  git(repo, ["commit", "--quiet", "--allow-empty", "--message", "seed"]);
};

/**
 * Where a fixture repository is allowed to live, and why it is not `os.tmpdir()`.
 *
 * The worktree the sandbox bind-mounts is deleted when the run suspends and created again at the
 * **same host path** on the next acquisition — that reuse is Sandcastle's, not ours: it derives the
 * path from the repo and the branch, and `CreateSandboxOptions` has no override. On macOS the
 * Docker Desktop VM does not always see that second directory: `docker run` succeeds, and the first
 * `docker exec` then dies with `chdir to cwd ("/home/agent/workspace") … no such file or directory`,
 * surfacing as `AgentInvocationError{fault: "provider-failed"}` and exit 127.
 *
 * The rate depends on where the host directory sits. Measured on this machine, three-process docker
 * lanes: **3 of 4 failed** under `$TMPDIR` (`/var/folders/…`), **1 of 6** under `/Users`, **0 of 16**
 * under `/private/tmp`. It is written down as a measurement, not as a theory of the VM.
 *
 * **Revisited by ticket 37, and kept — for a different reason.** It is no longer a mitigation:
 * `sandboxed` now probes the workspace from inside the sandbox and rebuilds the container when it
 * does not answer, so a lane that trips this recovers instead of failing (architecture.md §8, edge
 * 11). What the anchoring still buys is **time**. Each occurrence costs a whole extra container
 * build — roughly 40 s here — and these tests carry a timeout, so a fixture under `$TMPDIR`
 * would turn a 3-in-4 recovery into a suite that times out and reads as a code regression. Kept as a
 * cost measure, not as a correctness one.
 *
 * **The timeout is 480 s, and it is a holding number rather than a calibrated one** — ticket 62.
 *
 * It was 180 s, chosen against the ~40 s build above. Two CI runs on a two-core runner killed a
 * *different* test each time at ~185 s, which read as a limit slightly too small. Raising it made
 * the run pass, and the passing run is what refuted that reading:
 *
 *     ✓ lane.test.ts (8 tests) 53347ms
 *
 * **Fifty-three seconds for the whole file on the same runner.** So the machine is not slow, and a
 * failing single test at 185 s is not slow work — it is `acquire` running the edge-11 recovery to
 * its end, rebuilding up to `containerLimit` (three) containers and losing. The local failure names
 * that exhaustion outright: `WorkspaceUnreachable{… "containers": 3 …}`.
 *
 * So the timeout does not describe how long these tests take. It describes how long a *failed
 * recovery* is allowed to take before something kills it, and 480 s is generous enough not to cut
 * one short. What would make it a real number is the cost of one rebuild on a runner, which nobody
 * has measured — see ticket 62 rather than adjusting it here on a hunch.
 *
 * `/tmp` rather than a platform switch: on macOS it resolves to `/private/tmp`, on Linux it is
 * already the right answer, and anywhere it is missing `os.tmpdir()` is no worse than today.
 */
/**
 * How long one lane test may take, in milliseconds.
 *
 * Not a measurement of the work — the whole file is 53 s when it goes well. It is a ceiling on a
 * *failed* edge-11 recovery, which rebuilds up to three containers before it gives up. See the note
 * above, and ticket 62 for the number that would let this one be chosen rather than held.
 */
const laneTimeout = 480_000;

const fixtureRoot = ((): string => {
  try {
    return realpathSync("/tmp");
  } catch {
    return tmpdir();
  }
})();

/**
 * A fresh repository and the config file the three processes share.
 *
 * A temporary directory, never this repository: a lane commits to its branch, and a suite that did
 * that where it runs would be a suite nobody could run twice.
 */
const fixture = (
  provider: "no-sandbox" | "docker",
  options?: { readonly stampAttempt?: boolean },
): Effect.Effect<Fixture, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      directory: fixtureRoot,
      prefix: "kojo-lane-",
    });
    const repo = `${root}/repo`;

    yield* fileSystem.makeDirectory(repo, { recursive: true });
    yield* Effect.sync(() => seedRepository(repo));

    const fixed: Fixture = {
      config: `${root}/lane.json`,
      trace: `${root}/trace.jsonl`,
      sessions: `${root}/sessions`,
      repo,
      branch: "kojo/lane",
    };

    yield* Effect.sync(() =>
      writeFileSync(
        fixed.config,
        JSON.stringify({
          database: `${root}/kojo.db`,
          trace: fixed.trace,
          sessions: fixed.sessions,
          repo,
          branch: fixed.branch,
          provider,
          imageName: testImage,
          stampAttempt: options?.stampAttempt ?? true,
        }),
      ),
    );

    return fixed;
  });

const inFixture = <A, E>(
  provider: "no-sandbox" | "docker",
  use: (fixed: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem>,
  options?: { readonly stampAttempt?: boolean },
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.flatMap(fixture(provider, options), use).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
  );

/** Start, reject, approve — the three processes, in order, on one fixture. */
const throughTheWholeLane = (fixed: Fixture, subject: string) => {
  const started = inItsOwnProcess(["start", fixed.config, subject]);
  const rejected = inItsOwnProcess([
    "answer",
    fixed.config,
    started.runId,
    "1",
    "reject",
    "say more about the branch",
  ]);
  const approved = inItsOwnProcess([
    "answer",
    fixed.config,
    started.runId,
    "2",
    "approve",
    "that reads fine",
  ]);
  return { started, rejected, approved };
};

/** The envelope the lane's agent prints, decoded so the assertions are on fields. */
const Notes = Schema.Struct({
  finding: Schema.String,
  turn: Schema.Finite,
  session: Schema.String,
  runId: Schema.String,
  sandbox: Schema.String,
  attempt: Schema.String,
});
const decodeNotes = Schema.decodeUnknownSync(Notes);

/** What the agent printed on its first turn, read out of the transcript the agent itself wrote. */
const firstAnswer = (fixed: Fixture) => {
  const scouted = JsonlTracer.read(fixed.trace).phases.find((phase) => phase.name === "scout");
  const line = readFileSync(`${fixed.sessions}/${scouted?.agent?.session}.jsonl`, "utf8").split(
    "\n",
  )[0];
  return decodeNotes(JSON.parse((JSON.parse(line ?? "{}") as { output: string }).output));
};

describe("a lane with a mid-lane gate, across three processes", () => {
  it.live(
    "suspends inside its sandbox, and another process finishes what it started",
    () =>
      inFixture("no-sandbox", (fixed) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          // Process one. The lane is a **top-level workflow**: `start(lane.definition, payload)` is
          // the whole entry point, and nothing wraps it. A lane reachable only as a child of a parent
          // workflow is a lane nobody can re-run after it fails.
          const started = inItsOwnProcess(["start", fixed.config, "alpha"]);
          expect(where(started)).toBe("suspended");

          const first = JsonlTracer.read(fixed.trace);
          expect(first.phases.map((phase) => phase.name)).toEqual(["prepare", "scout"]);

          // The container is gone while the human thinks. `interrupted` is what a suspension looks
          // like from inside the scope and is not a fault — and the worktree it named is gone too.
          expect(first.sandboxes).toHaveLength(1);
          expect(first.sandboxes[0]?.outcome).toBe("interrupted");
          expect(yield* fileSystem.exists(first.sandboxes[0]?.worktreePath ?? "")).toBe(false);

          // The branch is not gone. It is the durable state of the run, and it carries the work
          // `prepare` committed before anybody was asked anything.
          expect(git(fixed.repo, ["show", `${fixed.branch}:notes/subject.md`])).toContain("alpha");

          // Process two rejects. The lane revises and asks again, and the second asking genuinely
          // suspends rather than reading the first verdict back out of a reused deferred.
          const rejected = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "1",
            "reject",
            "say more about the branch",
          ]);
          expect(where(rejected)).toBe("suspended");
          expect(rejected.runId).toBe(started.runId);

          const approved = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "2",
            "approve",
            "that reads fine",
          ]);
          expect(where(approved)).toBe("succeeded");

          const trace = JsonlTracer.read(fixed.trace);

          // One row per phase, however many times the body replayed — and it replayed four times, in
          // three processes. Until now this had only ever been asserted inside one process on the
          // in-memory engine.
          expect(trace.phases.map((phase) => phase.name)).toEqual([
            "prepare",
            "scout",
            "revise",
            "land",
          ]);
          expect(trace.phases.every((phase) => phase.outcome === "succeeded")).toBe(true);
          expect(new Set(trace.phases.map((phase) => phase.phaseId)).size).toBe(4);

          // Two askings, two records, and the reviewer's own words on each. The `lane` in the middle
          // is the enclosing `sandboxed` scope's own name: a gate's durable identity carries the
          // lane it was asked in, so two lanes of one run asking the same gate name are two
          // questions rather than one shared answer (ticket 35).
          expect(trace.gates.map((gate) => gate.asking)).toEqual([
            "gate/lane/review/1",
            "gate/lane/review/2",
          ]);
          expect(trace.gates.map((gate) => gate.choice)).toEqual(["reject", "approve"]);

          // One start, written by the first process, carrying the time the run began rather than the
          // time it was resumed.
          expect(trace.runs).toHaveLength(1);
          expect(trace.runs[0]?.runId).toBe(started.runId);
          expect(trace.outcomes.get(started.runId)).toBe("succeeded");

          // It landed on the branch, having read back what it committed three processes earlier.
          expect(git(fixed.repo, ["show", `${fixed.branch}:notes/finding.md`])).toContain("alpha:");
        }),
      ),
    laneTimeout,
  );

  it.live(
    "leaves one sandbox record per rebuild, each with its own id and its own cost",
    () =>
      inFixture("no-sandbox", (fixed) =>
        Effect.sync(() => {
          const { started } = throughTheWholeLane(fixed, "records");
          const trace = JsonlTracer.read(fixed.trace);

          // **One acquisition per execution of the body.** Stronger than a count: the scope is
          // entered exactly once per replay, so a sandbox held across a suspension and a sandbox
          // silently reused would each break this, in opposite directions.
          expect(trace.sandboxes).toHaveLength(trace.executions.length);
          expect(trace.executions.length).toBeGreaterThanOrEqual(3);

          // Every acquisition is its own row under its own id. Two of these are acquired inside the
          // same process, and under ticket 17's clock-only scheme they could share one.
          expect(new Set(trace.sandboxes.map((row) => row.sandboxId)).size).toBe(
            trace.sandboxes.length,
          );
          expect(trace.sandboxes.every((row) => row.runId === started.runId)).toBe(true);
          expect(trace.sandboxes.every((row) => row.branch === "kojo/lane")).toBe(true);
          expect(trace.sandboxes.every((row) => row.name === "lane")).toBe(true);

          // Torn down by a suspension every time but the last, which was released normally. Each row
          // carries its own life, so the cost of a rebuild is the gap between two of them.
          const outcomes = trace.sandboxes.map((row) => row.outcome);
          expect(outcomes[outcomes.length - 1]).toBe("released");
          expect(outcomes.slice(0, -1).every((outcome) => outcome === "interrupted")).toBe(true);
          expect(trace.sandboxes.every((row) => row.lifetimeMillis >= 0)).toBe(true);

          // A rebuild is a different acquisition, so its correlation differs too. Anything else would
          // join two containers' output onto one row.
          expect(new Set(trace.sandboxes.map((row) => row.environment.KOJO_PHASE_ID)).size).toBe(
            trace.sandboxes.length,
          );
        }),
      ),
    laneTimeout,
  );

  it.live(
    "replays the completed phases in milliseconds, and asks the agent once per asking",
    () =>
      inFixture("no-sandbox", (fixed) =>
        Effect.sync(() => {
          const { rejected, approved } = throughTheWholeLane(fixed, "replay");

          // The window between entering the sandbox and reaching the review, on a **resumed** run.
          // Everything in it is a recorded activity handed back, so it is arithmetic rather than
          // work — a re-executed `prepare` is a git commit and a re-executed `scout` an agent call.
          expect(rejected.replayInsideSandboxMillis).toBeLessThan(250);
          expect(approved.replayInsideSandboxMillis).toBeLessThan(250);

          const trace = JsonlTracer.read(fixed.trace);
          const agents = trace.phases.filter((phase) => phase.kind === "agent");
          expect(agents.map((phase) => phase.name)).toEqual(["scout", "revise"]);

          // The transcript is the independent witness. The agent process appends to it outside the
          // engine's knowledge, so a phase that re-ran on a replay would leave a third turn here even
          // while the trace still showed two rows.
          const session = agents[0]?.agent?.session ?? "";
          expect(InSandboxAgentInvoker.turns(fixed.sessions, session)).toBe(2);

          // And the revision re-entered that same conversation rather than starting cold — across a
          // process restart and a container rebuild.
          expect(agents[1]?.agent?.session).toBe(session);
          expect(agents[0]?.agent?.resumed).toBe(false);
          expect(agents[1]?.agent?.resumed).toBe(true);
        }),
      ),
    laneTimeout,
  );
});

describe("what an agent process can see from inside the sandbox", () => {
  it.live(
    "reads back the run and the acquisition the scope stamped on the container",
    () =>
      inFixture(
        "no-sandbox",
        (fixed) =>
          Effect.sync(() => {
            const started = inItsOwnProcess(["start", fixed.config, "correlation"]);
            const answer = firstAnswer(fixed);
            const trace = JsonlTracer.read(fixed.trace);

            // Read by a process on the far side of two boundaries Effect cannot cross — Sandcastle's
            // own bundled runtime, and the sandbox — and carried back inside the envelope the lane
            // decoded. This is the join, checked rather than claimed.
            expect(answer.runId).toBe(started.runId);
            expect(answer.sandbox).toBe(trace.sandboxes[0]?.sandboxId);

            // The acquisition stamped attempt `0`; this invocation stamped its phase's `1` over it.
            // `SandboxExecOptions` has no `env` and neither has Sandcastle's, so the only door left
            // is an `env NAME=value` prefix on the command line at exec time.
            expect(trace.sandboxes[0]?.environment.KOJO_ATTEMPT).toBe("0");
            expect(answer.attempt).toBe("1");
          }),
        { stampAttempt: true },
      ),
    120000,
  );

  it.live(
    "inherits the acquisition's own attempt when the invocation stamps nothing",
    () =>
      inFixture(
        "no-sandbox",
        (fixed) =>
          Effect.sync(() => {
            inItsOwnProcess(["start", fixed.config, "unstamped"]);
            // Without the override the agent sees what the container was built with: `0`, a number
            // `Activity.CurrentAttempt` can never produce, so it reads as "no phase yet" rather than
            // as a plausible first attempt.
            expect(firstAnswer(fixed).attempt).toBe("0");
          }),
        { stampAttempt: false },
      ),
    120000,
  );
});

const image = ensureImage();

if (!image.ok) {
  console.warn(
    ["NOT PROVEN: the lane on a real Docker container.", `  - ${image.reason}`].join("\n"),
  );
}

describe("the gate on the container test", () => {
  it("names what is missing rather than passing quietly", () => {
    // Always runs, so the file always loads and the skip below is always visible as a skip.
    expect(image.ok || image.reason.length > 0).toBe(true);
  });
});

describe.skipIf(!image.ok)("the same lane in a real container", () => {
  it.live(
    "builds a container, tears it down at the gate, and builds another one on the answer",
    () =>
      inFixture("docker", (fixed) =>
        Effect.sync(() => {
          // Every Sandcastle container on this daemon, before and after. Compared to each other
          // rather than to zero, so a container another suite is holding cancels out.
          const before = sandcastleContainers();

          const started = inItsOwnProcess(["start", fixed.config, "container"]);
          expect(where(started)).toBe("suspended");

          // The central decision of the design, as one question to the Docker daemon: the run is
          // waiting for a human and it is holding no container. A workflow-lifetime scope would
          // leave one running here for as long as the human takes to answer.
          expect(sandcastleContainers()).toEqual(before);

          const first = JsonlTracer.read(fixed.trace);
          expect(first.sandboxes[0]?.provider).toBe("docker");
          expect(first.sandboxes[0]?.kind).toBe("bind-mount");
          expect(first.sandboxes[0]?.outcome).toBe("interrupted");

          // The agent ran inside the container and read the correlation out of its environment.
          const answer = firstAnswer(fixed);
          expect(answer.runId).toBe(started.runId);
          expect(answer.sandbox).toBe(first.sandboxes[0]?.sandboxId);

          const rejected = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "1",
            "reject",
            "say more",
          ]);
          expect(where(rejected)).toBe("suspended");
          expect(sandcastleContainers()).toEqual(before);

          const approved = inItsOwnProcess([
            "answer",
            fixed.config,
            started.runId,
            "2",
            "approve",
            "good",
          ]);
          expect(where(approved)).toBe("succeeded");
          expect(sandcastleContainers()).toEqual(before);

          const trace = JsonlTracer.read(fixed.trace);
          expect(trace.phases.map((phase) => phase.name)).toEqual([
            "prepare",
            "scout",
            "revise",
            "land",
          ]);
          // **One container carried each execution of the body** — the invariant, restated so it
          // survives edge 11 firing for real.
          //
          // Ticket 19 wrote this as `sandboxes.length === executions.length`, and it failed here
          // on the first run after ticket 37 with five rows against four executions. Nothing
          // regressed: the workspace probe found a container it could not work in, threw it away
          // and built another, which is the recovery. A discarded container is recorded `failed`,
          // and in a run that **succeeded** a `failed` sandbox row can be nothing else — an
          // acquisition that genuinely failed would have taken the run down with it. So the count
          // is asserted on the containers that carried an execution, and the discarded ones are
          // asserted to be exactly that.
          const carried = trace.sandboxes.filter((row) => row.outcome !== "failed");
          expect(where(approved)).toBe("succeeded");
          expect(carried).toHaveLength(trace.executions.length);
          expect(new Set(trace.sandboxes.map((row) => row.sandboxId)).size).toBe(
            trace.sandboxes.length,
          );
          expect(trace.sandboxes.every((row) => row.provider === "docker")).toBe(true);

          // The replay still costs milliseconds. What a container adds is the rebuild, and that is
          // the sandbox rows' own business — measured there, in their lifetimes.
          expect(rejected.replayInsideSandboxMillis).toBeLessThan(250);
          expect(approved.replayInsideSandboxMillis).toBeLessThan(250);

          // And the branch carried the work across three containers.
          expect(git(fixed.repo, ["show", `${fixed.branch}:notes/finding.md`])).toContain(
            "container:",
          );
        }),
      ),
    300_000,
  );
});

describe("a sandbox scope on an isolated provider", () => {
  it.live(
    "hands the region the exec workspace, because there is no host tree to name",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-isolated-lane-" });
        const trace = `${root}/trace.jsonl`;
        yield* fileSystem.makeDirectory(`${root}/repo`, { recursive: true });
        yield* Effect.sync(() => seedRepository(`${root}/repo`));

        yield* sandboxed(
          {
            name: "isolated",
            branch: "kojo/isolated-lane",
            provider: localIsolated(),
            cwd: `${root}/repo`,
          },
          Effect.gen(function* () {
            const workspace = yield* Workspace;

            // The branch under test. `SandcastleSandboxSource.workspace` dispatches on the kind Kojo
            // tagged the provider with, and an isolated sandbox has no host path to hand back — so
            // `None` here is the proof that `sandboxed` chose `SandboxExecWorkspace`. Until now only
            // the adapter had been exercised directly; the choice never had been.
            expect(workspace.hostPath).toEqual(Option.none());

            yield* workspace.write("src/built.ts", "export const built = true\n");
            expect(yield* workspace.read("src/built.ts")).toBe("export const built = true\n");
          }),
        ).pipe(
          Effect.provideService(CurrentRun, { runId: "run-isolated" as RunId }),
          Effect.provide(
            Layer.mergeAll(
              JsonlTracer.layer(trace),
              SandcastleSandboxSource.layer.pipe(Layer.provide(BunServices.layer)),
            ),
          ),
        );

        // One acquisition, released cleanly, and Kojo recorded it as isolated.
        const recorded = JsonlTracer.read(trace).sandboxes;
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.kind).toBe("isolated");
        expect(recorded[0]?.outcome).toBe("released");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    120000,
  );
});
