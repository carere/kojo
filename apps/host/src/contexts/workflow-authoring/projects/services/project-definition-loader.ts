import type { ProjectDefinitionValidation } from "@kojo/control/project-definition-validator";
import { Context } from "effect";

export interface ProjectDefinitionLoaderShape {
  readonly validate: (path: string) => Promise<ProjectDefinitionValidation>;
}

export class ProjectDefinitionLoader extends Context.Service<
  ProjectDefinitionLoader,
  ProjectDefinitionLoaderShape
>()("kojo/host/ProjectDefinitionLoader") {}
