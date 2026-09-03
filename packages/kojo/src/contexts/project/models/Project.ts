import type {
  FactoryRefreshState,
  FactoryState,
  ProjectDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type { WorkflowRefreshObservation } from "../../workflow/models/FactoryRefresh.ts";

export interface FactoryObservation {
  readonly state: FactoryState;
  readonly refreshState?: FactoryRefreshState;
  readonly workflows?: ReadonlyArray<WorkflowRefreshObservation>;
  readonly fault?: string;
  readonly remedy?: string;
}

export interface RegisterProjectRequest {
  readonly requestId: string;
  readonly requestBody: string;
  readonly dataIdentity: string;
  readonly location: string;
  readonly observedAt: string;
  readonly factory: FactoryObservation;
}

export interface RegisteredProject {
  readonly project: ProjectDocument;
  readonly created: boolean;
}
