import type { FactoryState } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type { WorkflowAvailability } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { CapturedWorkflowRevision } from "./RevisionManifest.ts";

/** Interval for authoritative Project inventory change detection. */
export const FACTORY_INVENTORY_SCAN_MILLIS = 5_000;

export interface WorkflowRefreshObservation {
  readonly workflowName: string;
  readonly availability: WorkflowAvailability;
  readonly source: string;
  readonly sourceFault?: string;
  readonly remedy?: string;
  readonly triggerDeclared?: boolean;
  readonly revision?: CapturedWorkflowRevision;
}

export interface FactoryRefreshObservation {
  readonly factoryState: FactoryState;
  readonly workflows: ReadonlyArray<WorkflowRefreshObservation>;
  readonly fault?: string;
  readonly remedy?: string;
}
