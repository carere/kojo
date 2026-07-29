import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  evaluateProjectDefinitionWith,
  type ProjectDefinitionValidation as ProjectDefinitionValidationResult,
  selectProjectDefinitionInstallCommand,
  validateProjectDefinitionInSubprocessWith,
} from "@kojo/control/project-definition-validation";

const packageManagerCommand = (root: string) =>
  selectProjectDefinitionInstallCommand((name) => existsSync(join(root, name)));

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
): Promise<ProjectDefinitionValidationResult> =>
  validateProjectDefinitionInSubprocessWith((receive) => {
    const child = Bun.spawn([process.execPath, runnerPath, path], {
      stdout: "ignore",
      stderr: "ignore",
      ipc: receive,
    });
    return { exited: child.exited, kill: () => child.kill("SIGKILL") };
  }, timeoutMs);
