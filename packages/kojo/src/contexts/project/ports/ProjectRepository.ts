import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { ProjectDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Context, type Effect } from "effect";
import type { RegisteredProject, RegisterProjectRequest } from "../models/Project.ts";
import type { ProjectStoreError } from "../models/ProjectStoreError.ts";

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    readonly register: (
      request: RegisterProjectRequest,
    ) => Effect.Effect<RegisteredProject, ProjectStoreError>;
    readonly projects: Effect.Effect<ReadonlyArray<ProjectDocument>, ProjectStoreError>;
    readonly receipt: (
      dataIdentity: string,
      requestId: string,
    ) => Effect.Effect<OperationReceipt | undefined, ProjectStoreError>;
    readonly snapshotVersion: Effect.Effect<number, ProjectStoreError>;
  }
>()("kojo/project/ProjectRepository") {}
