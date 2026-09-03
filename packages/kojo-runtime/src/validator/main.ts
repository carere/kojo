import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer, Schema } from "effect";
import * as YamlRoster from "../contexts/agent/adapters/YamlRoster.ts";
import { Roster } from "../contexts/agent/ports/Roster.ts";
import { contractSchema } from "../contexts/agent/services/renderPrompt.ts";
import { isPlaceholder } from "../contexts/workflow/models/Placeholder.ts";

/** One plain diagnostic returned across the standalone validator boundary. */
/** @public */
export interface ProjectDiagnostic {
  readonly subject: string;
  readonly standing: "ok" | "failed" | "skipped";
  readonly detail: string;
  readonly remedy?: string;
  readonly triggerDeclared?: boolean;
}

/** The standalone result. It contains no Effect value or application service. */
/** @public */
export interface ProjectValidation {
  readonly formatVersion: 1;
  readonly diagnostics: ReadonlyArray<ProjectDiagnostic>;
}

const ok = (subject: string, detail: string): ProjectDiagnostic => ({
  subject,
  standing: "ok",
  detail,
});

const failed = (subject: string, detail: string, remedy: string): ProjectDiagnostic => ({
  subject,
  standing: "failed",
  detail,
  remedy,
});

const oneLine = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause))
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? String(cause);

const hasProperties = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

const isDefinition = (value: unknown): value is Record<string, unknown> =>
  hasProperties(value) &&
  typeof value.execute === "function" &&
  typeof value.poll === "function" &&
  typeof value.idempotencyKey === "function" &&
  typeof value._tag === "string" &&
  hasProperties(value.payloadSchema) &&
  hasProperties(value.payloadSchema.fields);

const isBundle = (
  value: unknown,
): value is {
  readonly definition: Record<string, unknown>;
  readonly layer: Layer.Layer<unknown>;
  readonly trigger?: Layer.Layer<unknown>;
} =>
  hasProperties(value) &&
  isDefinition(value.definition) &&
  Layer.isLayer(value.layer) &&
  (value.trigger === undefined || Layer.isLayer(value.trigger));

const safeAsset = (asset: string): boolean => {
  if (asset === "" || isAbsolute(asset)) return false;
  const normal = relative(".", resolve(".", asset));
  return normal !== ".." && !normal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};

const assetsDiagnostic = async (factory: string): Promise<ProjectDiagnostic> => {
  const source = join(factory, "factory.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(source, "utf8")) as unknown;
  } catch (cause) {
    return failed(
      "assets",
      `${source}: ${oneLine(cause)}`,
      "Restore `.kojo/factory.json` with `formatVersion: 1` and an `assets` array of paths relative to `.kojo`.",
    );
  }

  if (!hasProperties(decoded) || decoded.formatVersion !== 1 || !Array.isArray(decoded.assets)) {
    return failed(
      "assets",
      `${source} is not a format-version 1 Factory asset declaration`,
      "Set `formatVersion` to 1 and `assets` to an array of relative paths.",
    );
  }

  const assets = decoded.assets;
  if (!assets.every((asset): asset is string => typeof asset === "string" && safeAsset(asset))) {
    return failed(
      "assets",
      `${source} contains an absolute or escaping asset path`,
      "Use only relative paths that stay below `.kojo`.",
    );
  }

  const forbidden = assets.find(
    (asset) => asset === ".env" || asset.startsWith("data/") || asset === "data",
  );
  if (forbidden !== undefined) {
    return failed(
      "assets",
      `${forbidden} is credential or runtime data and cannot be a Factory asset`,
      "Remove credentials and runtime data from `.kojo/factory.json`.",
    );
  }

  for (const asset of assets) {
    const target = join(factory, asset);
    try {
      if (!(await stat(target)).isFile()) throw new Error("not a regular file");
    } catch (cause) {
      return failed(
        "assets",
        `${target}: ${oneLine(cause)}`,
        "Restore the declared asset or remove its declaration if no Workflow needs it.",
      );
    }
  }

  return ok("assets", `${assets.length} declared Factory assets are readable`);
};

const commandsDiagnostic = async (factory: string): Promise<ProjectDiagnostic> => {
  const source = join(factory, "commands.ts");
  try {
    const loaded = (await import(pathToFileURL(source).href)) as Record<string, unknown>;
    const commands = loaded.commands;
    if (!hasProperties(commands)) {
      return failed(
        "commands",
        `${source} does not export a commands record`,
        "Restore the `commands` export.",
      );
    }
    const placeholders = Object.entries(commands)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .filter(([, command]) => isPlaceholder(command))
      .map(([name]) => name);
    return placeholders.length === 0
      ? ok("commands", `every command in ${source} is real`)
      : failed(
          "commands",
          `${placeholders.join(", ")} ${placeholders.length === 1 ? "is still a placeholder" : "are still placeholders"}`,
          `Write the real commands in ${source}.`,
        );
  } catch (cause) {
    return failed(
      "commands",
      `${source}: ${oneLine(cause)}`,
      "Install the declared Project packages and fix the import named above.",
    );
  }
};

const rosterDiagnostic = async (factory: string): Promise<ProjectDiagnostic> => {
  const source = join(factory, "kojo.config.yaml");
  try {
    const names = await Effect.runPromise(
      Effect.map(Roster, (roster) => roster.names).pipe(
        Effect.provide(YamlRoster.layer({ config: source }).pipe(Layer.provide(BunServices.layer))),
      ),
    );
    return ok("roster", `${names.length} agent${names.length === 1 ? "" : "s"}; prompts read`);
  } catch (cause) {
    return failed(
      "roster",
      `${source}: ${oneLine(cause)}`,
      "Fix the roster entry or the prompt path named above.",
    );
  }
};

const envelopesDiagnostic = async (factory: string): Promise<ProjectDiagnostic> => {
  const source = join(factory, "envelopes.ts");
  try {
    const module = (await import(pathToFileURL(source).href)) as Record<string, unknown>;
    const hidden: Array<string> = [];
    let count = 0;
    for (const [name, value] of Object.entries(module)) {
      if (!hasProperties(value) || !hasProperties(value.fields)) continue;
      count += 1;
      const rendered = contractSchema(value as unknown as Schema.Top) as unknown as {
        readonly properties?: Record<string, { readonly allOf?: ReadonlyArray<unknown> }>;
      };
      for (const [field, fieldSchema] of Object.entries(value.fields)) {
        if (!hasProperties(fieldSchema) || !hasProperties(fieldSchema.ast)) continue;
        const declared = Array.isArray(fieldSchema.ast.checks) ? fieldSchema.ast.checks.length : 0;
        const shown = rendered.properties?.[field]?.allOf?.length ?? 0;
        if (declared > shown)
          hidden.push(`${name}.\`${field}\` — ${declared - shown} of ${declared} rule not shown`);
      }
    }
    return hidden.length === 0
      ? ok("envelopes", `${count} envelopes; every rule is in the contract`)
      : failed(
          "envelopes",
          hidden.join(" · "),
          "Replace each hidden programmatic check with a renderable Schema check or state the rule in the agent prompt.",
        );
  } catch (cause) {
    return failed(
      "envelopes",
      `${source}: ${oneLine(cause)}`,
      "Fix the envelope module or its Project-runtime imports.",
    );
  }
};

const effectDiagnostic = async (factory: string): Promise<ProjectDiagnostic> => {
  try {
    const runtimeEffect = await realpath(Bun.resolveSync("effect", import.meta.dir));
    const authoredEffect = await realpath(Bun.resolveSync("effect", factory));
    return runtimeEffect === authoredEffect
      ? ok("effect", `Factory and Project runtime resolve one Effect instance at ${runtimeEffect}`)
      : failed(
          "effect",
          `Factory resolves ${authoredEffect}, but the Project runtime resolves ${runtimeEffect}`,
          "Declare the exact Effect peer required by `@carere/kojo-runtime`, then reinstall Project packages.",
        );
  } catch (cause) {
    return failed(
      "effect",
      oneLine(cause),
      "Declare the exact Effect peer required by `@carere/kojo-runtime`, then reinstall Project packages.",
    );
  }
};

const workflowDiagnostic = async (factory: string): Promise<ReadonlyArray<ProjectDiagnostic>> => {
  const directory = join(factory, "workflows");
  let names: ReadonlyArray<string>;
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
      )
      .map((entry) => entry.name.slice(0, -3))
      .sort();
  } catch (cause) {
    return [
      failed(
        "workflows",
        `${directory}: ${oneLine(cause)}`,
        "Restore `.kojo/workflows` and its top-level Workflow source files.",
      ),
    ];
  }

  const diagnostics: ProjectDiagnostic[] = [];
  const loaded: Array<{
    readonly name: string;
    readonly definition: Record<string, unknown>;
    readonly triggerDeclared: boolean;
  }> = [];
  for (const name of names) {
    const source = join(directory, `${name}.ts`);
    try {
      const module = (await import(pathToFileURL(source).href)) as Record<string, unknown>;
      const bundles = Object.values(module).filter(isBundle);
      if (bundles.length !== 1) {
        diagnostics.push(
          failed(
            `workflow:${name}`,
            `${source} exports ${bundles.length} Workflows; one file must export one Workflow`,
            "Export exactly one value returned by `workflow(...)`.",
          ),
        );
        continue;
      }
      const declared = bundles[0]?.definition._tag;
      if (declared !== name) {
        diagnostics.push(
          failed(
            `workflow:${name}`,
            `${source} declares ${String(declared)} instead of ${name}`,
            "Make the Workflow name agree with its file name.",
          ),
        );
        continue;
      }
      loaded.push({
        name,
        definition: bundles[0]?.definition ?? {},
        triggerDeclared: bundles[0]?.trigger !== undefined,
      });
    } catch (cause) {
      diagnostics.push(
        failed(
          `workflow:${name}`,
          `${source}: ${oneLine(cause)}`,
          "Fix the Factory import or Workflow declaration named above.",
        ),
      );
    }
  }

  for (const { name, definition, triggerDeclared } of loaded) {
    const schema = definition.payloadSchema;
    if (!hasProperties(schema) || !hasProperties(schema.fields)) continue;
    const fields = Object.keys(schema.fields);
    const field = fields[0];
    if (fields.length !== 1 || field === undefined) continue;
    try {
      const decoded = await Effect.runPromise(
        Schema.decodeEffect(schema as unknown as Schema.Codec<unknown, unknown, never, never>)({
          [field]: "kojo doctor",
        }),
      );
      const key = (definition.idempotencyKey as (value: unknown) => unknown)(decoded);
      if (typeof key !== "string") throw new Error("the idempotency key is not a string");
      diagnostics.push({
        ...ok(`workflow:${name}`, "declaration, Layer, payload, and key are valid"),
        triggerDeclared,
      });
    } catch (cause) {
      diagnostics.push(
        failed(
          `workflow:${name}`,
          `${name}: ${oneLine(cause)}`,
          "Fix the Workflow payload schema or its idempotency key.",
        ),
      );
    }
  }

  return [
    ok(
      "workflows",
      `${names.length === 0 ? "no" : names.join(", ")} top-level Project Workflows discovered`,
    ),
    ...diagnostics,
    ok(
      "layers",
      `${loaded.length} valid Workflow layer${loaded.length === 1 ? "" : "s"} inspected; no Workflow was run`,
    ),
  ];
};

/**
 * Validate authored Factory contracts without execution authority.
 *
 * This function does not construct an engine, claim a Run, build an image, execute a command, or
 * call an agent. It only reads files and imports authored declarations.
 */
/** @public */
export const validateProject = async (root: string): Promise<ProjectValidation> => {
  const project = await realpath(resolve(root));
  const factory = join(project, ".kojo");
  if (!existsSync(factory)) {
    return {
      formatVersion: 1,
      diagnostics: [
        failed("factory", `${factory} does not exist`, "Run `kojo init` in this repository."),
      ],
    };
  }

  const diagnostics = await Promise.all([
    assetsDiagnostic(factory),
    effectDiagnostic(factory),
    commandsDiagnostic(factory),
    envelopesDiagnostic(factory),
    rosterDiagnostic(factory),
  ]);
  return {
    formatVersion: 1,
    diagnostics: [...diagnostics, ...(await workflowDiagnostic(factory))],
  };
};

/** Stable standalone validator entry point. */
/** @public */
export const validatorEntryPointVersion = 1 as const;

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  validateProject(root).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (cause) =>
      process.stdout.write(
        `${JSON.stringify({
          formatVersion: 1,
          diagnostics: [
            failed(
              "validation",
              oneLine(cause),
              "Fix the Project path or package installation and run `kojo doctor` again.",
            ),
          ],
        } satisfies ProjectValidation)}\n`,
      ),
  );
}
