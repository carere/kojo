import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { FactoryRefreshObservation } from "../models/FactoryRefresh.ts";
import { RevisionCaptureError } from "../models/RevisionCaptureError.ts";
import { captureWorkflowRevision } from "./captureRevision.ts";

interface Diagnostic {
  readonly subject: string;
  readonly standing: "ok" | "failed" | "skipped";
  readonly detail: string;
  readonly remedy?: string;
}

interface Validation {
  readonly formatVersion: 1;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

const workflowNames = (root: string): ReadonlyArray<string> => {
  const directory = join(root, ".kojo", "workflows");
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
      )
      .map((entry) => entry.name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
};

const validate = async (root: string): Promise<Validation> => {
  let entry: string;
  try {
    entry = Bun.resolveSync("@carere/kojo-runtime/validator/main", root);
  } catch (cause) {
    throw new RevisionCaptureError({
      code: "FACTORY_INVALID",
      message: cause instanceof Error ? cause.message : String(cause),
      remedy: "Install the Project-declared @carere/kojo-runtime and retry Factory Refresh.",
      cause,
    });
  }
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", entry, root], {
    cwd: root,
    env: {
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
    throw new RevisionCaptureError({
      code: "CAPTURE_FAILED",
      message: stderr.trim() || `Project validator exited ${exitCode}`,
      remedy: "Inspect the Project Runner environment, then retry Factory Refresh.",
    });
  }
  try {
    const result = JSON.parse(stdout) as Validation;
    if (result.formatVersion !== 1 || !Array.isArray(result.diagnostics)) {
      throw new Error("the Project validator returned an invalid document");
    }
    return result;
  } catch (cause) {
    throw new RevisionCaptureError({
      code: "CAPTURE_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
      remedy: "Repair the Project-local validator, then retry Factory Refresh.",
      cause,
    });
  }
};

const sharedSubjects = new Set([
  "assets",
  "commands",
  "effect",
  "envelopes",
  "factory",
  "roster",
  "validation",
  "workflows",
]);

/** Discover, validate, capture, and publish one complete current Factory observation. */
const refreshFactoryPromise = async (options: {
  readonly project: string;
  readonly dataRoot: string;
}): Promise<FactoryRefreshObservation> => {
  const factory = join(options.project, ".kojo");
  if (!existsSync(factory)) {
    return {
      factoryState: "missing",
      workflows: [],
      fault: "The Project has no .kojo directory.",
      remedy: "Run `kojo init` in this Project.",
    };
  }
  const names = workflowNames(options.project);
  let validation: Validation;
  try {
    validation = await validate(options.project);
  } catch (cause) {
    if (cause instanceof RevisionCaptureError && cause.code === "FACTORY_INVALID") {
      return {
        factoryState: "invalid",
        workflows: names.map((workflowName) => ({
          workflowName,
          availability: "invalid",
          source: join(factory, "workflows", `${workflowName}.ts`),
          sourceFault: cause.message,
          remedy: cause.remedy,
        })),
        fault: cause.message,
        remedy: cause.remedy,
      };
    }
    throw cause;
  }
  const sharedFailure = validation.diagnostics.find(
    (diagnostic) => diagnostic.standing === "failed" && sharedSubjects.has(diagnostic.subject),
  );
  if (sharedFailure !== undefined) {
    return {
      factoryState: "invalid",
      workflows: names.map((workflowName) => ({
        workflowName,
        availability: "invalid",
        source: join(factory, "workflows", `${workflowName}.ts`),
        sourceFault: `${sharedFailure.subject}: ${sharedFailure.detail}`,
        ...(sharedFailure.remedy === undefined ? {} : { remedy: sharedFailure.remedy }),
      })),
      fault: `${sharedFailure.subject}: ${sharedFailure.detail}`,
      ...(sharedFailure.remedy === undefined ? {} : { remedy: sharedFailure.remedy }),
    };
  }

  const workflows = [];
  for (const workflowName of names) {
    const localFailure = validation.diagnostics.find(
      (diagnostic) =>
        diagnostic.standing === "failed" && diagnostic.subject === `workflow:${workflowName}`,
    );
    if (localFailure !== undefined) {
      workflows.push({
        workflowName,
        availability: "invalid" as const,
        source: join(factory, "workflows", `${workflowName}.ts`),
        sourceFault: localFailure.detail,
        ...(localFailure.remedy === undefined ? {} : { remedy: localFailure.remedy }),
      });
      continue;
    }
    try {
      const revision = captureWorkflowRevision({
        project: options.project,
        dataRoot: options.dataRoot,
        workflowName,
      });
      workflows.push({
        workflowName,
        availability: "available" as const,
        source: join(factory, "workflows", `${workflowName}.ts`),
        revision,
      });
    } catch (cause) {
      if (cause instanceof RevisionCaptureError && cause.code === "WORKFLOW_INVALID") {
        workflows.push({
          workflowName,
          availability: "invalid" as const,
          source: join(factory, "workflows", `${workflowName}.ts`),
          sourceFault: cause.message,
          remedy: cause.remedy,
        });
        continue;
      }
      throw cause;
    }
  }
  return { factoryState: "available", workflows };
};

/** Discover, validate, capture, and publish one complete current Factory observation. */
export const refreshFactory = (options: {
  readonly project: string;
  readonly dataRoot: string;
}): Effect.Effect<FactoryRefreshObservation, RevisionCaptureError> =>
  Effect.tryPromise({
    try: () => refreshFactoryPromise(options),
    catch: (cause) =>
      cause instanceof RevisionCaptureError
        ? cause
        : new RevisionCaptureError({
            code: "CAPTURE_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
            remedy: "Repair the operational fault, then retry Factory Refresh.",
            cause,
          }),
  });
