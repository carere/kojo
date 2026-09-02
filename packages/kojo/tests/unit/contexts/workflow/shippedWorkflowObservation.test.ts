import { describe, expect, it } from "vitest";
import { shippedWorkflowObservation } from "../../../support/release/ShippedMacosEvidence.ts";

const projectId = "35a68346-672c-4294-b528-df4392036a1b";

const workflow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId,
  projectState: "available",
  factoryState: "available",
  refreshState: "current",
  workflowName: "release-evidence",
  availability: "available",
  ...overrides,
});

describe("shipped macOS Workflow observation", () => {
  it("waits while the controlled Workflow Factory Refresh is pending", () => {
    const output = JSON.stringify({
      observationVersion: 1,
      workflows: [workflow({ refreshState: "pending" })],
    });

    expect(shippedWorkflowObservation(output, projectId)).toMatchObject({
      ready: false,
      diagnostic:
        "Project available, Factory available, Factory Refresh pending, Workflow available",
    });
  });

  it("accepts one exact available Workflow after the Factory Refresh is current", () => {
    const output = JSON.stringify({ observationVersion: 1, workflows: [workflow()] });

    expect(shippedWorkflowObservation(output, projectId)).toMatchObject({
      ready: true,
      diagnostic:
        "Project available, Factory available, Factory Refresh current, Workflow available",
    });
  });

  it("does not combine availability from a different Workflow row", () => {
    const output = JSON.stringify({
      observationVersion: 1,
      workflows: [
        workflow({ availability: "invalid" }),
        workflow({ workflowName: "review", availability: "available" }),
      ],
    });

    expect(shippedWorkflowObservation(output, projectId)).toMatchObject({
      ready: false,
      diagnostic: "Project available, Factory available, Factory Refresh current, Workflow invalid",
    });
  });
});
