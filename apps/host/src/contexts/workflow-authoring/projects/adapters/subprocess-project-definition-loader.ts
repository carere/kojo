import { validateProjectDefinition } from "@kojo/control/project-definition-validator";
import { Layer } from "effect";
import { ProjectDefinitionLoader } from "../services/project-definition-loader";

export const SubprocessProjectDefinitionLoaderLive = Layer.succeed(ProjectDefinitionLoader, {
  validate: validateProjectDefinition,
});
