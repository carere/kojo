// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import * as InMemoryImageBuilder from "../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import { initialise } from "../../../src/contexts/scaffold/services/initialise.ts";
import { thisEngine } from "../../support/engineDependency.ts";

/**
 * **The walk-through this ticket came from, as a test.**
 *
 * Every other test of the scaffolder asks whether a stamped factory runs. This one asks the only
 * question the whole design is for: *does the work land*. It stamps a factory into an empty
 * repository, edits the one file a person has to edit, runs the workflow with an agent that really
 * writes a file, watches the run suspend, answers the gate from a second process, and then goes and
 * looks at **`main`**.
 *
 * The assertion is on the trunk holding the commit — not on a phase table saying a merge phase
 * succeeded. Ticket 30's integrator had a green suite and a `main` that had never moved, so a run
 * that reports success is exactly the evidence this test refuses to accept.
 *
 * Two runs, because the second is the one a person hits next: a rejected run must merge *nothing*
 * and leave its branch where it is.
 */
const cli = new URL("../../../src/main.ts", import.meta.url).pathname;
const packageRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/** The Bun running this test, which is what the child must also be — the CLI reaches `bun:sqlite`. */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One whole `kojo` process, launched from inside the target repository, the way a person does. */
const kojo = (root: string, args: ReadonlyArray<string>, path: string): Effect.Effect<Ran> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: path } as NodeJS.ProcessEnv,
    });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

const succeeded = (ran: Ran): string => {
  if (ran.status !== 0) {
    throw new Error(`kojo exited ${ran.status}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  }
  return ran.stdout;
};

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

const runIdOf = (stdout: string): string => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("run "));
  return (line ?? "").slice("run ".length).trim();
};

/** The token, read out of `kojo gate list` exactly as a person reads it. */
const tokenOf = (listing: string, runId: string): string => {
  const row = listing.split("\n").find((candidate) => candidate.includes(runId));
  const cells = (row ?? "").trim().split(/\s+/);
  return cells[cells.length - 1] ?? "";
};

/** What the agent writes, and what its envelope therefore has to claim. */
const licence = "LICENCE-HEADER.md";
const summary = "add a licence header";

/**
 * A `claude` that is a shell script.
 *
 * The stamped `review` wires `SandcastleAgentInvoker` with the stock Claude Code provider, so the
 * binary the run reaches for is `claude` on the child's `PATH`. Putting a script there is what makes
 * this test the *whole* loop at no cost: `buildPrintCommand` is real, the prompt arrives on stdin,
 * the process runs in the worktree the sandbox scope cut, and `parseStreamJsonLine` reads the two
 * lines below exactly as it reads a model's.
 *
 * Both lines are load-bearing. The `system`/`init` line carries the session id, and an answer with
 * no session is refused by the invoker as `provider-failed` — the transcript is named after the id,
 * so there is no second chance to learn it. The `result` line carries the envelope, which is what
 * `envelopeBlock` narrows and the phase decodes.
 *
 * The file it writes is the file the envelope claims, because `diffMatchesClaims` goes and looks:
 * a path claimed and unchanged is a fault, and so is a path changed and unclaimed.
 */
const fakeClaude = [
  "#!/bin/sh",
  "# Drain the prompt. A provider that leaves stdin unread gives the writer a broken pipe.",
  "cat > /dev/null",
  `printf '%s\\n' "A licence header, as asked for." > ${licence}`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"scripted-cold"}'`,
  `printf '%s\\n' '{"type":"result","result":"{\\"_tag\\":\\"Drafted\\",\\"summary\\":\\"${summary}\\",\\"files\\":[\\"${licence}\\"]}"}'`,
  "",
].join("\n");

/**
 * `commands.ts` with the placeholders replaced — **the edit the README tells a person to make first**.
 *
 * It is not a shortcut around the test. A freshly stamped factory refuses to land anything on
 * purpose: `commands.test` prints `KOJO-PLACEHOLDER` and exits 78, so the mechanical half of the
 * acceptance says no and no approval can outvote it. A run that merges is a run whose author has
 * done this, so a test of the merge has to do it too.
 */
const editedCommands = [
  'import { isPlaceholder } from "kojo/contexts/scaffold/models/Placeholder";',
  "",
  "export const commands = {",
  '  install: "true",',
  '  test: "true",',
  '  lint: "true",',
  '  build: "true",',
  "} as const;",
  "",
  "export const survivingPlaceholders = (): ReadonlyArray<string> =>",
  "  Object.entries(commands)",
  "    .filter(([, command]) => isPlaceholder(command))",
  "    .map(([name]) => name);",
  "",
].join("\n");

/**
 * A repository with a factory in it, a trunk called `main`, and an agent on its `PATH`.
 *
 * `--initial-branch=main` rather than whatever this machine's git defaults to, because the stamped
 * workflow's `trunk` constant is `main` and the merge refuses any other branch by name. That refusal
 * is the correct behaviour and it is graded further down; here it would only make the test about the
 * tester's git configuration.
 *
 * `--sandbox none` is a real answer, not an opt-out: the scope still cuts the branch and still hands
 * the phases a workspace, on this machine instead of in a container. What Docker would add is
 * isolation, and isolation is not what is under test.
 */
const stamped = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-lands-" })
    .pipe(Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["init", "--quiet", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Kojo"]);
    git(root, ["config", "user.email", "kojo@example.invalid"]);
  });

  yield* fileSystem
    .writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({ name: "kojo-target", type: "module" }, undefined, 2),
    )
    .pipe(Effect.orDie);
  // `node_modules` and nothing else — deliberately. Sandcastle writes its logs and its worktrees
  // into `.sandcastle/` in this repository, and the merge refuses a trunk with untracked files in
  // it, so a `.gitignore` naming `.sandcastle` here would hide the fault ticket 45 found by hand.
  // What keeps it out of `git status` is the `.gitignore` holding `*` that the sandbox source writes
  // inside that directory; delete that and this test fails with "main holds uncommitted changes".
  yield* fileSystem
    .writeFileString(path.join(root, ".gitignore"), "node_modules\n")
    .pipe(Effect.orDie);

  yield* initialise({
    root,
    agent: "claude-code",
    model: "claude-opus-4-8",
    sandbox: "none",
    template: "review",
    // Ticket 44's member, which this file was written before. `initialise` now merges the two
    // entries a stamped factory needs into the manifest above, and `thisEngine()` is the same pair
    // `kojo init` computes — so the `package.json` this repository commits declares the very engine
    // the `node_modules` links below point at, and the loader's duplicate-`effect` guard sees one
    // copy rather than refusing the run before it starts.
    engine: thisEngine(),
    uid: 1000,
    gid: 1000,
    skipImage: true,
  }).pipe(Effect.provide(InMemoryImageBuilder.layer), Effect.orDie);

  // The one edit the stamped README asks for, before the first commit — so the branch every run
  // forks from carries a factory that can actually accept something.
  yield* fileSystem
    .writeFileString(path.join(root, ".kojo", "commands.ts"), editedCommands)
    .pipe(Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", "stamp a factory"]);
  });

  // What `bun install` leaves a target repository holding. Symlinks rather than copies, so the
  // engine under test is the engine the stamped file's `kojo/...` imports resolve to.
  yield* fileSystem
    .makeDirectory(path.join(root, "node_modules"), { recursive: true })
    .pipe(Effect.orDie);
  yield* Effect.sync(() => {
    const link = (from: string, to: string) => {
      if (!existsSync(to)) symlinkSync(from, to);
    };
    link(packageRoot, path.join(root, "node_modules", "kojo"));
    for (const dependency of ["effect", "@ai-hero", "@effect", "@types"]) {
      link(
        path.join(packageRoot, "node_modules", dependency),
        path.join(root, "node_modules", dependency),
      );
    }
  });

  // **Outside the repository, and that is not tidiness.** The merge refuses a trunk with untracked
  // files on it, so a `bin/` of the test's own inside `root` would make this suite fail for a
  // reason that belongs to the suite rather than to the engine — which is exactly the class of
  // fault a test like this exists to find, so it must not be able to manufacture one.
  const binary = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-agent-bin-" })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(path.join(binary, "claude"), fakeClaude).pipe(Effect.orDie);
  yield* Effect.sync(() => {
    execFileSync("chmod", ["+x", path.join(binary, "claude")]);
  });

  // `/usr/bin:/bin` still carries `git` and `sh`, which the sandbox scope needs.
  return { root, path: `${binary}:/usr/bin:/bin:/usr/sbin:/sbin` };
});

const inStampedRepository = <A, E>(
  use: (factory: {
    readonly root: string;
    readonly path: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.flatMap(stamped, use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Every subject line on the branch, newest first. */
const subjects = (root: string, ref: string): ReadonlyArray<string> =>
  git(root, ["log", ref, "--format=%s"]).trim().split("\n");

describe("a stamped factory landing the branch it made", () => {
  it.live("merges the run's branch onto the trunk once a human approves", () =>
    inStampedRepository(({ root, path }) =>
      Effect.gen(function* () {
        const before = git(root, ["rev-parse", "main"]).trim();

        const started = succeeded(yield* kojo(root, ["run", "review", summary], path));
        const runId = runIdOf(started);
        const branch = `kojo/${runId}`;

        expect(runId).not.toBe("");
        // The run let go of everything and is waiting. Nothing has merged yet, and the process that
        // started it has already exited.
        expect(started).toContain('suspended at gate "approve"');
        expect(git(root, ["rev-parse", "main"]).trim()).toBe(before);

        // The work is on the run's own branch, and the branch is named after the run — which is what
        // `merge` looks for and what a failed run's report would name.
        expect(git(root, ["branch", "--list", "--format=%(refname:short)"])).toContain(branch);
        expect(subjects(root, branch)[0]).toBe(summary);

        // A second process, holding nothing but the token. It has to load `.kojo/workflows/review.ts`
        // to replay the body, and the replay is what reaches the merge.
        const listing = succeeded(yield* kojo(root, ["gate", "list"], path));
        const answered = succeeded(
          yield* kojo(
            root,
            ["gate", "answer", tokenOf(listing, runId), "--choice", "approve", "--as", "kevin"],
            path,
          ),
        );

        expect(answered).toContain(`recorded approve on run ${runId}`);
        expect(answered).toContain("run succeeded");

        // **The assertion the whole ticket is about.** Not that a merge phase succeeded — that the
        // trunk holds the commit the agent's work went into.
        const landed = subjects(root, "main");
        expect(landed).toContain(summary);
        expect(landed[0]).toContain(`Merge branch '${branch}'`);
        expect(git(root, ["rev-parse", "main"]).trim()).not.toBe(before);

        // And the file itself, on the trunk, with the content the agent wrote.
        expect(git(root, ["show", `main:${licence}`])).toContain("A licence header");

        // A code phase, by name, in the table the answering process printed. An agent never runs a
        // merge and there is no shape of the API that lets one.
        expect(answered).toMatch(/^merge\s+(\S+\s+)?code\s/m);
      }),
    ),
  );

  /**
   * **The case a person hits second.**
   *
   * A rejected run must land nothing and leave the branch alone: the branch is the inspection
   * surface, so deleting it is the failure. The run fails with `NotAccepted`, which is the merge
   * refusing before a single git command runs — there is no half-merge to unpick and no trunk to
   * reset.
   */
  it.live("merges nothing when the human says no, and leaves the branch where it is", () =>
    inStampedRepository(({ root, path }) =>
      Effect.gen(function* () {
        const before = git(root, ["rev-parse", "main"]).trim();

        const started = succeeded(
          yield* kojo(root, ["run", "review", "a change nobody wants"], path),
        );
        const runId = runIdOf(started);
        const branch = `kojo/${runId}`;

        expect(started).toContain('suspended at gate "approve"');

        const listing = succeeded(yield* kojo(root, ["gate", "list"], path));
        const answered = yield* kojo(
          root,
          [
            "gate",
            "answer",
            tokenOf(listing, runId),
            "--choice",
            "reject",
            "--reason",
            "not this week",
            "--as",
            "kevin",
          ],
          path,
        );

        // The verdict was still recorded — the run failing is not the answer failing.
        expect(answered.stdout).toContain(`recorded reject on run ${runId}`);
        expect(answered.status).not.toBe(0);
        expect(answered.stderr).toContain("NotAccepted");

        // Nothing merged: the trunk is the commit it was, and the file the agent wrote is not on it.
        expect(git(root, ["rev-parse", "main"]).trim()).toBe(before);
        expect(subjects(root, "main")).toEqual(["stamp a factory"]);
        expect(() => git(root, ["show", `main:${licence}`])).toThrow();

        // The branch and its commit are still there to check out and look at. Deleting them is the
        // failure, not the cleanup: they are the whole inspection surface a rejected run leaves.
        expect(git(root, ["branch", "--list", "--format=%(refname:short)"])).toContain(branch);
        expect(subjects(root, branch)[0]).toBe(summary);
        expect(git(root, ["show", `${branch}:${licence}`])).toContain("A licence header");
      }),
    ),
  );
});
