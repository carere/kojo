import { fileURLToPath } from "node:url";
import type { ReadinessFindingKey } from "./index";

export type ProjectDefinitionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly findingKey: Extract<
        ReadinessFindingKey,
        "configuration.invalid" | "configuration.load-failed"
      >;
      readonly message: string;
    };

export interface ProjectDefinitionValidatorOptions {
  readonly timeoutMs?: number;
}

const RESULT_PREFIX = "KOJO_PROJECT_DEFINITION_RESULT ";
const runnerPath = fileURLToPath(
  new URL("./project-definition-validator-process.ts", import.meta.url),
);

export const validateProjectDefinition = async (
  path: string,
  options: ProjectDefinitionValidatorOptions = {},
): Promise<ProjectDefinitionValidation> => {
  const child = Bun.spawn([process.execPath, runnerPath, path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? 1_000);
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (timedOut) {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration validation timed out.",
    };
  }
  const resultLine = stdout
    .split("\n")
    .toReversed()
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (exitCode !== 0 || resultLine === undefined) {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration could not be loaded safely.",
    };
  }
  try {
    return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as ProjectDefinitionValidation;
  } catch {
    return {
      ok: false,
      findingKey: "configuration.load-failed",
      message: "Kojo Configuration returned an invalid validation result.",
    };
  }
};
