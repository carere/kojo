import { Data, Effect } from "effect";
import { type Finding, failed } from "../models/Finding.ts";

interface PlainDiagnostic {
  readonly subject: string;
  readonly standing: "ok" | "failed" | "skipped";
  readonly detail: string;
  readonly remedy?: string;
}

interface PlainValidation {
  readonly formatVersion: 1;
  readonly diagnostics: ReadonlyArray<PlainDiagnostic>;
}

class StandaloneValidationError extends Data.TaggedError("StandaloneValidationError")<{
  readonly reason: string;
}> {}

const isDiagnostic = (value: unknown): value is PlainDiagnostic => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.subject === "string" &&
    (record.standing === "ok" || record.standing === "failed" || record.standing === "skipped") &&
    typeof record.detail === "string" &&
    (record.standing !== "failed" || typeof record.remedy === "string")
  );
};

const decode = (text: string): ReadonlyArray<Finding> => {
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object") throw new Error("the result is not an object");
  const report = value as Partial<PlainValidation>;
  if (
    report.formatVersion !== 1 ||
    !Array.isArray(report.diagnostics) ||
    !report.diagnostics.every(isDiagnostic)
  ) {
    throw new Error("the result is not a format-version 1 Project validation");
  }
  return report.diagnostics;
};

/** Run the Project-declared validator under the Project's Bun module environment. */
export const standaloneValidation = (root: string): Effect.Effect<ReadonlyArray<Finding>> =>
  Effect.tryPromise({
    try: async () => {
      const entry = Bun.resolveSync("@carere/kojo-runtime/validator/main", root);
      const child = Bun.spawn([process.execPath, entry, root], {
        cwd: root,
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
          TMPDIR: process.env.TMPDIR ?? "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `validator exited ${exitCode}`);
      }
      return decode(stdout);
    },
    catch: (cause) =>
      new StandaloneValidationError({
        reason:
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : String(cause),
      }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed([
        failed(
          "validation",
          `the Project-local validator could not run: ${cause.reason}`,
          "Declare `@carere/kojo-runtime` and its exact Effect peer in package.json, run this " +
            "Project's package-manager install, and run `kojo doctor` again.",
        ),
      ]),
    ),
  );
