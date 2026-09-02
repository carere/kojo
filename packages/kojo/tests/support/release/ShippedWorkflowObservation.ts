import { readFileSync } from "node:fs";

export interface ShippedWorkflowObservation {
  readonly ready: boolean;
  readonly diagnostic: string;
  readonly snapshot?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const shippedWorkflowObservation = (
  output: string,
  projectId: string,
  workflowName: string,
): ShippedWorkflowObservation => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch (cause) {
    return {
      ready: false,
      diagnostic: `Workflow observation is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.workflows)) {
    return { ready: false, diagnostic: "Workflow observation has no Workflow collection" };
  }
  const matches = decoded.workflows.filter(
    (workflow): workflow is Record<string, unknown> =>
      isRecord(workflow) &&
      workflow.projectId === projectId &&
      workflow.workflowName === workflowName,
  );
  const workflow = matches[0];
  if (matches.length !== 1 || workflow === undefined) {
    return {
      ready: false,
      diagnostic: `expected one ${workflowName} Workflow for Project ${projectId}; observed ${matches.length}`,
      snapshot: decoded,
    };
  }
  const diagnostic = [
    `Project ${String(workflow.projectState)}`,
    `Factory ${String(workflow.factoryState)}`,
    `Factory Refresh ${String(workflow.refreshState)}`,
    `Workflow ${String(workflow.availability)}`,
  ].join(", ");
  return {
    ready:
      workflow.projectState === "available" &&
      workflow.factoryState === "available" &&
      workflow.refreshState === "current" &&
      workflow.availability === "available",
    diagnostic,
    snapshot: decoded,
  };
};

if (import.meta.main) {
  const snapshotPath = process.argv[2];
  const projectId = process.argv[3];
  const workflowName = process.argv[4];
  if (snapshotPath === undefined || projectId === undefined || workflowName === undefined) {
    throw new Error("usage: ShippedWorkflowObservation.ts SNAPSHOT_PATH PROJECT_ID WORKFLOW_NAME");
  }
  const observation = shippedWorkflowObservation(
    readFileSync(snapshotPath, "utf8"),
    projectId,
    workflowName,
  );
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}
