import type { ProjectSnapshot } from "@kojo/control";
import { Context, type Effect } from "effect";

export type WorkflowBackendAssessment = "ready" | "uninitialized" | "needs-attention";

export interface WorkflowBackendShape {
  readonly initialize: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly readiness: (project: ProjectSnapshot) => Effect.Effect<WorkflowBackendAssessment>;
  readonly release: (project: ProjectSnapshot) => Effect.Effect<void>;
}

export class WorkflowBackend extends Context.Service<WorkflowBackend, WorkflowBackendShape>()(
  "kojo/host/WorkflowBackend",
) {}
