import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  evaluateProjectDefinitionWith,
  type ProjectDefinitionValidation as ProjectDefinitionValidationResult,
  validateProjectDefinitionSubprocessResult,
} from "./project-definition-validation";

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
): Promise<ProjectDefinitionValidationResult> =>
  evaluateProjectDefinitionWith(
    {
      dependencyAvailable: async (root) => {
        try {
          await Bun.resolve("@kojo/workflow", root);
          return true;
        } catch {
          return false;
        }
      },
      installCommand: packageManagerCommand,
      loadDefaultExport: async (path) => {
        const built = await Bun.build({ entrypoints: [path], format: "esm", target: "bun" });
        if (!built.success || built.outputs.length !== 1) throw new Error("build failed");
        const url = URL.createObjectURL(
          new Blob([await built.outputs[0].text()], { type: "text/javascript" }),
        );
        const module = await import(url).finally(() => URL.revokeObjectURL(url));
        return module.default;
      },
    },
    configurationPath,
    dirname(configurationPath),
  );

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
  return validateProjectDefinitionSubprocessResult({
    timedOut,
    exitCode,
    ...(envelope === undefined ? {} : { envelope }),
  });
};
