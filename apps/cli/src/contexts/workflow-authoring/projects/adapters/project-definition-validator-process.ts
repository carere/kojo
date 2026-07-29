import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

type Send = (message: unknown) => boolean;
const send = process.send?.bind(process) as Send | undefined;
Object.defineProperty(process, "send", { configurable: true, value: undefined });

const packageManagerCommand = (root: string) => {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) {
    return "bun add @kojo/workflow";
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm add @kojo/workflow";
  if (existsSync(join(root, "yarn.lock"))) return "yarn add @kojo/workflow";
  return "npm install @kojo/workflow";
};

const configurationPath = process.argv[2];
if (configurationPath === undefined || send === undefined) {
  process.exitCode = 1;
} else {
  const root = dirname(configurationPath);
  try {
    await Bun.resolve("@kojo/workflow", root);
  } catch {
    send({
      ok: false,
      findingKey: "dependency.workflow-package-missing",
      message: `The Project is missing the @kojo/workflow dependency. Run: ${packageManagerCommand(root)}.`,
    });
    process.exit(0);
  }

  try {
    const built = await Bun.build({
      entrypoints: [configurationPath],
      format: "esm",
      target: "bun",
    });
    if (!built.success || built.outputs.length !== 1) throw new Error("build failed");
    const evaluationUrl = URL.createObjectURL(
      new Blob([await built.outputs[0].text()], { type: "text/javascript" }),
    );
    const module = await import(evaluationUrl).finally(() => URL.revokeObjectURL(evaluationUrl));
    const configuration = module.default as unknown;
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      !("workflows" in configuration) ||
      !Array.isArray(configuration.workflows)
    ) {
      send({
        ok: false,
        findingKey: "configuration.invalid",
        message:
          "Kojo Configuration is invalid; it must default-export defineConfig({ workflows: [...] }).",
      });
    } else {
      send({ ok: true });
    }
  } catch {
    send({
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration could not be loaded safely.",
    });
  }
}
