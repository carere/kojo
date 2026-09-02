import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AskingDocument,
  AskingSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import type {
  RunDocument,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { SqliteProjectRepository } from "../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { captureWorkflowRevision } from "../../../src/contexts/workflow/services/captureRevision.ts";
import { publishConsoleRelease } from "../../support/daemon/consoleRelease.ts";
import { sendPreparedMutation } from "../../support/daemon/preparedMutation.ts";

const gateCli = fileURLToPath(new URL("../../support/daemon/gateCli.ts", import.meta.url));
const roots: string[] = [];
const daemons: RunningDaemon[] = [];

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const makePaths = (): DaemonPaths => {
  const root = mkdtempSync(join(process.cwd(), ".kojo-gate-cli-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const paths = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(paths);
  return paths;
};

const makeProject = (root: string): string => {
  const location = join(root, "project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "gate-cli-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(location, ".kojo", "workflows", "gated.ts"),
    `import { appendFileSync } from "node:fs";
import { Duration, Effect, Schema } from "effect";
import { fail } from "@carere/kojo-runtime/contexts/gate/models/OnExpiry";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { gate } from "@carere/kojo-runtime/contexts/workflow/services/phase/gate";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

const Payload = Schema.Struct({
  key: Schema.String,
  mode: Schema.Literals(["success", "failure", "second"]),
});

export const gated = workflow(
  {
    name: "gated",
    payload: Payload,
    success: Schema.Null,
    error: Schema.String,
    idempotencyKey: (payload) => payload.key,
  },
  (payload) => Effect.gen(function* () {
    yield* code(
      { name: "before", description: "Effect before the Gate", success: Schema.Null, error: Schema.Never },
      Effect.sync(() => { appendFileSync("effects.txt", "before:" + payload.key + "\\n"); return null; }),
    );
    const verdict = yield* gate({
      name: "ship",
      description: "Ship this revision?",
      actor: "release-engineer",
      choices: ["approve", "reject"],
      deadline: Duration.hours(1),
      onExpiry: fail(),
    });
    if (verdict.choice === "reject" || payload.mode === "failure") return yield* Effect.fail("rejected");
    yield* code(
      { name: "after", description: "Effect after the Gate", success: Schema.Null, error: Schema.Never },
      Effect.sync(() => { appendFileSync("effects.txt", "after:" + payload.key + "\\n"); return null; }),
    );
    if (payload.mode === "second") {
      yield* gate({
        name: "publish",
        description: "Publish this revision?",
        actor: "publisher",
        choices: ["approve", "reject"],
        deadline: Duration.hours(1),
        onExpiry: fail(),
      });
    }
    return null;
  }),
);
`,
  );
  writeFileSync(join(location, "effects.txt"), "");
  execFileSync("git", ["init", "--initial-branch=main", location]);
  execFileSync("git", ["-C", location, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", location, "config", "user.name", "Kojo Test"]);
  execFileSync("git", ["-C", location, "add", "."]);
  execFileSync("git", ["-C", location, "commit", "-m", "test: fixture"]);
  return realpathSync(location);
};

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

const runCli = async (root: string, args: ReadonlyArray<string>): Promise<Ran> => {
  const child = Bun.spawn([process.execPath, gateCli, root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
};

const snapshot = async (daemon: RunningDaemon): Promise<AskingSnapshot> =>
  (await (await call(daemon, "/api/v1/askings")).json()) as AskingSnapshot;

const waitForAsking = async (
  daemon: RunningDaemon,
  runId: string,
  gatePath = "ship",
): Promise<AskingDocument> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const asking = (await snapshot(daemon)).askings.find(
      (candidate) => candidate.identity.runId === runId && candidate.identity.gatePath === gatePath,
    );
    if (asking !== undefined) return asking;
    await Bun.sleep(20);
  }
  throw new Error(`Run ${runId} did not reach Gate ${gatePath}`);
};

const waitForRun = async (daemon: RunningDaemon, runId: string): Promise<RunDocument> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = (await (await call(daemon, `/api/v1/runs/${runId}`)).json()) as RunDocument;
    if (run.state === "succeeded" || run.state === "failed" || run.state === "suspended") {
      return run;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Run ${runId} did not stop`);
};

const harness = async (key: string, mode: "success" | "failure" | "second" = "success") => {
  const hostPaths = makePaths();
  const root = roots.at(-1) ?? "";
  const location = makeProject(root);
  mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
  const captured = captureWorkflowRevision({
    project: location,
    dataRoot: hostPaths.dataRoot,
    workflowName: "gated",
  });
  const databasePath = join(hostPaths.dataRoot, "kojo.db");
  const database = new Database(databasePath, { create: true, strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  const projects = new SqliteProjectRepository(database);
  const registered = await Effect.runPromise(
    projects.register({
      requestId: "seed-project",
      requestBody: "seed-project",
      dataIdentity: "seed-data",
      location,
      observedAt: "2026-09-01T00:00:00.000Z",
      factory: {
        state: "available",
        refreshState: "current",
        workflows: [
          {
            workflowName: "gated",
            availability: "available",
            source: join(location, ".kojo", "workflows", "gated.ts"),
            revision: captured,
          },
        ],
      },
    }),
  );
  database.close(false);
  chmodSync(databasePath, 0o600);

  const daemon = startDaemon(hostPaths, { automaticRefresh: false });
  daemons.push(daemon);
  const started = await sendPreparedMutation(
    daemon,
    `/api/v1/projects/${registered.project.projectId}/workflows/gated/actions/start`,
    {
      mutationVersion: 1,
      requestId: `start-${key}`,
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "startWorkflow",
      target: {
        identityVersion: 1,
        kind: "workflow",
        parts: [registered.project.projectId, "gated"],
      },
      arguments: { payload: { key, mode } },
      preconditions: {},
    },
  );
  expect(started.status, await started.clone().text()).toBe(202);
  const admission = (await started.json()) as StartRunResult;
  const asking = await waitForAsking(daemon, admission.runId);
  return { root, location, daemon, admission, asking };
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("answering a Gate from another process", () => {
  it("resumes the same Run where it stopped, and re-runs nothing", async () => {
    const test = await harness("resume");
    const answered = await runCli(test.root, [
      "answer",
      test.asking.token,
      "--choice",
      "approve",
      "--wait",
    ]);
    expect(answered.status, answered.stderr).toBe(0);
    expect((await waitForRun(test.daemon, test.admission.runId)).state).toBe("succeeded");
    expect(readFileSync(join(test.location, "effects.txt"), "utf8").trim().split("\n")).toEqual([
      "before:resume",
      "after:resume",
    ]);
  });

  it("exits non-zero and names terminal inability when the answer ends in failure", async () => {
    const test = await harness("failure", "failure");
    const database = new Database(join(test.root, "data", "kojo.db"), { strict: true });
    database.run("UPDATE workflow_runs SET state = 'failed' WHERE run_id = ?", [
      test.admission.runId,
    ]);
    database.close(false);
    const answered = await runCli(test.root, [
      "answer",
      test.asking.token,
      "--choice",
      "approve",
      "--wait",
    ]);
    expect(answered.status).toBe(1);
    expect(answered.stderr).toContain("cannot apply");
    expect((await waitForRun(test.daemon, test.admission.runId)).state).toBe("failed");
  });

  it("exits 0 when the answer is Applied and the Run succeeds", async () => {
    const test = await harness("success");
    const answered = await runCli(test.root, [
      "answer",
      test.asking.token,
      "--choice",
      "approve",
      "--wait",
      "--json",
    ]);
    expect(answered.status, answered.stderr).toBe(0);
    expect(answered.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(answered.stdout)).toMatchObject({
      formatVersion: 1,
      asking: { state: "applied" },
    });
  });

  it("keeps the first answer when a second one arrives", async () => {
    const test = await harness("first-answer");
    const first = await runCli(test.root, ["answer", test.asking.token, "--choice", "approve"]);
    expect(first.status, first.stderr).toBe(0);
    const second = await runCli(test.root, ["answer", test.asking.token, "--choice", "reject"]);
    expect(second.status).toBe(1);
    expect((await snapshot(test.daemon)).askings[0]?.verdict?.choice).toBe("approve");
  });

  it("lists without applying or executing the waiting Run", async () => {
    const test = await harness("list-only");
    const before = readFileSync(join(test.location, "effects.txt"), "utf8");
    const listed = await runCli(test.root, ["list"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(test.asking.token);
    expect(readFileSync(join(test.location, "effects.txt"), "utf8")).toBe(before);
    expect(
      await call(test.daemon, `/api/v1/runs/${test.admission.runId}`).then((response) =>
        response.json(),
      ),
    ).toMatchObject({ state: "suspended" });
  });

  it("refuses an unknown token with exit 1", async () => {
    const test = await harness("unknown-token");
    const answered = await runCli(test.root, ["answer", "not-a-gate-token", "--choice", "approve"]);
    expect(answered.status).toBe(1);
    expect(answered.stderr).toContain("not found");
  });

  it("defaults to Unanswered and Recorded, while --all includes settled Askings", async () => {
    const test = await harness("list-default");
    const answered = await runCli(test.root, [
      "answer",
      test.asking.token,
      "--choice",
      "approve",
      "--wait",
    ]);
    expect(answered.status, answered.stderr).toBe(0);
    expect((await runCli(test.root, ["list"])).stdout).not.toContain(test.asking.token);
    const all = await runCli(test.root, ["list", "--all"]);
    expect(all.stdout).toContain(test.asking.token);
    expect(all.stdout).toContain("State=applied");
  });

  it("applies the first Verdict once when the Run stops at its next Gate", async () => {
    const test = await harness("second-gate", "second");
    const answered = await runCli(test.root, [
      "answer",
      test.asking.token,
      "--choice",
      "approve",
      "--wait",
    ]);
    expect(answered.status, answered.stderr).toBe(0);
    expect((await waitForAsking(test.daemon, test.admission.runId, "publish")).state).toBe(
      "unanswered",
    );
    expect((await snapshot(test.daemon)).askings).toHaveLength(2);
    expect(readFileSync(join(test.location, "effects.txt"), "utf8").trim().split("\n")).toEqual([
      "before:second-gate",
      "after:second-gate",
    ]);
  });
});
