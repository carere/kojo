import { fileURLToPath } from "node:url";
import type { ReadinessFindingKey } from "@kojo/control";
import { Schema } from "effect";

const Validation = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    findingKey: Schema.Literals([
      "dependency.workflow-package-missing",
      "configuration.invalid",
      "configuration.load-failed",
    ]),
    message: Schema.String,
  }),
]);

export type ProjectDefinitionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly findingKey: Extract<
        ReadinessFindingKey,
        | "dependency.workflow-package-missing"
        | "configuration.invalid"
        | "configuration.load-failed"
      >;
      readonly message: string;
    };

const runnerPath = fileURLToPath(
  new URL("./project-definition-validator-process.ts", import.meta.url),
);

export const validateProjectDefinition = async (
  path: string,
  timeoutMs = 1_000,
): Promise<ProjectDefinitionValidation> => {
  let envelope: unknown;
  const child = Bun.spawn([process.execPath, runnerPath, path], {
    stdout: "ignore",
    stderr: "ignore",
    ipc: (message) => {
      envelope = message;
    },
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  if (timedOut) {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration validation timed out.",
    };
  }
  try {
    if (exitCode !== 0 || envelope === undefined) throw new Error("missing result");
    return Schema.decodeUnknownSync(Validation)(envelope);
  } catch {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration could not be loaded safely.",
    };
  }
};
