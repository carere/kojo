import { pathToFileURL } from "node:url";
import { makeBunProjectDefinitionValidationAdapter } from "@kojo/control/bun-project-definition-validation";

export const { evaluateProjectDefinition, validateProjectDefinitionInSubprocess } =
  makeBunProjectDefinitionValidationAdapter(async (path) => {
    const url = pathToFileURL(path);
    url.searchParams.set("kojo-validation", crypto.randomUUID());
    const module = await import(url.href);
    return module.default;
  });
