import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CommandResult {
  readonly command: "start" | "stop" | "restart" | "status" | "logs";
  readonly home: string;
  readonly process: null | {
    readonly endpoint: string;
    readonly pid: number;
  };
  readonly schemaVersion: 1;
  readonly status: string;
}

const cli = resolve(import.meta.dir, "../main.ts");
const homes = new Set<string>();
const cleanupPaths = new Set<string>();

const makeHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "kojo-system-test-"));
  homes.add(home);
  return home;
};

const runCli = (home: string, ...arguments_: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...arguments_], {
    env: { ...process.env, KOJO_HOME: home },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString().trim();

  return {
    exitCode: result.exitCode,
    json: stdout.length > 0 ? (JSON.parse(stdout) as CommandResult) : undefined,
    stderr: result.stderr.toString(),
  };
};

const runCliAsync = async (home: string, ...arguments_: ReadonlyArray<string>) => {
  const child = Bun.spawn([process.execPath, "run", cli, ...arguments_], {
    env: { ...process.env, KOJO_HOME: home },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  const output = stdout.trim();

  return {
    exitCode,
    json: output.length > 0 ? (JSON.parse(output) as CommandResult) : undefined,
    stderr,
  };
};

const runGit = (directory: string, ...arguments_: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", "-C", directory, ...arguments_], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
};

const makeRepository = async (parent: string, name: string) => {
  const repository = join(parent, name);
  await mkdir(repository);
  runGit(repository, "init", "--initial-branch=main");
  runGit(repository, "config", "user.email", "kojo@example.test");
  runGit(repository, "config", "user.name", "Kojo Test");
  await Bun.write(join(repository, "README.md"), `# ${name}\n`);
  runGit(repository, "add", "README.md");
  runGit(repository, "commit", "-m", "initial");
  return repository;
};

afterEach(async () => {
  for (const home of homes) {
    runCli(home, "stop", "--timeout", "2");
    await rm(home, { force: true, recursive: true });
  }
  for (const path of cleanupPaths) {
    await rm(path, { force: true, recursive: true });
  }
  homes.clear();
  cleanupPaths.clear();
});

describe("Kojo System Process", () => {
  test("preserves Project identity across path, availability, and registration changes", async () => {
    const home = await makeHome();
    const repositories = await mkdtemp(join(tmpdir(), "kojo-project-test-"));
    cleanupPaths.add(repositories);
    const original = await makeRepository(repositories, "original-name");
    expect(runCli(home, "start").exitCode).toBe(0);

    const added = runCli(home, "project", "add", original);
    expect(added.exitCode).toBe(0);
    expect(added.json).toMatchObject({
      command: "project.add",
      project: {
        availability: { status: "Available" },
        metadata: { folderName: "original-name" },
        path: original,
        registrationState: "Disabled",
      },
      schemaVersion: 1,
      status: "created",
    });
    const projectId = (added.json as unknown as { project: { id: string } }).project.id;
    expect(projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const duplicate = runCli(home, "project", "add", original);
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.json).toMatchObject({
      command: "project.add",
      error: { code: "PROJECT_ALREADY_REGISTERED" },
      schemaVersion: 1,
      status: "failed",
    });

    await Bun.write(join(original, "README.md"), "# changed metadata\n");
    runGit(original, "add", "README.md");
    runGit(original, "commit", "-m", "change metadata");
    runGit(original, "branch", "mutable-branch");
    runGit(original, "remote", "add", "origin", "https://example.test/kojo.git");
    const changedCommit = runGit(original, "rev-parse", "HEAD");
    const metadataChanged = runCli(home, "project", "list");
    expect(metadataChanged.exitCode).toBe(0);
    expect(metadataChanged.json).toMatchObject({
      projects: [
        {
          id: projectId,
          metadata: {
            branches: ["main", "mutable-branch"],
            headCommit: changedCommit,
            remotes: [{ name: "origin", url: "https://example.test/kojo.git" }],
          },
        },
      ],
    });

    const moved = join(repositories, "moved-name");
    await rename(original, moved);
    const unavailable = runCli(home, "project", "list");
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.json).toMatchObject({
      command: "project.list",
      projects: [
        {
          availability: {
            reasons: [{ code: "PATH_NOT_FOUND" }],
            status: "Unavailable",
          },
          id: projectId,
          path: original,
        },
      ],
      schemaVersion: 1,
      status: "succeeded",
    });

    const relinked = runCli(home, "project", "relink", projectId, moved);
    expect(relinked.exitCode).toBe(0);
    expect(relinked.json).toMatchObject({
      command: "project.relink",
      project: {
        availability: { status: "Available" },
        id: projectId,
        metadata: { folderName: "moved-name" },
        path: moved,
        registrationState: "Disabled",
      },
      schemaVersion: 1,
      status: "relinked",
    });

    const enabled = runCli(home, "project", "enable", projectId);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.json).toMatchObject({
      command: "project.enable",
      project: { id: projectId, registrationState: "Enabled" },
      status: "enabled",
    });
    const disabled = runCli(home, "project", "disable", projectId);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.json).toMatchObject({
      command: "project.disable",
      project: { id: projectId, registrationState: "Disabled" },
      status: "disabled",
    });
    const archived = runCli(home, "project", "archive", projectId);
    expect(archived.exitCode).toBe(0);
    expect(archived.json).toMatchObject({
      command: "project.archive",
      project: { id: projectId, registrationState: "Archived" },
      status: "archived",
    });

    const listed = runCli(home, "project", "list");
    expect(listed.exitCode).toBe(0);
    expect(listed.json).toMatchObject({
      projects: [{ id: projectId, registrationState: "Archived" }],
    });
  }, 20_000);

  test("records unavailable Projects and validates them before enabling", async () => {
    const home = await makeHome();
    const repositories = await mkdtemp(join(tmpdir(), "kojo-unavailable-project-test-"));
    cleanupPaths.add(repositories);
    const missing = join(repositories, "missing");
    const invalid = join(repositories, "not-a-repository");
    await mkdir(invalid);
    expect(runCli(home, "start").exitCode).toBe(0);

    const invalidAdded = runCli(home, "project", "add", invalid);
    expect(invalidAdded.exitCode).toBe(0);
    expect(invalidAdded.json).toMatchObject({
      command: "project.add",
      project: {
        availability: {
          reasons: [{ code: "NOT_GIT_REPOSITORY", path: invalid }],
          status: "Unavailable",
        },
        registrationState: "Disabled",
      },
      status: "created",
    });

    const added = runCli(home, "project", "add", missing);
    expect(added.exitCode).toBe(0);
    expect(added.json).toMatchObject({
      command: "project.add",
      project: {
        availability: {
          reasons: [{ code: "PATH_NOT_FOUND", path: missing }],
          status: "Unavailable",
        },
        path: missing,
        registrationState: "Disabled",
      },
      status: "created",
    });
    const projectId = (added.json as unknown as { project: { id: string } }).project.id;

    const enableFailed = runCli(home, "project", "enable", projectId);
    expect(enableFailed.exitCode).not.toBe(0);
    expect(enableFailed.json).toMatchObject({
      command: "project.enable",
      error: { code: "PROJECT_UNAVAILABLE", reasons: [{ code: "PATH_NOT_FOUND" }] },
      schemaVersion: 1,
      status: "failed",
    });

    const repository = await makeRepository(repositories, "available");
    const relinked = runCli(home, "project", "relink", projectId, repository);
    expect(relinked.exitCode).toBe(0);
    expect(relinked.json).toMatchObject({
      project: { availability: { status: "Available" }, id: projectId },
    });
    const enabled = runCli(home, "project", "enable", projectId);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.json).toMatchObject({
      project: { id: projectId, registrationState: "Enabled" },
    });
  }, 20_000);

  test("rejects linked worktrees while allowing a separate full clone", async () => {
    const home = await makeHome();
    const repositories = await mkdtemp(join(tmpdir(), "kojo-git-identity-test-"));
    cleanupPaths.add(repositories);
    const repository = await makeRepository(repositories, "source");
    const linkedWorktree = join(repositories, "linked-worktree");
    const clone = join(repositories, "full-clone");
    runGit(repository, "worktree", "add", "-b", "linked", linkedWorktree);
    const cloneResult = Bun.spawnSync(["git", "clone", repository, clone], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(cloneResult.exitCode).toBe(0);
    expect(runCli(home, "start").exitCode).toBe(0);

    const first = runCli(home, "project", "add", repository);
    expect(first.exitCode).toBe(0);

    const linked = runCli(home, "project", "add", linkedWorktree);
    expect(linked.exitCode).not.toBe(0);
    expect(linked.json).toMatchObject({
      command: "project.add",
      error: { code: "LINKED_WORKTREE_NOT_PROJECT" },
      schemaVersion: 1,
      status: "failed",
    });

    const cloned = runCli(home, "project", "add", clone);
    expect(cloned.exitCode).toBe(0);
    expect((cloned.json as unknown as { project: { id: string } }).project.id).not.toBe(
      (first.json as unknown as { project: { id: string } }).project.id,
    );

    const listed = runCli(home, "project", "list");
    expect((listed.json as unknown as { projects: ReadonlyArray<unknown> }).projects).toHaveLength(
      2,
    );
  }, 20_000);

  test("provides idempotent lifecycle, status, and log commands for one Kojo Home", async () => {
    const home = await makeHome();

    const first = runCli(home, "start");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({
      command: "start",
      home,
      schemaVersion: 1,
      status: "started",
    });
    if (first.json === undefined) {
      throw new Error("start did not return a machine-readable result");
    }
    expect(first.json?.process?.pid).toBeInteger();
    const endpoint = first.json.process?.endpoint;
    if (endpoint === undefined) {
      throw new Error("start did not return the private local endpoint");
    }
    await access(endpoint);
    expect((await stat(endpoint)).mode & 0o777).toBe(0o600);

    const second = runCli(home, "start");
    expect(second.exitCode).toBe(0);
    expect(second.json).toEqual({
      ...first.json,
      status: "already-running",
    });

    const status = runCli(home, "status");
    expect(status.exitCode).toBe(0);
    expect(status.json).toEqual({
      ...first.json,
      command: "status",
      status: "running",
    });

    const logs = runCli(home, "logs", "--lines", "20");
    expect(logs.exitCode).toBe(0);
    expect(logs.json).toMatchObject({
      command: "logs",
      home,
      schemaVersion: 1,
      status: "available",
    });
    expect(logs.json).toHaveProperty("lines");

    const restarted = runCli(home, "restart", "--timeout", "2");
    expect(restarted.exitCode).toBe(0);
    expect(restarted.json).toMatchObject({
      command: "restart",
      home,
      schemaVersion: 1,
      status: "restarted",
    });
    expect(restarted.json?.process?.pid).not.toBe(first.json?.process?.pid);

    const stopped = runCli(home, "stop", "--timeout", "2");
    expect(stopped.exitCode).toBe(0);
    expect(stopped.json).toMatchObject({
      command: "stop",
      home,
      process: null,
      schemaVersion: 1,
      status: "stopped",
    });
    await expect(access(join(home, "system.lock"))).rejects.toBeDefined();
    if (stopped.json === undefined) {
      throw new Error("stop did not return a machine-readable result");
    }

    const stoppedAgain = runCli(home, "stop", "--timeout", "2");
    expect(stoppedAgain.exitCode).toBe(0);
    expect(stoppedAgain.json).toEqual({ ...stopped.json, status: "already-stopped" });

    const finalStatus = runCli(home, "status");
    expect(finalStatus.exitCode).toBe(0);
    expect(finalStatus.json).toEqual({
      command: "status",
      home,
      process: null,
      schemaVersion: 1,
      status: "stopped",
    });
    await expect(access(endpoint)).rejects.toBeDefined();
  }, 20_000);

  test("serializes concurrent starts and initializes its Drizzle-managed SQLite store", async () => {
    const home = await makeHome();
    const [first, second] = await Promise.all([
      runCliAsync(home, "start"),
      runCliAsync(home, "start"),
    ]);

    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    expect(new Set([first.json?.status, second.json?.status])).toEqual(
      new Set(["started", "already-running"]),
    );
    expect(first.json?.process).toEqual(second.json?.process);

    const homeMode = (await stat(home)).mode & 0o777;
    const databasePath = join(home, "state.sqlite");
    const databaseMode = (await stat(databasePath)).mode & 0o777;
    expect(homeMode).toBe(0o700);
    expect(databaseMode).toBe(0o600);

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(database.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
      expect(database.query("SELECT id, checksum FROM kojo_migrations ORDER BY id").all()).toEqual([
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          id: 1,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          id: 2,
        },
      ]);
    } finally {
      database.close();
    }
  }, 20_000);

  test("reports an actionable versioned failure when storage cannot be initialized", async () => {
    const home = await makeHome();
    await Bun.write(join(home, "state.sqlite"), "not a sqlite database");

    const result = runCli(home, "start");

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      command: "start",
      home,
      error: {
        action: expect.any(String),
        code: "MIGRATION_FAILED",
        message: expect.stringContaining("state.sqlite"),
      },
      process: null,
      schemaVersion: 1,
      status: "failed",
    });
  }, 20_000);

  test("refuses a changed migration with an actionable machine result", async () => {
    const home = await makeHome();
    const database = new Database(join(home, "state.sqlite"), { create: true });
    try {
      database.run(`CREATE TABLE kojo_migrations (
        id INTEGER PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`);
      database.run(
        "INSERT INTO kojo_migrations (id, checksum, applied_at) VALUES (1, 'changed', 'now')",
      );
    } finally {
      database.close();
    }

    const result = runCli(home, "start");

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      command: "start",
      home,
      error: {
        action: expect.any(String),
        code: "MIGRATION_FAILED",
        message: expect.stringContaining("migration 1 checksum"),
      },
      process: null,
      schemaVersion: 1,
      status: "failed",
    });
  }, 20_000);

  test("recovers a launch lock left by a terminated CLI Launcher", async () => {
    const home = await makeHome();
    await Bun.write(
      join(home, "launch.lock"),
      JSON.stringify({ pid: 999_999_999, token: "terminated-launcher" }),
    );

    const started = runCli(home, "start");

    expect(started.exitCode).toBe(0);
    expect(started.json).toMatchObject({
      command: "start",
      home,
      schemaVersion: 1,
      status: "started",
    });
    await expect(access(join(home, "launch.lock"))).rejects.toBeDefined();
  }, 20_000);

  test("reports actionable lock and availability failures", async () => {
    const lockedHome = await makeHome();
    await Bun.write(join(lockedHome, "system.lock"), "invalid lock owner");
    await Bun.write(join(lockedHome, "system.log"), '{"event":"startup-diagnostic"}\n');

    const lockedStatus = runCli(lockedHome, "status");
    expect(lockedStatus.exitCode).not.toBe(0);
    expect(lockedStatus.json).toMatchObject({
      command: "status",
      error: {
        action: expect.any(String),
        code: "HOME_LOCKED",
        message: expect.stringContaining("lock"),
      },
      schemaVersion: 1,
      status: "failed",
    });

    const locked = runCli(lockedHome, "start");
    expect(locked.exitCode).not.toBe(0);
    expect(locked.json).toMatchObject({
      command: "start",
      error: {
        action: expect.any(String),
        code: "HOME_LOCKED",
        message: expect.stringContaining("lock"),
      },
      schemaVersion: 1,
      status: "failed",
    });

    const lockedLogs = runCli(lockedHome, "logs", "--lines", "20");
    expect(lockedLogs.exitCode).toBe(0);
    expect(lockedLogs.json).toMatchObject({
      command: "logs",
      home: lockedHome,
      lines: ['{"event":"startup-diagnostic"}'],
      process: null,
      schemaVersion: 1,
      status: "available",
    });

    const unavailableHome = await makeHome();
    await Bun.write(
      join(unavailableHome, "system.lock"),
      JSON.stringify({ phase: "starting", pid: process.pid, token: "test-authority" }),
    );
    const unavailable = runCli(unavailableHome, "status");
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.json).toMatchObject({
      command: "status",
      error: {
        action: expect.any(String),
        code: "SYSTEM_UNAVAILABLE",
        message: expect.stringContaining("not available"),
      },
      schemaVersion: 1,
      status: "unavailable",
    });
    await rm(join(unavailableHome, "system.lock"), { force: true });
  }, 20_000);

  test("classifies startup failures separately from generic command failures", async () => {
    const parent = await makeHome();
    const home = join(parent, "nested-home-path-that-is-deliberately-long".repeat(3));

    const result = runCli(home, "start");

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      command: "start",
      home,
      error: {
        action: expect.any(String),
        code: "STARTUP_FAILED",
        message: expect.stringContaining("private local endpoint"),
      },
      process: null,
      schemaVersion: 1,
      status: "failed",
    });
  }, 20_000);
});
