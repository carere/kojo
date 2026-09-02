import { describe, expect, it } from "vitest";
import { shippedWorkflowObservation } from "../../../support/release/ShippedWorkflowObservation.ts";

const projectId = "75983ca0-6709-44ca-a8e7-59f507e3aed2";

const workflow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId,
  projectState: "available",
  factoryState: "available",
  refreshState: "current",
  workflowName: "review",
  availability: "available",
  ...overrides,
});

describe("shipped Linux Workflow observation", () => {
  it("waits while the controlled Workflow Factory Refresh is pending", () => {
    const output = JSON.stringify({
      observationVersion: 1,
      workflows: [workflow({ refreshState: "pending" })],
    });

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: false,
      diagnostic:
        "Project available, Factory available, Factory Refresh pending, Workflow available",
    });
  });

  it("accepts one exact available Workflow after the Factory Refresh is current", () => {
    const output = JSON.stringify({ observationVersion: 1, workflows: [workflow()] });

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: true,
      diagnostic:
        "Project available, Factory available, Factory Refresh current, Workflow available",
    });
  });

  it("does not combine readiness from a different Project or Workflow row", () => {
    const output = JSON.stringify({
      observationVersion: 1,
      workflows: [
        workflow({ availability: "invalid" }),
        workflow({ projectId: "another-project", availability: "available" }),
        workflow({ workflowName: "another-workflow", availability: "available" }),
      ],
    });

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: false,
      diagnostic: "Project available, Factory available, Factory Refresh current, Workflow invalid",
    });
  });

  it("rejects duplicate exact Workflow rows", () => {
    const output = JSON.stringify({ observationVersion: 1, workflows: [workflow(), workflow()] });

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: false,
      diagnostic: `expected one review Workflow for Project ${projectId}; observed 2`,
    });
  });
});
