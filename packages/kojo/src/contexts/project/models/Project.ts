import type {
  FactoryState,
  ProjectDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";

export interface FactoryObservation {
  readonly state: FactoryState;
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
