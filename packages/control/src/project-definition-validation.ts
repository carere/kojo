import { Schema } from "effect";

export const ProjectDefinitionValidation = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    findingKey: Schema.Literals([
      "dependency.workflow-package-missing",
      "configuration.invalid",
      "configuration.load-failed",
    ]),
    message: Schema.String,
  }),
]);
export type ProjectDefinitionValidation = typeof ProjectDefinitionValidation.Type;

export const missingProjectDefinitionDependency = (
  installCommand: string,
): ProjectDefinitionValidation => ({
  ok: false,
  findingKey: "dependency.workflow-package-missing",
  message: `The Project is missing the @kojo/workflow dependency. Run: ${installCommand}.`,
});

export const invalidProjectDefinition = (): ProjectDefinitionValidation => ({
  ok: false,
  findingKey: "configuration.invalid",
  message:
    "Kojo Configuration is invalid; it must default-export defineConfig({ workflows: [...] }).",
});

export const unavailableProjectDefinition = (
  message = "Kojo Configuration could not be loaded safely.",
): ProjectDefinitionValidation => ({
  ok: false,
  findingKey: "configuration.load-failed",
  message,
});

export const validateProjectDefinitionValue = (
  configuration: unknown,
): ProjectDefinitionValidation =>
  typeof configuration === "object" &&
  configuration !== null &&
  "workflows" in configuration &&
  Array.isArray(configuration.workflows)
    ? { ok: true }
    : invalidProjectDefinition();
