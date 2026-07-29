import { Context, Schema } from "effect";

const ProjectDefinitionFindingKey = Schema.Literals([
  "dependency.workflow-package-missing",
  "configuration.invalid",
  "configuration.load-failed",
]);

export const ProjectDefinitionValidation = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    findingKey: ProjectDefinitionFindingKey,
    message: Schema.String,
  }),
]);
export type ProjectDefinitionValidation = typeof ProjectDefinitionValidation.Type;

export interface ProjectDefinitionLoaderShape {
  readonly validate: (path: string) => Promise<ProjectDefinitionValidation>;
}

export class ProjectDefinitionLoader extends Context.Service<
  ProjectDefinitionLoader,
  ProjectDefinitionLoaderShape
>()("kojo/host/ProjectDefinitionLoader") {}
