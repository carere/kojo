import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
      configurationExists: async (path) => existsSync(path),
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
        const url = pathToFileURL(path);
        url.searchParams.set("kojo-validation", crypto.randomUUID());
        const module = await import(url.href);
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
