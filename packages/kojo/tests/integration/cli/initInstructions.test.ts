// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync, spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

/**
 * **`kojo init`'s printed instructions, followed literally, all the way to the merge.**
 *
 * This is ticket 47's acceptance test, and its whole reason to exist is what it does *not* do:
 * it builds no fixture. Every other test of the scaffolder hand-writes the `.gitignore`, hand-links
 * `node_modules`, and calls `initialise` in process — which is exactly why nobody saw that a
 * factory stamped, installed and run **as instructed** could not reach its merge. The install init
 * told the person to run left `node_modules/` untracked, and the first approved run refused with
 * `MergeRefused: main holds uncommitted changes` — over the very directory init created the need
 * for. Found by walking the printed instructions on a fresh repository, which is what this test
 * does forever after:
 *
 * 1. `kojo init`, as a child process, on a fresh repository — the way a person runs it.
 * 2. The install — **parsed out of init's own stdout** and executed verbatim, so the command under
 *    test is the command a person reads, not this file's opinion of it.
 * 3. The one edit the instructions ask for: real commands in `.kojo/commands.ts`.
 * 4. The commit — also parsed out of init's stdout and executed verbatim.
 * 5. `kojo doctor`, which the instructions say is how you know the factory can run.
 * 6. `kojo run` → suspend → `kojo gate answer` → the merge — and then a look at `main`.
 *
 * `--package-manager bun` is init's own flag, passed because this suite runs on a Bun machine and
 * a fresh repository has no lockfile to detect from; the instruction the test then follows is
 * whatever init printed for that answer.
 */
const cli = new URL("../../../src/main.ts", import.meta.url).pathname;

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
const kojo = (
  root: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
): Effect.Effect<Ran> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      ...(env === undefined ? {} : { env: { ...process.env, ...env } as NodeJS.ProcessEnv }),
    });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

/** One instructed command, run through `sh` exactly as printed. */
const instructed = (root: string, command: string): Ran => {
  const finished = spawnSync("sh", ["-c", command], { cwd: root, encoding: "utf8" });
  return {
    status: finished.status,
    stdout: finished.stdout ?? "",
    stderr: finished.stderr ?? "",
  };
};

const succeeded = (what: string, ran: Ran): string => {
  if (ran.status !== 0) {
    throw new Error(`${what} exited ${ran.status}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  }
  return ran.stdout;
};

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

/**
 * The numbered next-steps, read out of `kojo init`'s stdout exactly as a person reads them.
 *
 * The steps' *commands* are what this test executes, so a step that stops being executable — a
 * `git commit` that opens an editor, an install that fails on the manifest init just wrote — fails
 * here rather than in somebody's terminal.
 */
const stepsOf = (stdout: string): ReadonlyArray<string> =>
  [...stdout.matchAll(/^ {2}\d+\. (.+)$/gm)].map((match) => (match[1] ?? "").trim());

/** What the agent writes, and what its envelope therefore has to claim. */
const licence = "LICENCE-HEADER.md";
const summary = "add a licence header";

/**
 * A `claude` that is a shell script — the same one `landsOnTrunk.test.ts` explains at length.
 * The loop under test here is init's instructions, not the model; the provider plumbing (prompt on
 * stdin, session id, envelope on the `result` line) is all real.
 */
const fakeClaude = [
  "#!/bin/sh",
  "cat > /dev/null",
  `printf '%s\\n' "A licence header, as asked for." > ${licence}`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"scripted-init"}'`,
  `printf '%s\\n' '{"type":"result","result":"{\\"_tag\\":\\"Drafted\\",\\"summary\\":\\"${summary}\\",\\"files\\":[\\"${licence}\\"]}"}'`,
  "",
].join("\n");

/**
 * `commands.ts` with the placeholders replaced — step 2 of the printed instructions, which only a
 * person can do: a scaffolder cannot know how a repository runs its suite.
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

/**
 * A fresh repository — `git init` and nothing else. No manifest, no `.gitignore`, no commit.
 * Deliberately barer than every other fixture in this tier, because the bareness is the test:
 * everything the loop needs from here on has to come from init's own instructions.
 */
const fresh = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-init-instructions-" })
    .pipe(Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["init", "--quiet", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Kojo"]);
    git(root, ["config", "user.email", "kojo@example.invalid"]);
  });

  // **Outside the repository** — a `bin/` of the test's own inside `root` would be an untracked
  // file the merge rightly refuses, manufactured by the suite.
  const binary = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-agent-bin-" })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(path.join(binary, "claude"), fakeClaude).pipe(Effect.orDie);
  yield* Effect.sync(() => {
    execFileSync("chmod", ["+x", path.join(binary, "claude")]);
  });

  // `/usr/bin:/bin` still carries `git` and `sh`, which the sandbox scope needs. The credential is
  // exported the way CI exports one, so `kojo doctor` grades a factory whose agent can be paid —
  // the scripted `claude` above never reads it.
  const env = {
    PATH: `${binary}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CLAUDE_CODE_OAUTH_TOKEN: "scripted",
  };

  return { root, env };
});

const inFreshRepository = <A, E>(
  use: (fixture: {
    readonly root: string;
    readonly env: Readonly<Record<string, string>>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.flatMap(fresh, use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("a factory stamped, installed and run exactly as `kojo init` instructs", () => {
  it.live("reaches its merge, with nothing added beyond what the instructions say", () =>
    inFreshRepository(({ root, env }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // ── `kojo init`, the way a person runs it: a child process, from the repository. ──────
        const stamped = succeeded(
          "kojo init",
          yield* kojo(root, [
            "init",
            "--agent",
            "claude",
            "--model",
            "claude-opus-4-8",
            "--sandbox",
            "none",
            "--template",
            "review",
            "--package-manager",
            "bun",
          ]),
        );

        // Init said what it did to the repository's `.gitignore`, in the same ledger as the rest.
        expect(stamped).toContain("created  .gitignore");

        const steps = stepsOf(stamped);
        expect(steps.length, `no numbered steps in:\n${stamped}`).toBeGreaterThanOrEqual(4);

        // ── Step 1: the install, exactly as printed. ──────────────────────────────────────────
        const install = steps[0] ?? "";
        expect(install).toBe("bun install");
        succeeded(install, yield* Effect.sync(() => instructed(root, install)));

        // What the install wrote: the directory that sank wave 15's walk, and the lockfile. The
        // first must be ignored; the second must not be — the stamped `commands.install` restores
        // dependencies frozen against it, so it belongs in the history.
        expect(yield* fileSystem.exists(path.join(root, "node_modules", "kojo"))).toBe(true);
        expect(yield* fileSystem.exists(path.join(root, "bun.lock"))).toBe(true);
        expect(git(root, ["check-ignore", "node_modules"]).trim()).toBe("node_modules");
        expect(() => git(root, ["check-ignore", "bun.lock"])).toThrow();

        // ── Step 2: the one edit only a person can make. ──────────────────────────────────────
        yield* fileSystem
          .writeFileString(path.join(root, ".kojo", "commands.ts"), editedCommands)
          .pipe(Effect.orDie);

        // ── Step 3: the commit, exactly as printed. It has to be executable as printed — a bare
        // `git commit` would open an editor and hang a person's terminal no less than this test.
        const commit = steps[2] ?? "";
        expect(commit).toContain("git add --all");
        succeeded(commit, yield* Effect.sync(() => instructed(root, commit)));

        // The commit carried the factory, the manifest and the lockfile — and not the install.
        const committed = git(root, ["ls-files"]);
        expect(committed).toContain("bun.lock");
        expect(committed).toContain(".kojo/commands.ts");
        expect(committed).toContain("package.json");
        expect(committed).not.toContain("node_modules");
        expect(committed).not.toContain(".kojo/.env");

        // ── Step 4: `kojo doctor` says this factory can run. ──────────────────────────────────
        const doctor = steps[3] ?? "";
        expect(doctor).toBe("kojo doctor");
        succeeded(doctor, yield* kojo(root, ["doctor"], env));

        // ── Run, suspend, approve — the loop the README teaches. ──────────────────────────────
        const before = git(root, ["rev-parse", "main"]).trim();
        const started = succeeded("kojo run", yield* kojo(root, ["run", "review", summary], env));
        const runId = runIdOf(started);

        expect(runId).not.toBe("");
        expect(started).toContain('suspended at gate "approve"');

        const listing = succeeded("kojo gate list", yield* kojo(root, ["gate", "list"], env));
        const answered = succeeded(
          "kojo gate answer",
          yield* kojo(
            root,
            ["gate", "answer", tokenOf(listing, runId), "--choice", "approve", "--as", "kevin"],
            env,
          ),
        );

        expect(answered).toContain("run succeeded");

        // ── The merge the whole ticket is about: `main` moved, and holds the agent's work. ─────
        expect(git(root, ["rev-parse", "main"]).trim()).not.toBe(before);
        expect(git(root, ["log", "main", "--format=%s"])).toContain(summary);
        expect(git(root, ["show", `main:${licence}`])).toContain("A licence header");

        // And the trunk the loop leaves behind is *clean* — the condition the merge checks, still
        // true after everything init's instructions created. This is the line that was red before
        // this ticket: `?? node_modules/` sat here.
        expect(git(root, ["status", "--porcelain"]).trim()).toBe("");
      }),
    ),
  );
});
