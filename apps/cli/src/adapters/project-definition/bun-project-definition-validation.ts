import { makeBunProjectDefinitionValidationAdapter } from "@kojo/control/bun-project-definition-validation";

export const { evaluateProjectDefinition, validateProjectDefinitionInSubprocess } =
  makeBunProjectDefinitionValidationAdapter(async (path) => {
    const built = await Bun.build({ entrypoints: [path], format: "esm", target: "bun" });
    if (!built.success || built.outputs.length !== 1) throw new Error("build failed");
    const url = URL.createObjectURL(
      new Blob([await built.outputs[0].text()], { type: "text/javascript" }),
    );
    const module = await import(url).finally(() => URL.revokeObjectURL(url));
    return module.default;
  });
