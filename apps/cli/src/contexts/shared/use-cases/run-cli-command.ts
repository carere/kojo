import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import {
  ProjectIdentity as ProjectIdentitySchema,
  type ProjectOperationError,
  type ProjectSnapshot,
} from "@kojo/control";
import {
  defaultSocketPath,
  IncompatibleProtocolError,
  LocalTransportError,
  makeDefaultLocalClient,
} from "@kojo/control/local-client";
import { Effect, Schema } from "effect";
import {
  initializeProject,
  ProjectInitializationError,
} from "../../workflow-authoring/projects/services/project-initializer";
import { renderHostOverview } from "../../workflow-execution/projects/use-cases/render-host-overview";

interface CliFailure {
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
  readonly next: string;
}

type EffectOutcome<A, E> =
  | { readonly succeeded: true; readonly value: A }
  | { readonly succeeded: false; readonly error: E };

const runEffect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): EffectOutcome<A, E> => ({ succeeded: false, error }),
        onSuccess: (value): EffectOutcome<A, E> => ({ succeeded: true, value }),
      }),
    ),
  );

const invalid = (next: string): CliFailure => ({
  code: "invalid-command",
  exitCode: 2,
  message: "Invalid command.",
  next,
});

const transportFailure = (error: unknown): CliFailure =>
  error instanceof IncompatibleProtocolError
    ? {
        code: "incompatible-protocol",
        exitCode: 3,
        message: error.message,
        next: "Upgrade Kojo Host or this CLI so their protocol major versions match.",
      }
    : error instanceof LocalTransportError
      ? {
          code: "host-unavailable",
          exitCode: 3,
          message: error.message,
          next: "Start the Kojo Host and try again.",
        }
      : {
          code: "host-request-failed",
          exitCode: 3,
          message: "Kojo Host request failed.",
          next: "Try the command again.",
        };

const projectFailure = (error: ProjectOperationError): CliFailure => ({
  ...error,
  exitCode: error.code === "project-layout-invalid" ? 1 : 4,
});

const writeFailure = (failure: CliFailure, json: boolean, command: string) => {
  process.stderr.write(`${failure.message}\nNext: ${failure.next}\n`);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        error: { code: failure.code, message: failure.message, next: failure.next },
        warnings: [],
      })}\n`,
    );
  }
  return failure.exitCode;
};

const writeProject = (command: string, project: ProjectSnapshot, json: boolean) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command, projectIdentity: project.identity, result: { project }, warnings: [] })}\n`,
    );
  } else {
    process.stdout.write(`Project Identity: ${project.identity}\nPath: ${project.path}\n`);
  }
};

interface ParsedSelection {
  readonly args: ReadonlyArray<string>;
  readonly projectId?: string;
  readonly projectPath?: string;
}

const parseSelection = (args: ReadonlyArray<string>): ParsedSelection | undefined => {
  const remaining: Array<string> = [];
  let projectId: string | undefined;
  let projectPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--project" && argument !== "--project-id") {
      remaining.push(argument);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    index += 1;
    if (argument === "--project") projectPath = value;
    else projectId = value;
  }
  if (projectId !== undefined && projectPath !== undefined) return undefined;
  return { args: remaining, projectId, projectPath };
};

const decodeProjectIdentity = (value: string) => {
  try {
    return Schema.decodeUnknownSync(ProjectIdentitySchema)(value);
  } catch {
    return undefined;
  }
};

const selectProject = async (
  projects: ReadonlyArray<ProjectSnapshot>,
  selection: ParsedSelection,
): Promise<ProjectSnapshot | CliFailure> => {
  if (selection.projectId !== undefined) {
    const identity = decodeProjectIdentity(selection.projectId);
    if (identity === undefined)
      return invalid("Use a full Project Identity from kojo project list.");
    const project = projects.find((candidate) => candidate.identity === identity);
    return (
      project ?? {
        code: "project-not-found",
        exitCode: 4,
        message: "Kojo Project was not found in the Project Index.",
        next: "Register the Project or choose a listed Project Identity.",
      }
    );
  }
  let path: string;
  try {
    path = await realpath(selection.projectPath ?? process.cwd());
  } catch {
    return {
      code: "project-not-found",
      exitCode: 4,
      message: "Kojo Project could not be inferred from this path.",
      next: "Use --project or --project-id, or register the Project.",
    };
  }
  const matches = projects
    .filter((project) => path === project.path || path.startsWith(`${project.path}${sep}`))
    .sort((left, right) => right.path.length - left.path.length);
  return (
    matches[0] ?? {
      code: "project-not-found",
      exitCode: 4,
      message: "Kojo Project could not be inferred from this path.",
      next: "Use --project or --project-id, or register the Project.",
    }
  );
};

export const runCliCommand = async (rawArgs: ReadonlyArray<string>) => {
  const json = rawArgs.includes("--json");
  const args = rawArgs.filter((argument) => argument !== "--json");
  const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());

  if (args[0] === "init") {
    if (args.length > 2 || args.some((argument) => argument.startsWith("--"))) {
      return writeFailure(invalid("Run: kojo init [path] [--json]"), json, "init");
    }
    let project: ProjectSnapshot;
    try {
      project = await initializeProject(args[1] ?? process.cwd());
    } catch (error) {
      const failure: CliFailure = {
        code: "project-initialization-failed",
        exitCode: 1,
        message:
          error instanceof ProjectInitializationError
            ? error.message
            : "Kojo Project initialization failed safely.",
        next: "Correct the Project layout and try again.",
      };
      return writeFailure(failure, json, "init");
    }
    const registration = await runEffect(client.registerProject(project.path));
    if (!registration.succeeded) {
      return writeFailure(transportFailure(registration.error), json, "init");
    }
    if (!registration.value.ok) {
      return writeFailure(projectFailure(registration.value.error), json, "init");
    }
    if (json) writeProject("init", registration.value.project, true);
    else {
      process.stdout.write(
        `Initialized Kojo Project at ${registration.value.project.path}\nProject Identity: ${registration.value.project.identity}\n`,
      );
    }
    return 0;
  }

  if (args[0] !== "project") {
    return writeFailure(
      invalid("Run: kojo init [path] or kojo project list|show|register|forget"),
      json,
      args.length === 0 ? "kojo" : args.join("."),
    );
  }

  const selection = parseSelection(args.slice(2));
  if (selection === undefined) {
    return writeFailure(
      invalid("Use either --project <path> or --project-id <Project Identity>."),
      json,
      `project.${args[1] ?? "unknown"}`,
    );
  }

  if (args[1] === "list") {
    if (
      selection.args.length !== 0 ||
      selection.projectId !== undefined ||
      selection.projectPath !== undefined
    ) {
      return writeFailure(invalid("Run: kojo project list [--json]"), json, "project.list");
    }
    const overview = await runEffect(client.getHostOverview);
    if (!overview.succeeded) {
      return writeFailure(transportFailure(overview.error), json, "project.list");
    }
    process.stdout.write(renderHostOverview(overview.value, json));
    return 0;
  }

  if (args[1] === "register") {
    if (
      selection.args.length !== 1 ||
      selection.projectId !== undefined ||
      selection.projectPath !== undefined
    ) {
      return writeFailure(
        invalid("Run: kojo project register <path> [--json]"),
        json,
        "project.register",
      );
    }
    const result = await runEffect(client.registerProject(selection.args[0]));
    if (!result.succeeded) {
      return writeFailure(transportFailure(result.error), json, "project.register");
    }
    if (!result.value.ok) {
      return writeFailure(projectFailure(result.value.error), json, "project.register");
    }
    writeProject("project.register", result.value.project, json);
    return 0;
  }

  if ((args[1] !== "show" && args[1] !== "forget") || selection.args.length !== 0) {
    return writeFailure(
      invalid("Run: kojo project list|show|register|forget"),
      json,
      `project.${args[1] ?? "unknown"}`,
    );
  }

  const list = await runEffect(client.listProjects);
  if (!list.succeeded) {
    return writeFailure(transportFailure(list.error), json, `project.${args[1]}`);
  }
  const chosen = await selectProject(list.value.projects, selection);
  if ("exitCode" in chosen) return writeFailure(chosen, json, `project.${args[1]}`);

  if (args[1] === "show") {
    writeProject("project.show", chosen, json);
    return 0;
  }

  const forgotten = await runEffect(client.forgetProject(chosen.identity));
  if (!forgotten.succeeded) {
    return writeFailure(transportFailure(forgotten.error), json, "project.forget");
  }
  if (!forgotten.value.ok) {
    return writeFailure(projectFailure(forgotten.value.error), json, "project.forget");
  }
  if (json) writeProject("project.forget", forgotten.value.project, true);
  else {
    process.stdout.write(
      `Forgot Kojo Project ${forgotten.value.project.identity}. Project files were not changed.\n`,
    );
  }
  return 0;
};
