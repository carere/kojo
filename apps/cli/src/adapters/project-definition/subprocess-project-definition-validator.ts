import { fileURLToPath } from "node:url";
import { validateProjectDefinitionInSubprocess } from "@kojo/control/bun-project-definition-validation";

const runnerPath = fileURLToPath(
  new URL("./project-definition-validator-process.ts", import.meta.url),
);

export const validateProjectDefinition = (path: string, timeoutMs = 1_000) =>
  validateProjectDefinitionInSubprocess(runnerPath, path, timeoutMs);
