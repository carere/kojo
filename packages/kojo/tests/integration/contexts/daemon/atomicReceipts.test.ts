import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const roots: string[] = [];
const revisionId = "a".repeat(64);
const packageGraphId = "b".repeat(64);
const repositoryUrl = new URL(
  "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts",
  import.meta.url,
).href;

const request = {
  dataIdentity: "data-atomic",
  requestId: "request-atomic",
  canonicalRequest: '[1,"project-atomic","compile","one",null]',
  projectId: "project-atomic",
  workflowName: "compile",
  idempotencyKey: "one",
  payload: null,
  revisionId,
  packageGraphId,
  admittedAt: "2026-09-01T10:00:00.000Z",
} as const;

const seededDatabase = (path: string): void => {
  const database = new Database(path, { create: true, strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  new SqliteProjectRepository(database);
  database.run(
    `INSERT INTO projects (
       project_id, location, project_state, factory_state, refresh_state,
       registered_at, refreshed_at, fault, remedy
     ) VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)`,
    [request.projectId, "/tmp/project-atomic", request.admittedAt, request.admittedAt],
  );
  database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', '/retained', ?)", [
    revisionId,
    packageGraphId,
    request.admittedAt,
  ]);
  database.run(
    "INSERT INTO project_workflows VALUES (?, ?, 'inactive', 'available', 'workflows/compile.ts', NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)",
    [request.projectId, request.workflowName, revisionId, request.admittedAt],
  );
  database.close(false);
};

const childProgram = `
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { SqliteRunRepository } from ${JSON.stringify(repositoryUrl)};

const database = new Database(process.env.KOJO_ATOMIC_DB, { strict: true });
const repository = new SqliteRunRepository(database);
const request = JSON.parse(process.env.KOJO_ATOMIC_REQUEST);
const mode = process.env.KOJO_ATOMIC_MODE;
const marker = process.env.KOJO_ATOMIC_MARKER;
const reply = process.env.KOJO_ATOMIC_REPLY;

if (mode === "before-commit") {
  writeFileSync(marker, "ready");
  await Bun.sleep(60_000);
}

const result = await Effect.runPromise(repository.admit(request));
if (mode === "after-commit") {
  writeFileSync(marker, "committed");
  await Bun.sleep(60_000);
}

writeFileSync(reply, JSON.stringify({ runId: result.run.runId, duplicate: result.duplicate }));
writeFileSync(marker, "replied");
await Bun.sleep(60_000);
`;

const waitFor = async (path: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`atomic receipt child did not reach ${path}`);
    await Bun.sleep(10);
  }
};

const interruptAt = async (mode: "before-commit" | "after-commit" | "after-reply") => {
  const root = mkdtempSync(join(tmpdir(), "kojo-atomic-receipt-"));
  roots.push(root);
  const databasePath = join(root, "kojo.db");
  const markerPath = join(root, "marker");
  const replyPath = join(root, "reply.json");
  seededDatabase(databasePath);
  const child = Bun.spawn([process.execPath, "-e", childProgram], {
    env: {
      ...process.env,
      KOJO_ATOMIC_DB: databasePath,
      KOJO_ATOMIC_MARKER: markerPath,
      KOJO_ATOMIC_MODE: mode,
      KOJO_ATOMIC_REPLY: replyPath,
      KOJO_ATOMIC_REQUEST: JSON.stringify(request),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  await waitFor(markerPath);
  child.kill("SIGKILL");
  await child.exited;
  return { databasePath, replyPath };
};

const reopen = (path: string) => {
  const database = new Database(path, { strict: true });
  const repository = new SqliteRunRepository(database);
  return { database, repository };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic client receipt and Run transition interruption", () => {
  it("kills before commit and reopens with neither a receipt nor a Run transition", async () => {
    const interrupted = await interruptAt("before-commit");
    const { database, repository } = reopen(interrupted.databasePath);
    expect(database.query("SELECT * FROM workflow_admission_receipts").all()).toHaveLength(0);
    expect(database.query("SELECT * FROM workflow_runs").all()).toHaveLength(0);
    expect(await Effect.runPromise(repository.read("missing"))).toBeUndefined();
    database.close(false);
  });

  it("kills after commit but before reply and reopens the receipt with its full Run transition", async () => {
    const interrupted = await interruptAt("after-commit");
    expect(existsSync(interrupted.replyPath)).toBe(false);
    const { database, repository } = reopen(interrupted.databasePath);
    expect(database.query("SELECT * FROM workflow_admission_receipts").all()).toHaveLength(1);
    expect(database.query("SELECT * FROM workflow_queue").all()).toHaveLength(1);
    const committed = database
      .query<{ readonly run_id: string }, []>("SELECT run_id FROM workflow_runs")
      .get();
    const replayed = await Effect.runPromise(repository.admit(request));
    expect(replayed.run.runId).toBe(committed?.run_id);
    expect(database.query("SELECT * FROM workflow_runs").all()).toHaveLength(1);
    expect(await Effect.runPromise(repository.read(replayed.run.runId))).toMatchObject({
      state: "queued",
      revisionId,
      packageGraphId,
    });
    database.close(false);
  });

  it("kills after reply and reopens the same atomic receipt and Run transition", async () => {
    const interrupted = await interruptAt("after-reply");
    expect(existsSync(interrupted.replyPath)).toBe(true);
    const { database, repository } = reopen(interrupted.databasePath);
    expect(database.query("SELECT * FROM workflow_admission_receipts").all()).toHaveLength(1);
    expect(database.query("SELECT * FROM workflow_queue").all()).toHaveLength(1);
    const committed = database
      .query<{ readonly run_id: string }, []>("SELECT run_id FROM workflow_runs")
      .get();
    const replayed = await Effect.runPromise(repository.admit(request));
    expect(replayed.run.runId).toBe(committed?.run_id);
    expect(database.query("SELECT * FROM workflow_runs").all()).toHaveLength(1);
    expect(await Effect.runPromise(repository.read(replayed.run.runId))).toMatchObject({
      state: "queued",
      revisionId,
      packageGraphId,
    });
    database.close(false);
  });
});
