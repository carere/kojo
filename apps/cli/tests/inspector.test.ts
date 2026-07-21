import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInspectorService } from "../src/system/inspector";
import type { Project } from "../src/system/projects";
import { openSystemStore } from "../src/system/storage";
import { makeWorkflowRunService } from "../src/system/workflow-runs";

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { force: true, recursive: true });
  homes.clear();
});

const revisionFor = (stableName: string) => {
  const source = {
    commit: "a".repeat(40),
    dirty: false,
    kind: "ProjectSourceRevision" as const,
  };
  return {
    revision: {
      declaredVersion: "v1",
      fingerprint: `fingerprint-${stableName}`,
      source,
      stableName,
      workflowAbi: "1",
    },
    revisionSnapshot: {
      rootWorkflow: stableName,
      source,
      workflows: [
        {
          declaredVersion: "v1",
          fingerprint: `fingerprint-${stableName}`,
          stableName,
          workflowAbi: "1",
        },
      ],
    },
  };
};

describe("Dense Inspector projections", () => {
  test("preserves unknown evidence and reports unavailable facts without changing run state", async () => {
    const home = await mkdtemp(join(tmpdir(), "kojo-inspector-test-"));
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
    const project: Project = {
      availability: { status: "Available" },
      createdAt: now,
      id: "project-1",
      metadata: {
        branches: ["main"],
        currentBranch: "main",
        folderName: "project",
        headCommit: "a".repeat(40),
        remotes: [],
      },
      path: join(home, "project"),
      registrationState: "Enabled",
      source: null,
      updatedAt: now,
    };
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => ({
        encodedInput: {},
        execute:
          workflowName === "defect"
            ? async () => ({
                state: "Failed" as const,
                value: { _tag: "Defect", cause: "workflow crashed" },
              })
            : async () => new Promise(() => undefined),
        ...revisionFor(workflowName),
      }),
    });
    const running = await runs.start({
      fromCheckout: false,
      input: {},
      projectId: project.id,
      workflowName: "future-evidence",
    });
    const lease = store.workflowRuns.find(running.runId)?.lease;
    if (lease === undefined) throw new Error("The Workflow Run lease is missing");
    const scope = {
      attempt: 1,
      leaseGeneration: lease.generation,
      leaseHolder: lease.holder,
      projectId: project.id,
      rootRunId: running.runId,
      runId: running.runId,
    };
    const unknownDetails = {
      encodingVersion: 99,
      futureEnvelopeField: { retained: true },
      value: { providerFact: "future" },
    };
    store.workflowRuns.appendBoundary({
      ...scope,
      details: JSON.stringify(unknownDetails),
      idempotencyKey: `${running.runId}:future-evidence`,
      operation: "Provider.FutureEvidence",
      subject: "provider-call",
    });
    runs.registerArtifact({
      ...scope,
      byteLength: 42,
      fingerprint: "sha256:missing-provider-output",
      mediaType: "application/json",
      path: join(home, "artifacts", "missing-provider-output.json"),
    });
    store.workflowRuns.appendBoundary({
      ...scope,
      details: JSON.stringify({
        encodingVersion: 1,
        value: {
          artifacts: [{ fingerprint: "sha256:missing-provider-output", name: "provider-output" }],
        },
      }),
      idempotencyKey: `${running.runId}:missing-artifact`,
      operation: "Agent.Completed",
      subject: "agent-step",
    });

    const inspector = makeInspectorService(store, runs, async () => [project]);
    expect(await inspector.inspect(running.runId)).toMatchObject({
      evidence: [
        { schema: { status: "Known", version: 1 }, type: "WorkflowRun.Started" },
        {
          details: unknownDetails,
          schema: { status: "Unknown", version: 99 },
          type: "Provider.FutureEvidence",
        },
        {
          artifacts: [{ availability: "Unavailable", name: "provider-output" }],
          type: "Agent.Completed",
        },
      ],
      state: "Running",
    });

    runs.verifyRuntimeConfiguration({
      ...scope,
      snapshot: { adapterVersion: "1", kind: "Agent", name: "reviewer" },
      subject: "review-step",
    });
    runs.verifyRuntimeConfiguration({
      ...scope,
      snapshot: { adapterVersion: "2", kind: "Agent", name: "reviewer" },
      subject: "review-step",
    });
    store.workflowRuns.interruptRunning();
    expect(await inspector.inspect(running.runId)).toMatchObject({
      actions: [
        {
          enabled: false,
          name: "resume",
          reason: "Runtime configuration is incompatible for review-step",
        },
        { enabled: true, name: "discard" },
      ],
      resumeCompatibility: {
        reason: "Runtime configuration is incompatible for review-step",
        status: "Incompatible",
      },
      runtimeConfigurationCompatibility: {
        reason: "Runtime configuration is incompatible for review-step",
        status: "Incompatible",
      },
      state: "Interrupted",
    });

    const defect = await runs.start({
      fromCheckout: false,
      input: {},
      projectId: project.id,
      workflowName: "defect",
    });
    await runs.settle(defect.runId);
    expect(await inspector.inspect(defect.runId)).toMatchObject({
      actions: [
        {
          enabled: false,
          name: "resume",
          reason: "The Workflow Run failed with a non-resumable Defect",
        },
        { enabled: true, name: "discard" },
      ],
      resumeCompatibility: { status: "Incompatible" },
      state: "Failed",
    });

    const disabledInspector = makeInspectorService(store, runs, async () => [
      { ...project, registrationState: "Disabled" },
    ]);
    expect(await disabledInspector.inspect(defect.runId)).toMatchObject({
      actions: [
        { enabled: false, name: "resume", reason: "Project registration is Disabled" },
        { enabled: true, name: "discard" },
      ],
      resumeCompatibility: { reason: "Project registration is Disabled", status: "Unavailable" },
      state: "Failed",
    });
    store.close();
  });
});
