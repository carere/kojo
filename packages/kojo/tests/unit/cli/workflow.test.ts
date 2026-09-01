import type { WorkflowSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { describe, expect, it } from "vitest";
import { workflowLines } from "../../../src/cli/workflow.ts";

describe("Workflow CLI view", () => {
  it("keeps Project, Factory, refresh, activity, availability, source, revision, and Trigger separate", () => {
    const snapshot: WorkflowSnapshot = {
      observationVersion: 1,
      instanceId: "instance",
      dataIdentity: "data",
      snapshotVersion: 3,
      observedAt: "2026-09-01T00:00:00.000Z",
      refreshAfterMillis: 1_000,
      counts: { total: 1, available: 0, invalid: 1, removed: 0, active: 1 },
      workflows: [
        {
          projectId: "project-full-id",
          projectLabel: "factory",
          projectState: "available",
          factoryState: "available",
          refreshState: "failed",
          workflowName: "review",
          activity: "active",
          availability: "invalid",
          source: "/project/.kojo/workflows/review.ts",
          sourceFault: "the declaration name does not match",
          currentRevisionId: "a".repeat(64),
          trigger: { state: "delayed", detail: "historical package switch" },
          refreshedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };

    expect(workflowLines(snapshot)).toEqual([
      [
        "project-full-id",
        "review",
        "Project=available",
        "Factory=available",
        "Refresh=failed",
        "Activity=active",
        "Workflow=invalid",
        "Source=the declaration name does not match",
        `Revision=${"a".repeat(64)}`,
        "Trigger=delayed",
      ].join("\t"),
    ]);
  });
});
