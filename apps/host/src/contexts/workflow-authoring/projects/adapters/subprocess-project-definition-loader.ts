import { fileURLToPath } from "node:url";
import { validateProjectDefinitionInSubprocess } from "@kojo/control/project-definition-validation";
import { Layer } from "effect";
import { ProjectDefinitionLoader } from "../services/project-definition-loader";

const runnerPath = fileURLToPath(
  new URL("./project-definition-loader-process.ts", import.meta.url),
);

export const validateProjectDefinition = (path: string, timeoutMs = 1_000) =>
  validateProjectDefinitionInSubprocess(runnerPath, path, timeoutMs);

export const SubprocessProjectDefinitionLoaderLive = Layer.succeed(ProjectDefinitionLoader, {
  validate: validateProjectDefinition,
});
