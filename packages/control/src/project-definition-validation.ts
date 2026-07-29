import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

const packageManagerCommand = (root: string) => {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) {
    return "bun add @kojo/workflow";
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm add @kojo/workflow";
  if (existsSync(join(root, "yarn.lock"))) return "yarn add @kojo/workflow";
  return "npm install @kojo/workflow";
};

export const evaluateProjectDefinition = async (
  configurationPath: string,
): Promise<ProjectDefinitionValidation> => {
  const root = dirname(configurationPath);
  try {
    await Bun.resolve("@kojo/workflow", root);
  } catch {
    return {
      ok: false,
      findingKey: "dependency.workflow-package-missing",
      message: `The Project is missing the @kojo/workflow dependency. Run: ${packageManagerCommand(root)}.`,
    };
  }
  try {
    const built = await Bun.build({
      entrypoints: [configurationPath],
      format: "esm",
      target: "bun",
    });
    if (!built.success || built.outputs.length !== 1) throw new Error("build failed");
    const evaluationUrl = URL.createObjectURL(
      new Blob([await built.outputs[0].text()], { type: "text/javascript" }),
    );
    const module = await import(evaluationUrl).finally(() => URL.revokeObjectURL(evaluationUrl));
    const configuration = module.default as unknown;
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      !("workflows" in configuration) ||
      !Array.isArray(configuration.workflows)
    ) {
      return {
        ok: false,
        findingKey: "configuration.invalid",
        message:
          "Kojo Configuration is invalid; it must default-export defineConfig({ workflows: [...] }).",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration could not be loaded safely.",
    };
  }
};

export const validateProjectDefinitionInSubprocess = async (
  runnerPath: string,
  path: string,
  timeoutMs = 1_000,
): Promise<ProjectDefinitionValidation> => {
  let envelope: unknown;
  const child = Bun.spawn([process.execPath, runnerPath, path], {
    stdout: "ignore",
    stderr: "ignore",
    ipc: (message) => {
      envelope = message;
    },
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  if (timedOut) {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration validation timed out.",
    };
  }
  try {
    if (exitCode !== 0 || envelope === undefined) throw new Error("missing result");
    return Schema.decodeUnknownSync(ProjectDefinitionValidation)(envelope);
  } catch {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration could not be loaded safely.",
    };
  }
};
