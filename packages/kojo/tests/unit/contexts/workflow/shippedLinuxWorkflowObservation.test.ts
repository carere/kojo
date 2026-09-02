import { describe, expect, it } from "vitest";
import {
  advanceShippedWorkflowStability,
  shippedWorkflowObservation,
  shippedWorkflowObservationBounds,
} from "../../../support/release/ShippedWorkflowObservation.ts";

const projectId = "75983ca0-6709-44ca-a8e7-59f507e3aed2";

const workflow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId,
  projectState: "available",
  factoryState: "available",
  refreshState: "current",
  workflowName: "review",
  availability: "available",
  currentRevisionId: "revision-a",
  currentPackageGraphId: "package-graph-a",
  ...overrides,
});

const snapshot = (
  workflowRows: ReadonlyArray<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    observationVersion: 1,
    instanceId: "instance-a",
    dataIdentity: "data-a",
    refreshAfterMillis: 1_000,
    workflows: workflowRows,
    ...overrides,
  });

describe("shipped Linux Workflow observation", () => {
  it("reserves failure classification inside the strict total bound", () => {
    const configuredTotalMillis =
      (shippedWorkflowObservationBounds.observerTerminateAfterSeconds +
        shippedWorkflowObservationBounds.observerKillAfterSeconds +
        shippedWorkflowObservationBounds.classifierTerminateAfterSeconds +
        shippedWorkflowObservationBounds.classifierKillAfterSeconds) *
      1_000;

    expect(configuredTotalMillis).toBe(shippedWorkflowObservationBounds.totalBoundMillis);
    expect(configuredTotalMillis).toBeLessThanOrEqual(120_000);
    expect(shippedWorkflowObservationBounds.internalTimeoutMillis).toBeLessThan(
      shippedWorkflowObservationBounds.observerTerminateAfterSeconds * 1_000,
    );
  });

  it("waits while the controlled Workflow Factory Refresh is pending", () => {
    const output = snapshot([workflow({ refreshState: "pending" })]);

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: false,
      diagnostic:
        "Project available, Factory available, Factory Refresh pending, Workflow available",
    });
  });

  it("accepts one exact available Workflow after the Factory Refresh is current", () => {
    const output = snapshot([workflow()]);

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: true,
      diagnostic:
        "Project available, Factory available, Factory Refresh current, Workflow available",
    });
  });

  it("does not combine readiness from a different Project or Workflow row", () => {
    const output = snapshot([
      workflow({ availability: "invalid" }),
      workflow({ projectId: "another-project", availability: "available" }),
      workflow({ workflowName: "another-workflow", availability: "available" }),
    ]);

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: false,
      diagnostic: "Project available, Factory available, Factory Refresh current, Workflow invalid",
    });
  });

  it("rejects duplicate exact Workflow rows", () => {
    const output = snapshot([workflow(), workflow()]);

    expect(shippedWorkflowObservation(output, projectId, "review")).toMatchObject({
      ready: false,
      diagnostic: `expected one review Workflow for Project ${projectId}; observed 2`,
    });
  });

  it("resets stability when Factory Refresh becomes pending", () => {
    const current = shippedWorkflowObservation(snapshot([workflow()]), projectId, "review");
    const pending = shippedWorkflowObservation(
      snapshot([workflow({ refreshState: "pending" })]),
      projectId,
      "review",
    );

    const first = advanceShippedWorkflowStability(undefined, current, 0);
    const premature = advanceShippedWorkflowStability(first, current, 1_000);
    const reset = advanceShippedWorkflowStability(premature, pending, 2_000);
    const restarted = advanceShippedWorkflowStability(reset, current, 3_000);
    const stable = advanceShippedWorkflowStability(restarted, current, 9_000);

    expect(first).toMatchObject({ accepted: false, consecutiveCurrent: 1 });
    expect(premature).toMatchObject({ accepted: false, stableForMillis: 1_000 });
    expect(reset).toMatchObject({ accepted: false, consecutiveCurrent: 0, fact: "not-current" });
    expect(restarted).toMatchObject({ accepted: false, consecutiveCurrent: 1 });
    expect(stable).toMatchObject({
      accepted: true,
      consecutiveCurrent: 2,
      stableForMillis: 6_000,
      requiredStableMillis: 6_000,
    });
  });

  it.each([
    {
      field: "Daemon instance identity",
      changed: snapshot([workflow()], { instanceId: "instance-b" }),
    },
    {
      field: "Data identity",
      changed: snapshot([workflow()], { dataIdentity: "data-b" }),
    },
    {
      field: "Workflow revision identity",
      changed: snapshot([workflow({ currentRevisionId: "revision-b" })]),
    },
    {
      field: "Package Graph identity",
      changed: snapshot([workflow({ currentPackageGraphId: "package-graph-b" })]),
    },
  ])("restarts Factory Refresh stability when $field changes", ({ changed }) => {
    const first = shippedWorkflowObservation(snapshot([workflow()]), projectId, "review");
    const next = shippedWorkflowObservation(changed, projectId, "review");

    const initial = advanceShippedWorkflowStability(undefined, first, 0);
    const restarted = advanceShippedWorkflowStability(initial, next, 7_000);

    expect(restarted).toMatchObject({
      accepted: false,
      consecutiveCurrent: 1,
      stableForMillis: 0,
      fact: "candidate-started",
    });
  });

  it("compares structured Factory Refresh identity without delimiter collisions", () => {
    const first = shippedWorkflowObservation(
      snapshot([workflow()], { instanceId: "instance/a", dataIdentity: "data" }),
      projectId,
      "review",
    );
    const changed = shippedWorkflowObservation(
      snapshot([workflow()], { instanceId: "instance", dataIdentity: "a/data" }),
      projectId,
      "review",
    );

    const initial = advanceShippedWorkflowStability(undefined, first, 0);
    const restarted = advanceShippedWorkflowStability(initial, changed, 7_000);

    expect(restarted).toMatchObject({
      accepted: false,
      consecutiveCurrent: 1,
      stableForMillis: 0,
      fact: "candidate-started",
    });
  });
});
