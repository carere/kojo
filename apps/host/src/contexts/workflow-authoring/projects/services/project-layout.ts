import type { ProjectIdentity, ProjectSnapshot, ReadinessFindingKey } from "@kojo/control";
import type { ProjectDefinitionValidation } from "@kojo/control/project-definition-validation";
import { Context, type Effect } from "effect";

export type ProjectLayoutValidation =
  | {
      readonly ok: true;
      readonly project: ProjectSnapshot;
      readonly definitions: ProjectDefinitionValidation;
    }
  | { readonly ok: false; readonly message: string; readonly findingKey: ReadinessFindingKey };

export type IndexedProjectPath =
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly identity: ProjectIdentity };

export interface ProjectLayoutShape {
  readonly inspectIndexedPath: (path: string) => Effect.Effect<IndexedProjectPath>;
  readonly validate: (path: string) => Effect.Effect<ProjectLayoutValidation>;
}

export class ProjectLayout extends Context.Service<ProjectLayout, ProjectLayoutShape>()(
  "kojo/host/ProjectLayout",
) {}
