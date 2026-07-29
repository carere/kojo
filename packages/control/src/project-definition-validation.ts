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

export interface ProjectDefinitionEvaluationPlatform {
  readonly dependencyAvailable: (root: string) => Promise<boolean>;
  readonly installCommand: (root: string) => string;
  readonly loadDefaultExport: (configurationPath: string) => Promise<unknown>;
}

export const evaluateProjectDefinitionWith = async (
  platform: ProjectDefinitionEvaluationPlatform,
  configurationPath: string,
  root: string,
): Promise<ProjectDefinitionValidation> => {
  if (!(await platform.dependencyAvailable(root))) {
    return missingProjectDefinitionDependency(platform.installCommand(root));
  }
  try {
    return validateProjectDefinitionValue(await platform.loadDefaultExport(configurationPath));
  } catch {
    return unavailableProjectDefinition();
  }
};

export interface ProjectDefinitionSubprocessResult {
  readonly envelope?: unknown;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export const validateProjectDefinitionSubprocessResult = (
  result: ProjectDefinitionSubprocessResult,
): ProjectDefinitionValidation => {
  if (result.timedOut) {
    return unavailableProjectDefinition("Kojo Configuration validation timed out.");
  }
  try {
    if (result.exitCode !== 0 || result.envelope === undefined) throw new Error("missing result");
    return Schema.decodeUnknownSync(ProjectDefinitionValidation)(result.envelope);
  } catch {
    return unavailableProjectDefinition();
  }
};

export const selectProjectDefinitionInstallCommand = (
  hasProjectFile: (name: string) => boolean,
) => {
  if (hasProjectFile("bun.lock") || hasProjectFile("bun.lockb")) {
    return "bun add @kojo/workflow";
  }
  if (hasProjectFile("pnpm-lock.yaml")) return "pnpm add @kojo/workflow";
  if (hasProjectFile("yarn.lock")) return "yarn add @kojo/workflow";
  return "npm install @kojo/workflow";
};

export interface ProjectDefinitionValidationProcess {
  readonly exited: Promise<number>;
  readonly kill: () => void;
}

export const validateProjectDefinitionInSubprocessWith = async (
  start: (receive: (envelope: unknown) => void) => ProjectDefinitionValidationProcess,
  timeoutMs: number,
): Promise<ProjectDefinitionValidation> => {
  let envelope: unknown;
  const child = start((message) => {
    envelope = message;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  return validateProjectDefinitionSubprocessResult({
    timedOut,
    exitCode,
    ...(envelope === undefined ? {} : { envelope }),
  });
};
