import type { ProjectDefinitionValidation } from "@kojo/control/project-definition-validation";
import { Context } from "effect";

export interface ProjectDefinitionLoaderShape {
  /**
   * Runs the configuration in a bounded subprocess and returns only its
   * serializable validation snapshot. Workflow handlers never cross this seam.
   */
  readonly load: (path: string) => Promise<ProjectDefinitionValidation>;
}

export class ProjectDefinitionLoader extends Context.Service<
  ProjectDefinitionLoader,
  ProjectDefinitionLoaderShape
>()("kojo/host/ProjectDefinitionLoader") {}
