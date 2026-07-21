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
  test("reports lifecycle state separately from resume compatibility", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("separate-facts", "separate-facts-fingerprint", "f"),
      }),
      prepareResume: async () => {
        throw new Error("not used");
      },
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "separate-facts",
    });

    expect(service.inspect(started.runId)).toMatchObject({
      resumeCompatibility: { status: "NotChecked" },
      runtimeConfigurationCompatibility: { status: "NotChecked" },
      state: "Running",
    });
    store.close();
  });

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

  test("reconciles Project Runtime Process loss as Interrupted instead of Failed", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => {
          throw new Error("runtime process exited");
        },
        ...preparedRevision("runtime-loss", "runtime-loss-fingerprint", "e"),
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "runtime-loss",
    });

    await service.settle(started.runId);

    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ state: "Interrupted" }],
      evidence: [
        { type: "WorkflowRun.Started" },
        {
          details: {
            encodingVersion: 1,
            value: { reason: "ProjectRuntimeProcessLost" },
          },
          type: "WorkflowRun.Interrupted",
        },
      ],
      state: "Interrupted",
    });
    store.close();
  });

  test("suspends after the current Activity settles and starts no next Activity", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("suspend", "suspend-fingerprint", "1"),
      }),
      prepareResume: async () => {
        throw new Error("not used");
      },
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "suspend",
    });
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

    expect(service.suspend(started.runId)).toMatchObject({ state: "Running", status: "requested" });
    expect(
      service.recordBoundary({
        ...scope,
        idempotencyKey: `${started.runId}:activity:settle:Activity.Completed`,
        operation: "Activity.Completed",
        payload: { value: "settled" },
        subject: "settle",
      }),
    ).toMatchObject({ control: "suspend" });
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ state: "Suspended" }],
      evidence: [
        { type: "WorkflowRun.Started" },
        { type: "WorkflowRun.SuspendRequested" },
        { type: "Activity.Completed" },
        { type: "WorkflowRun.Suspended" },
      ],
      lease: { state: "Released" },
      state: "Suspended",
    });
    expect(() =>
      service.claimActivity({
        ...scope,
        completionIdempotencyKey: `${started.runId}:next:completed`,
        idempotencyKey: `${started.runId}:next:started`,
        payload: {},
        subject: "next",
      }),
    ).toThrow("rejected a delayed execution write");
    store.close();
  });

  test("resumes the same Run ID only after complete preflight and creates numbered authority", async () => {
    const store = await makeStore();
    const preflights: Array<unknown> = [];
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: { value: "kept" },
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("resume", "resume-fingerprint", "2"),
      }),
      prepareResume: async (request) => {
        preflights.push(request);
        return {
          execute: async () => new Promise(() => undefined),
          revisionCompatibility: "Compatible" as const,
          runtimeConfigurationCompatibility: "Compatible" as const,
          sourceAvailability: "Available" as const,
          leaseAvailability: "Available" as const,
          recoveryPolicy: "NotRequired" as const,
        };
      },
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "resume",
    });
    const firstAuthority = store.workflowRuns.find(started.runId)?.lease;
    if (firstAuthority === undefined) throw new Error("start did not create an Execution Lease");
    store.workflowRuns.interruptRunning();

    const resumed = await service.resume(started.runId);

    expect(preflights).toHaveLength(1);
    expect(preflights[0]).toMatchObject({
      attempt: 1,
      input: { value: "kept" },
      revision: { fingerprint: "resume-fingerprint", stableName: "resume" },
      state: "Interrupted",
    });
    expect(resumed).toMatchObject({ attempt: 2, runId: started.runId, state: "Running" });
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [
        { number: 1, state: "Interrupted" },
        { number: 2, state: "Running" },
      ],
      evidence: [
        { type: "WorkflowRun.Started" },
        { type: "WorkflowRun.Interrupted" },
        { attempt: 2, type: "WorkflowRun.Resumed" },
      ],
      lease: { generation: 2, state: "Active" },
      runId: started.runId,
      state: "Running",
    });
    expect(() =>
      service.recordBoundary({
        attempt: 1,
        idempotencyKey: `${started.runId}:delayed`,
        leaseGeneration: 1,
        leaseHolder: firstAuthority.holder,
        operation: "Activity.Completed",
        payload: {},
        projectId: "project-1",
        rootRunId: started.runId,
        runId: started.runId,
        subject: "delayed",
      }),
    ).toThrow("rejected a delayed execution write");
    store.close();
  });

  test("does not create an attempt when any resume preflight fails", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("incompatible", "incompatible-fingerprint", "3"),
      }),
      prepareResume: async () => {
        throw new WorkflowStartError("WORKFLOW_INCOMPATIBLE", "Pinned revision is unavailable");
      },
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "incompatible",
    });
    store.workflowRuns.interruptRunning();

    await expect(service.resume(started.runId)).rejects.toMatchObject({
      code: "WORKFLOW_INCOMPATIBLE",
    });
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ number: 1 }],
      state: "Interrupted",
    });
    store.close();
  });

  test("discards unfinished runs source-independently while preserving evidence and terminals", async () => {
    const store = await makeStore();
    const outcomes = new Map<string, { state: "Completed"; value: unknown }>();
    const service = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => ({
        encodedInput: {},
        execute: async () => outcomes.get(workflowName) ?? (new Promise(() => undefined) as never),
        ...preparedRevision(workflowName, `${workflowName}-fingerprint`, "4"),
      }),
      prepareResume: async () => {
        throw new Error("discard must not load source");
      },
    });
    const unfinished = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "unfinished",
    });
    store.workflowRuns.interruptRunning();
    outcomes.set("complete", { state: "Completed", value: "done" });
    const completed = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "complete",
    });
    await service.settle(completed.runId);

    expect(service.discard(unfinished.runId)).toMatchObject({
      runId: unfinished.runId,
      state: "Discarded",
    });
    expect(service.inspect(unfinished.runId)).toMatchObject({
      attempts: [{ state: "Interrupted" }],
      evidence: [
        { type: "WorkflowRun.Started" },
        { type: "WorkflowRun.Interrupted" },
        { type: "WorkflowRun.Discarded" },
      ],
      state: "Discarded",
    });
    expect(() => service.discard(completed.runId)).toThrow("immutable");
    expect(() => service.resume(unfinished.runId)).toThrow("immutable");
    store.close();
  });

  test("immediately discards a Running run, fences its lease, and preserves uncertain evidence", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("running-discard", "running-discard-fingerprint", "5"),
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "running-discard",
    });
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
    service.claimActivity({
      ...scope,
      completionIdempotencyKey: `${started.runId}:publish:completed`,
      idempotencyKey: `${started.runId}:publish:started`,
      payload: {},
      subject: "publish",
    });

    expect(service.discard(started.runId)).toMatchObject({
      runId: started.runId,
      state: "Discarded",
      status: "discarded",
    });
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ state: "Discarded" }],
      evidence: [
        { type: "WorkflowRun.Started" },
        { type: "Activity.Started" },
        { type: "WorkflowRun.DiscardRequested" },
        { type: "Activity.Uncertain" },
        { type: "WorkflowRun.Discarded" },
      ],
      lease: { state: "Released" },
      state: "Discarded",
    });
    expect(() =>
      service.recordBoundary({
        ...scope,
        idempotencyKey: `${started.runId}:publish:completed`,
        operation: "Activity.Completed",
        payload: {},
        subject: "publish",
      }),
    ).toThrow("rejected a delayed execution write");
    store.close();
  });

  test("evidences an uncertain Activity on authority loss and blocks resume before attempt creation", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("uncertain", "uncertain-fingerprint", "5"),
      }),
      prepareResume: async () => ({
        execute: async () => new Promise(() => undefined),
        revisionCompatibility: "Compatible" as const,
        runtimeConfigurationCompatibility: "Compatible" as const,
        sourceAvailability: "Available" as const,
        leaseAvailability: "Available" as const,
        recoveryPolicy: "NotRequired" as const,
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "uncertain",
    });
    const stored = store.workflowRuns.find(started.runId);
    if (stored?.lease === undefined) throw new Error("start did not create an Execution Lease");
    const oldScope = {
      attempt: 1,
      leaseGeneration: 1,
      leaseHolder: stored.lease.holder,
      projectId: "project-1",
      rootRunId: started.runId,
      runId: started.runId,
    };
    const startedKey = `${started.runId}:external:started`;
    service.claimActivity({
      ...oldScope,
      completionIdempotencyKey: `${started.runId}:external:completed`,
      idempotencyKey: startedKey,
      payload: {},
      subject: "publish",
    });
    store.workflowRuns.interruptRunning();
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ number: 1, state: "Interrupted" }],
      evidence: [
        { type: "WorkflowRun.Started" },
        { type: "Activity.Started" },
        { type: "Activity.Uncertain" },
        { type: "WorkflowRun.Interrupted" },
      ],
      state: "Interrupted",
    });
    expect(() => service.resume(started.runId)).toThrow("requires reconciliation");
    expect(service.inspect(started.runId)?.attempts).toHaveLength(1);
    expect(() =>
      service.recordBoundary({
        ...oldScope,
        idempotencyKey: `${started.runId}:delayed`,
        operation: "Activity.Completed",
        payload: {},
        subject: "publish",
      }),
    ).toThrow("rejected a delayed execution write");
    store.close();
  });

  test("never resumes a Defect even when workflow code registers a matching tag", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => ({
          state: "Failed" as const,
          value: { _tag: "Defect", cause: "workflow crashed" },
        }),
        ...preparedRevision("defect", "defect-fingerprint", "6"),
      }),
      prepareResume: async () => ({
        execute: async () => new Promise(() => undefined),
        leaseAvailability: "Available" as const,
        recoveryPolicy: "Available" as const,
        revisionCompatibility: "Compatible" as const,
        runtimeConfigurationCompatibility: "Compatible" as const,
        sourceAvailability: "Available" as const,
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "defect",
    });
    await service.settle(started.runId);

    expect(() => service.resume(started.runId)).toThrow("non-resumable Defect");
    expect(service.inspect(started.runId)).toMatchObject({
      attempts: [{ number: 1, state: "Failed" }],
      state: "Failed",
    });
    store.close();
  });

  test("reconciles an expired lease to Interrupted before rejecting its delayed write", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("expired", "expired-fingerprint", "6"),
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "expired",
    });
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
    store.workflowRuns.renewLease(scope, new Date(0).toISOString());

    expect(() =>
      service.recordBoundary({
        ...scope,
        idempotencyKey: `${started.runId}:late`,
        operation: "Activity.Completed",
        payload: {},
        subject: "late",
      }),
    ).toThrow("rejected a delayed execution write");
    expect(service.inspect(started.runId)).toMatchObject({
      evidence: [
        { type: "WorkflowRun.Started" },
        {
          details: { encodingVersion: 1, value: { reason: "LeaseExpired" } },
          type: "WorkflowRun.Interrupted",
        },
      ],
      lease: { state: "Expired" },
      state: "Interrupted",
    });
    store.close();
  });

  test("reconciles an expired lease without waiting for a delayed writer", async () => {
    const store = await makeStore();
    const service = makeWorkflowRunService(store, {
      prepare: async () => ({
        encodedInput: {},
        execute: async () => new Promise(() => undefined),
        ...preparedRevision("expired-idle", "expired-idle-fingerprint", "7"),
      }),
    });
    const started = await service.start({
      fromCheckout: false,
      input: {},
      projectId: "project-1",
      workflowName: "expired-idle",
    });
    const stored = store.workflowRuns.find(started.runId);
    if (stored?.lease === undefined) throw new Error("start did not create an Execution Lease");
    store.workflowRuns.renewLease(
      {
        attempt: 1,
        leaseGeneration: 1,
        leaseHolder: stored.lease.holder,
        projectId: "project-1",
        rootRunId: started.runId,
        runId: started.runId,
      },
      new Date(0).toISOString(),
    );

    expect(store.workflowRuns.reconcileExpiredLeases()).toEqual([started.runId]);
    expect(service.inspect(started.runId)).toMatchObject({
      lease: { state: "Expired" },
      state: "Interrupted",
    });
    store.close();
  });
});
