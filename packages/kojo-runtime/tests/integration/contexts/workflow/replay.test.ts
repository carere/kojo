import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationReplyBody } from "@carere/kojo-runner-contracts/contexts/project/contracts/execution";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeRunnerFrameReader,
  writeRunnerFrame,
} from "../../../../src/contexts/project/services/runnerChannel.ts";
import type {
  ExecuteRegisteredRequest,
  ExecuteRegisteredResult,
} from "../../../../src/runner/main.ts";

const runner = fileURLToPath(new URL("../../../../src/runner/main.ts", import.meta.url));
const executionRoot = fileURLToPath(new URL("../../../fixtures/runner", import.meta.url));

const execute = async (
  request: ExecuteRegisteredRequest,
  counter: string,
): Promise<ExecuteRegisteredResult> => {
  const channel = join(dirname(counter), `runner-${crypto.randomUUID()}.sock`);
  let accepted: (socket: Socket) => void = () => undefined;
  const connection = new Promise<Socket>((resolve) => {
    accepted = resolve;
  });
  const server = createServer((socket) => accepted(socket));
  server.listen(channel);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const child = Bun.spawn([process.execPath, runner], {
    cwd: executionRoot,
    env: {
      ...process.env,
      KOJO_EFFECT_COUNTER: counter,
      KOJO_RUNNER_CHANNEL: channel,
      KOJO_RUNNER_BINDING: JSON.stringify({
        daemonInstanceId: request.daemonInstanceId,
        runnerInstanceId: request.runnerInstanceId,
        projectId: request.projectId,
        packageGraphId: request.packageGraphId,
      }),
    },
    stdin: new Blob([request.connectionSecret]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const error = new Response(child.stderr).text();
  const socket = await connection;
  server.close();
  const reader = makeRunnerFrameReader(socket);
  const readFrame = async () => {
    try {
      return await Effect.runPromise(reader.read);
    } catch {
      const exit = await child.exited;
      throw new Error(`Runner exited ${exit}: ${await error}`);
    }
  };
  const hello = await readFrame();
  expect(hello).toMatchObject({
    kind: "Hello",
    daemonInstanceId: request.daemonInstanceId,
    runnerInstanceId: request.runnerInstanceId,
    body: {
      connectionSecret: request.connectionSecret,
      projectId: request.projectId,
      packageGraphId: request.packageGraphId,
    },
  });
  await Effect.runPromise(
    writeRunnerFrame(socket, {
      version: 1,
      kind: "Welcome",
      requestId: "welcome_1",
      daemonInstanceId: request.daemonInstanceId,
      runnerInstanceId: request.runnerInstanceId,
      body: {
        welcomeVersion: 1,
        packageGraphId: request.packageGraphId,
        projectId: request.projectId,
        selectedProtocol: 1,
        features: [],
      },
    }),
  );
  await Effect.runPromise(
    writeRunnerFrame(socket, {
      version: 1,
      kind: "RegisterRevision",
      requestId: "register_1",
      daemonInstanceId: request.daemonInstanceId,
      runnerInstanceId: request.runnerInstanceId,
      body: {
        registrationVersion: 1,
        revisionId: request.revisionId,
        packageGraphId: request.packageGraphId,
        workflowName: request.workflowName,
        retainedRoot: request.executionRoot,
        entrySource: request.entrySource,
        payload: request.payload as never,
      },
    }),
  );
  expect(await readFrame()).toMatchObject({
    kind: "Ready",
    body: { operationRequestId: "register_1", state: "committed" },
  });
  await Effect.runPromise(
    writeRunnerFrame(socket, {
      version: 1,
      kind: "ExecuteRun",
      requestId: "execute_1",
      daemonInstanceId: request.daemonInstanceId,
      runnerInstanceId: request.runnerInstanceId,
      runId: request.runId,
      revisionId: request.revisionId,
      claimGeneration: 1,
      body: {
        executionVersion: 1,
        workflowName: request.workflowName,
        payload: request.payload as never,
        recordedResults: request.recordedResults,
        deferredResults: request.deferredResults,
        scheduledWakeups: request.scheduledWakeups,
      },
    }),
  );
  const executed = await readFrame();
  const executedBody = executed.body as unknown as OperationReplyBody;
  expect(executed).toMatchObject({
    kind: "Ready",
    body: { operationRequestId: "execute_1", state: "committed" },
  });
  await Effect.runPromise(
    writeRunnerFrame(socket, {
      version: 1,
      kind: "Shutdown",
      requestId: "shutdown_1",
      daemonInstanceId: request.daemonInstanceId,
      runnerInstanceId: request.runnerInstanceId,
      body: null,
    }),
  );
  expect(await readFrame()).toMatchObject({ kind: "Stopped" });
  socket.end();
  const exit = await child.exited;
  const [standardOutput, standardError] = await Promise.all([output, error]);
  expect(standardOutput).toBe("");
  if (exit !== 0) throw new Error(`Runner exited ${exit}: ${standardError}`);
  return executedBody.result as unknown as ExecuteRegisteredResult;
};

describe("fresh Project Runner replay", () => {
  it("keeps the Daemon Run ID and does not repeat a committed code Phase", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kojo-runner-replay-"));
    const counter = join(directory, "effects.txt");
    writeFileSync(counter, "");
    try {
      const base: ExecuteRegisteredRequest = {
        registrationVersion: 1,
        selectedProtocol: 1,
        daemonInstanceId: "daemon-1",
        runnerInstanceId: "runner-1",
        projectId: "project-1",
        boundProjectId: "project-1",
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        boundPackageGraphId: "b".repeat(64),
        executionRoot,
        workflowName: "example",
        entrySource: "example.ts",
        payload: null,
        connectionSecret: "ab".repeat(32),
        runId: "daemon-assigned-run",
        recordedResults: {},
        deferredResults: {},
        scheduledWakeups: {},
      };
      const first = await execute(base, counter);
      expect(first.outcome).toBe("succeeded");
      expect(first.runId).toBe("daemon-assigned-run");
      expect(Object.keys(first.recordedResults).length).toBeGreaterThan(0);

      const second = await execute(
        { ...base, runnerInstanceId: "runner-2", recordedResults: first.recordedResults },
        counter,
      );
      expect(second.outcome).toBe("succeeded");
      expect(second.runId).toBe("daemon-assigned-run");
      expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["effect"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays an Applied Deferred after owner loss before Run completion without repeating work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kojo-runner-gate-"));
    const counter = join(directory, "effects.txt");
    writeFileSync(counter, "");
    try {
      const base: ExecuteRegisteredRequest = {
        registrationVersion: 1,
        selectedProtocol: 1,
        daemonInstanceId: "daemon-1",
        runnerInstanceId: "runner-gate-1",
        projectId: "project-1",
        boundProjectId: "project-1",
        revisionId: "c".repeat(64),
        packageGraphId: "d".repeat(64),
        boundPackageGraphId: "d".repeat(64),
        executionRoot,
        workflowName: "gated",
        entrySource: "gated.ts",
        payload: null,
        connectionSecret: "cd".repeat(32),
        runId: "daemon-assigned-gated-run",
        recordedResults: {},
        deferredResults: {},
        scheduledWakeups: {},
      };
      const suspended = await execute(base, counter);
      expect(suspended.outcome).toBe("suspended");
      expect(suspended.runId).toBe(base.runId);
      expect(suspended.askings).toHaveLength(1);
      const asking = suspended.askings[0];
      expect(asking).toMatchObject({
        gatePath: "ship",
        actor: "release-engineer",
        choices: ["approve", "reject"],
        internalDeferredName: "gate/ship/1",
      });
      expect(Object.values(suspended.scheduledWakeups)).toHaveLength(1);

      const deferredKey = JSON.stringify([base.runId, asking?.internalDeferredName]);
      const deferredResults = {
        [deferredKey]: {
          _id: "Exit",
          _tag: "Success",
          value: {
            choice: "approve",
            reason: "release evidence is green",
            answerer: "operator",
            answeredAt: (asking?.requestedAt ?? 0) + 1,
          },
        },
      };
      const applied = await execute(
        {
          ...base,
          runnerInstanceId: "runner-gate-2",
          recordedResults: suspended.recordedResults,
          deferredResults,
          scheduledWakeups: suspended.scheduledWakeups,
        },
        counter,
      );
      expect(applied.outcome).toBe("succeeded");
      expect(applied.runId).toBe(base.runId);

      const replayed = await execute(
        {
          ...base,
          runnerInstanceId: "runner-gate-3",
          recordedResults: applied.recordedResults,
          deferredResults,
          scheduledWakeups: applied.scheduledWakeups,
        },
        counter,
      );
      expect(replayed.outcome).toBe("succeeded");
      expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["applied"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
