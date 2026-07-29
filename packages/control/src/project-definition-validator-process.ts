import { randomUUID } from "node:crypto";

const RESULT_PREFIX = "KOJO_PROJECT_DEFINITION_RESULT ";

const report = (result: unknown) => {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
};

const path = process.argv[2];
if (path === undefined) {
  report({
    ok: false,
    findingKey: "configuration.load-failed",
    message: "Kojo Configuration path is missing.",
  });
  process.exitCode = 1;
} else {
  try {
    const built = await Bun.build({
      entrypoints: [path],
      format: "esm",
      plugins: [
        {
          name: "kojo-configuration-contract",
          setup(build) {
            build.onResolve({ filter: /^@kojo\/workflow$/ }, () => ({
              namespace: "kojo-configuration-contract",
              path: "@kojo/workflow",
            }));
            build.onLoad({ filter: /.*/, namespace: "kojo-configuration-contract" }, () => ({
              contents: "export const defineConfig = (configuration) => configuration;",
              loader: "js",
            }));
          },
        },
      ],
      target: "bun",
    });
    if (!built.success || built.outputs.length !== 1) throw new Error("build failed");
    const source = `${await built.outputs[0].text()}\n// ${randomUUID()}\n`;
    const encoded = Buffer.from(source).toString("base64");
    const module = await import(`data:text/javascript;base64,${encoded}`);
    const configuration = module.default as unknown;
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      !("workflows" in configuration) ||
      !Array.isArray(configuration.workflows)
    ) {
      report({
        ok: false,
        findingKey: "configuration.invalid",
        message:
          "Kojo Configuration is invalid; it must default-export defineConfig({ workflows: [...] }).",
      });
    } else {
      report({ ok: true });
    }
  } catch {
    report({
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration could not be loaded safely.",
    });
  }
}
