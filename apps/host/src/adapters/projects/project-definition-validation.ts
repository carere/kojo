import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  missingProjectDefinitionDependency,
  ProjectDefinitionValidation,
  type ProjectDefinitionValidation as ProjectDefinitionValidationResult,
  unavailableProjectDefinition,
  validateProjectDefinitionValue,
} from "@kojo/control/project-definition-validation";
import { Schema } from "effect";

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
): Promise<ProjectDefinitionValidationResult> => {
  const root = dirname(configurationPath);
  try {
    await Bun.resolve("@kojo/workflow", root);
  } catch {
    return missingProjectDefinitionDependency(packageManagerCommand(root));
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
    return validateProjectDefinitionValue(module.default);
  } catch {
    return unavailableProjectDefinition();
  }
};

export const validateProjectDefinitionInSubprocess = async (
  runnerPath: string,
  path: string,
  timeoutMs = 1_000,
): Promise<ProjectDefinitionValidationResult> => {
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
  if (timedOut) return unavailableProjectDefinition("Kojo Configuration validation timed out.");
  try {
    if (exitCode !== 0 || envelope === undefined) throw new Error("missing result");
    return Schema.decodeUnknownSync(ProjectDefinitionValidation)(envelope);
  } catch {
    return unavailableProjectDefinition();
  }
};
