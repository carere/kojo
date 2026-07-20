import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSystemStore } from "../src/system/storage";
import { makeWorkflowRunService, WorkflowStartError } from "../src/system/workflow-runs";

const homes = new Set<string>();

const makeStore = async () => {
  const home = await mkdtemp(join(tmpdir(), "kojo-workflow-run-test-"));
  homes.add(home);
  const store = await openSystemStore(home);
  const now = new Date().toISOString();
  store.projects.create({
    createdAt: now,
    id: "project-1",
    metadata: "{}",
    path: join(home, "project"),
    registrationState: "Enabled",
    updatedAt: now,
  });
  return store;
};

const preparedRevision = (stableName: string, fingerprint: string, commit: string) => {
  const source = {
    commit: commit.repeat(40),
    dirty: false,
    kind: "ProjectSourceRevision" as const,
  };
  const revision = {
    declaredVersion: "v1",
    fingerprint,
    source,
    stableName,
    workflowAbi: "1",
  };
  return {
    revision,
    revisionSnapshot: {
      rootWorkflow: stableName,
      source,
      workflows: [{ declaredVersion: "v1", fingerprint, stableName, workflowAbi: "1" }],
    },
  };
};

afterEach(async () => {
  for (const home of homes) await rm(home, { force: true, recursive: true });
  homes.clear();
});

describe("Workflow Run service", () => {
  test("leaves no run when discovery or input validation fails", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => {
        throw new WorkflowStartError("INVALID_INPUT", "input did not match the schema");
      },
    });

    await expect(
      service.start({
        fromCheckout: false,
        input: { message: 1 },
        projectId: "project-1",
        workflowName: "example",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(store.workflowRuns.list()).toEqual([]);
    store.close();
  });

  test("atomically creates attempt one, its lease, trigger, journal, and initial evidence", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => {
        const prepared = preparedRevision("example", "fingerprint-1", "a");
        return {
          encodedInput: { message: "hello" },
          execute: async () => new Promise(() => undefined),
          ...prepared,
          revisionSnapshot: {
            ...prepared.revisionSnapshot,
            workflows: [
              ...prepared.revisionSnapshot.workflows,
              {
                declaredVersion: "child-v2",
                fingerprint: "child-fingerprint",
                stableName: "child",
                workflowAbi: "1",
              },
            ],
          },
        };
      },
    });

    const started = await service.start({
      fromCheckout: false,
      input: { message: "hello" },
      projectId: "project-1",
      workflowName: "example",
    });
    const inspected = service.inspect(started.runId);

    expect(started).toMatchObject({ attempt: 1, state: "Running" });
    expect(inspected).toMatchObject({
      attempts: [{ number: 1, state: "Running" }],
      evidence: [{ sequence: 1, type: "WorkflowRun.Started" }],
      input: { encodingVersion: 1, value: { message: "hello" } },
      lease: { generation: 1, state: "Active" },
      revision: {
        declaredVersion: "v1",
        fingerprint: "fingerprint-1",
        stableName: "example",
      },
      revisionSnapshot: {
        rootWorkflow: "example",
        workflows: [
          { fingerprint: "fingerprint-1", stableName: "example" },
          { fingerprint: "child-fingerprint", stableName: "child" },
        ],
      },
      state: "Running",
      trigger: { type: "Direct" },
    });
    expect(store.workflowJournal.list(started.runId)).toEqual([
      expect.objectContaining({ operation: "WorkflowRun.Started", sequence: 1 }),
    ]);
    store.close();
  });

  test("finalizes completed and failed outcomes with evidence for source-independent inspection", async () => {
    const store = await makeStore();
    const outcomes = [
      { state: "Completed" as const, value: { greeting: "hello" } },
      { state: "Failed" as const, value: { _tag: "ExpectedFailure", reason: "no" } },
    ];
    const service = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => ({
        encodedInput: {},
        execute: async () => {
          const outcome = outcomes.shift();
          if (outcome === undefined) throw new Error("test outcome was not configured");
          return outcome;
        },
        ...preparedRevision(workflowName, `fingerprint-${workflowName}`, "b"),
      }),
    });

    const completed = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "complete",
    });
    const failed = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "fail",
    });
    await service.settle(completed.runId);
    await service.settle(failed.runId);

    expect(service.inspect(completed.runId)).toMatchObject({
      attempts: [{ state: "Completed" }],
      evidence: [{ type: "WorkflowRun.Started" }, { type: "WorkflowRun.Completed" }],
      outcome: { encodingVersion: 1, value: { greeting: "hello" } },
      state: "Completed",
    });
    expect(service.inspect(failed.runId)).toMatchObject({
      attempts: [{ state: "Failed" }],
      evidence: [{ type: "WorkflowRun.Started" }, { type: "WorkflowRun.Failed" }],
      outcome: {
        encodingVersion: 1,
        value: { _tag: "ExpectedFailure", reason: "no" },
      },
      state: "Failed",
    });
    store.close();
  });

  test("commits an Activity journal mutation and evidence under the active lease", async () => {
    const store = await makeStore();
    let finish: ((outcome: { state: "Completed"; value: unknown }) => void) | undefined;
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        ...preparedRevision("activity", "activity-fingerprint", "c"),
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "activity",
    });
    await Promise.resolve();
    const stored = store.workflowRuns.find(started.runId);
    if (stored?.lease === undefined) throw new Error("start did not create an Execution Lease");

    const scope = {
      attempt: 1,
      leaseGeneration: 1,
      leaseHolder: stored.lease.holder,
      projectId: "project-1",
      rootRunId: started.runId,
      runId: started.runId,
    };
    const startedKey = `${started.runId}:activity:echo:1:Activity.Started`;
    const completedKey = `${started.runId}:activity:echo:1:Activity.Completed`;
    expect(
      service.claimActivity({
        ...scope,
        completionIdempotencyKey: completedKey,
        idempotencyKey: startedKey,
        payload: { attempt: 1 },
        subject: "echo",
      }),
    ).toMatchObject({ status: "execute" });
    const completed = service.recordBoundary({
      ...scope,
      idempotencyKey: completedKey,
      operation: "Activity.Completed",
      payload: { _tag: "Complete", exit: { _tag: "Success", value: "hello" } },
      subject: "echo",
    });
    expect(
      service.recordBoundary({
        ...scope,
        idempotencyKey: completedKey,
        operation: "Activity.Completed",
        payload: { _tag: "Complete", exit: { _tag: "Success", value: "hello" } },
        subject: "echo",
      }).eventId,
    ).toBe(completed.eventId);
    expect(
      service.claimActivity({
        ...scope,
        completionIdempotencyKey: completedKey,
        idempotencyKey: startedKey,
        payload: { attempt: 1 },
        subject: "echo",
      }),
    ).toEqual({
      payload: { _tag: "Complete", exit: { _tag: "Success", value: "hello" } },
      status: "replay",
    });
    expect(() =>
      service.recordBoundary({
        ...scope,
        idempotencyKey: `${started.runId}:wrong-root`,
        operation: "Activity.Completed",
        payload: {},
        rootRunId: "another-root",
        subject: "echo",
      }),
    ).toThrow("rejected a delayed execution write");
    finish?.({ state: "Completed", value: { greeting: "hello" } });
    await service.settle(started.runId);

    expect(service.inspect(started.runId)).toMatchObject({
      evidence: [
        { sequence: 1, type: "WorkflowRun.Started" },
        { sequence: 2, subject: "echo", type: "Activity.Started" },
        { sequence: 3, subject: "echo", type: "Activity.Completed" },
        { sequence: 4, type: "WorkflowRun.Completed" },
      ],
      state: "Completed",
    });
    expect(store.workflowJournal.list(started.runId).map(({ operation }) => operation)).toEqual([
      "WorkflowRun.Started",
      "Activity.Started",
      "Activity.Completed",
      "WorkflowRun.Completed",
    ]);
    store.close();
  });

  test("reconciles a Running attempt as Interrupted when system authority restarts", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("interrupted", "interrupted-fingerprint", "e"),
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "interrupted",
    });

    expect(store.workflowRuns.interruptRunning()).toEqual([started.runId]);
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ state: "Interrupted" }],
      evidence: [{ type: "WorkflowRun.Started" }, { type: "WorkflowRun.Interrupted" }],
      lease: { state: "Expired" },
      state: "Interrupted",
    });
    store.close();
  });
});
