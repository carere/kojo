import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  evaluateProjectDefinitionWith,
  type ProjectDefinitionValidation,
  selectProjectDefinitionInstallCommand,
  validateProjectDefinitionInSubprocessWith,
} from "./project-definition-validation";

export interface BunProjectDefinitionValidationAdapter {
  readonly evaluateProjectDefinition: (
    configurationPath: string,
  ) => Promise<ProjectDefinitionValidation>;
  readonly validateProjectDefinitionInSubprocess: (
    runnerPath: string,
    path: string,
    timeoutMs?: number,
  ) => Promise<ProjectDefinitionValidation>;
}

export const makeBunProjectDefinitionValidationAdapter = (
  loadDefaultExport: (configurationPath: string) => Promise<unknown>,
): BunProjectDefinitionValidationAdapter => ({
  evaluateProjectDefinition: (configurationPath) =>
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
        installCommand: (root) =>
          selectProjectDefinitionInstallCommand((name) => existsSync(join(root, name))),
        loadDefaultExport,
      },
      configurationPath,
      dirname(configurationPath),
    ),
  validateProjectDefinitionInSubprocess: (runnerPath, path, timeoutMs = 1_000) =>
    validateProjectDefinitionInSubprocessWith((receive) => {
      const child = Bun.spawn([process.execPath, runnerPath, path], {
        stdout: "ignore",
        stderr: "ignore",
        ipc: receive,
      });
      return { exited: child.exited, kill: () => child.kill("SIGKILL") };
    }, timeoutMs),
});
