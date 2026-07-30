import { fileURLToPath } from "node:url";
import { Layer } from "effect";
import { validateProjectDefinitionInSubprocess } from "./bun-project-definition-validation";
import { ProjectDefinitionLoader } from "./project-definition-loader";

const runnerPath = fileURLToPath(
  new URL("./project-definition-loader-process.ts", import.meta.url),
);

export const validateProjectDefinition = (path: string, timeoutMs = 1_000) =>
  validateProjectDefinitionInSubprocess(runnerPath, path, timeoutMs);

export const SubprocessProjectDefinitionLoaderLive = Layer.succeed(ProjectDefinitionLoader, {
  load: validateProjectDefinition,
});
