import { randomUUID } from "node:crypto";
import {
  ProjectIdentity as ProjectIdentitySchema,
  type ProjectMutationResult,
  type ProjectOperationError,
  type ProjectSnapshot,
  type RequestKey,
  RequestKey as RequestKeySchema,
} from "@kojo/control";
import {
  defaultSocketPath,
  IncompatibleProtocolError,
  LocalTransportError,
  makeDefaultLocalClient,
  makeNonActivatingLocalClient,
} from "@kojo/control/local-client";
import { Effect, Schema } from "effect";
import {
  initializeProject,
  ProjectInitializationError,
  resolveInitializedProject,
} from "../contexts/workflow-authoring/projects/services/project-initializer";
import { selectProject } from "../contexts/workflow-execution/projects/use-cases/select-project";
import { renderHostOverview } from "./render-host-overview";

interface CliFailure {
  readonly affectedResource?: ProjectOperationError["affectedResource"];
  readonly code: string;
  readonly exitCode: number;
  readonly findingKeys?: ReadonlyArray<string>;
  readonly message: string;
  readonly next: string;
}

interface CliWarning {
  readonly code: string;
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
        error: {
          code: failure.code,
          message: failure.message,
          next: failure.next,
          ...(failure.affectedResource === undefined
            ? {}
            : { affectedResource: failure.affectedResource }),
          ...(failure.findingKeys === undefined ? {} : { findingKeys: failure.findingKeys }),
        },
        warnings: [],
      })}\n`,
    );
  }
  return failure.exitCode;
};

const writeProject = (
  command: string,
  project: ProjectSnapshot,
  json: boolean,
  mutation?: Extract<ProjectMutationResult, { ok: true }>,
  warnings: ReadonlyArray<CliWarning> = [],
  pendingRequestKey?: RequestKey,
) => {
  const requestKey = mutation?.requestKey ?? pendingRequestKey;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        projectIdentity: project.identity,
        ...(requestKey === undefined ? {} : { requestKey }),
        result: {
          project,
          ...(mutation === undefined ? {} : { alreadyApplied: mutation.alreadyApplied }),
        },
        warnings,
      })}\n`,
    );
  } else {
    process.stdout.write(`Project Identity: ${project.identity}\nPath: ${project.path}\n`);
    if (requestKey !== undefined) process.stdout.write(`Request Key: ${requestKey}\n`);
    for (const warning of warnings) {
      process.stderr.write(`Warning: ${warning.message}\nNext: ${warning.next}\n`);
    }
  }
};

interface ParsedOptions {
  readonly args: ReadonlyArray<string>;
  readonly projectId?: string;
  readonly projectPath?: string;
  readonly requestKey?: string;
}

const parseOptions = (args: ReadonlyArray<string>): ParsedOptions | undefined => {
  const remaining: Array<string> = [];
  let projectId: string | undefined;
  let projectPath: string | undefined;
  let requestKey: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--project" && argument !== "--project-id" && argument !== "--request-key") {
      remaining.push(argument);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    index += 1;
    if (argument === "--project") {
      if (projectPath !== undefined) return undefined;
      projectPath = value;
    } else if (argument === "--project-id") {
      if (projectId !== undefined) return undefined;
      projectId = value;
    } else {
      if (requestKey !== undefined) return undefined;
      requestKey = value;
    }
  }
  if (projectId !== undefined && projectPath !== undefined) return undefined;
  return { args: remaining, projectId, projectPath, requestKey };
};

const decodeRequestKey = (value: string | undefined): RequestKey | undefined => {
  try {
    return Schema.decodeUnknownSync(RequestKeySchema)(value ?? randomUUID());
  } catch {
    return undefined;
  }
};

const pendingRegistrationWarning = (project: ProjectSnapshot): CliWarning => ({
  code: "project-registration-pending",
  message: "The Kojo Project is initialized, but the Host was not available for registration.",
  next: `Run: kojo project register ${project.path}`,
});

export const runCliCommand = async (rawArgs: ReadonlyArray<string>) => {
  const json = rawArgs.includes("--json");
  const args = rawArgs.filter((argument) => argument !== "--json");

  if (args[0] === "init") {
    const options = parseOptions(args.slice(1));
    if (
      options === undefined ||
      options.args.length > 1 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined
    ) {
      return writeFailure(
        invalid("Run: kojo init [path] [--request-key <Request Key>] [--json]"),
        json,
        "init",
      );
    }
    const requestKey = decodeRequestKey(options.requestKey);
    if (requestKey === undefined) {
      return writeFailure(invalid("Use a full Request Key."), json, "init");
    }
    let project: ProjectSnapshot;
    try {
      project = await initializeProject(options.args[0] ?? process.cwd());
    } catch (error) {
      return writeFailure(
        {
          code: "project-initialization-failed",
          exitCode: 1,
          message:
            error instanceof ProjectInitializationError
              ? error.message
              : "Kojo Project initialization failed safely.",
          next: "Correct the Project layout and try again.",
        },
        json,
        "init",
      );
    }

    const client = makeNonActivatingLocalClient(
      process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
    );
    const registration = await runEffect(client.registerProject(project.path, requestKey));
    if (!registration.succeeded) {
      const warning = pendingRegistrationWarning(project);
      if (json) writeProject("init", project, true, undefined, [warning], requestKey);
      else {
        process.stdout.write(
          `Initialized Kojo Project at ${project.path}\nProject Identity: ${project.identity}\nRequest Key: ${requestKey}\n`,
        );
        process.stderr.write(`Warning: ${warning.message}\nNext: ${warning.next}\n`);
      }
      return 0;
    }
    if (!registration.value.ok) {
      return writeFailure(projectFailure(registration.value.error), json, "init");
    }
    if (json) writeProject("init", registration.value.project, true, registration.value);
    else {
      process.stdout.write(
        `Initialized Kojo Project at ${registration.value.project.path}\nProject Identity: ${registration.value.project.identity}\nRequest Key: ${registration.value.requestKey}\n`,
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

  const options = parseOptions(args.slice(2));
  if (options === undefined) {
    return writeFailure(
      invalid("Use each option once and choose either --project or --project-id."),
      json,
      `project.${args[1] ?? "unknown"}`,
    );
  }
  const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());

  if (args[1] === "list") {
    if (
      options.args.length !== 0 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined ||
      options.requestKey !== undefined
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
      options.args.length !== 1 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined
    ) {
      return writeFailure(
        invalid("Run: kojo project register <path> [--request-key <Request Key>] [--json]"),
        json,
        "project.register",
      );
    }
    const requestKey = decodeRequestKey(options.requestKey);
    if (requestKey === undefined) {
      return writeFailure(invalid("Use a full Request Key."), json, "project.register");
    }
    const result = await runEffect(client.registerProject(options.args[0], requestKey));
    if (!result.succeeded) {
      return writeFailure(transportFailure(result.error), json, "project.register");
    }
    if (!result.value.ok) {
      return writeFailure(projectFailure(result.value.error), json, "project.register");
    }
    writeProject("project.register", result.value.project, json, result.value);
    return 0;
  }

  if (
    (args[1] !== "show" && args[1] !== "forget") ||
    options.args.length !== 0 ||
    (args[1] === "show" && options.requestKey !== undefined)
  ) {
    return writeFailure(
      invalid("Run: kojo project list|show|register|forget"),
      json,
      `project.${args[1] ?? "unknown"}`,
    );
  }

  let chosen: ProjectSnapshot | undefined;
  let forgetIdentity: ProjectSnapshot["identity"] | undefined;
  if (args[1] === "forget" && options.projectId !== undefined) {
    try {
      forgetIdentity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
    } catch {
      return writeFailure(invalid("Use a full Project Identity."), json, "project.forget");
    }
  } else if (args[1] === "forget") {
    try {
      forgetIdentity = (await resolveInitializedProject(options.projectPath ?? process.cwd()))
        .identity;
    } catch {
      // A damaged or unavailable local Project can still be selected from the Host Index below.
    }
  }

  if (forgetIdentity === undefined && chosen === undefined) {
    const list = await runEffect(client.listProjects);
    if (!list.succeeded) {
      return writeFailure(transportFailure(list.error), json, `project.${args[1]}`);
    }
    const selection = await selectProject(list.value.projects, options);
    if ("exitCode" in selection) {
      return writeFailure(selection, json, `project.${args[1]}`);
    }
    chosen = selection;
  }

  if (args[1] === "show") {
    if (chosen === undefined) {
      return writeFailure(invalid("Choose a Kojo Project."), json, "project.show");
    }
    writeProject("project.show", chosen, json);
    return 0;
  }

  const requestKey = decodeRequestKey(options.requestKey);
  if (requestKey === undefined) {
    return writeFailure(invalid("Use a full Request Key."), json, "project.forget");
  }
  const identity = forgetIdentity ?? chosen?.identity;
  if (identity === undefined) {
    return writeFailure(invalid("Choose a Kojo Project."), json, "project.forget");
  }
  const forgotten = await runEffect(client.forgetProject(identity, requestKey));
  if (!forgotten.succeeded) {
    return writeFailure(transportFailure(forgotten.error), json, "project.forget");
  }
  if (!forgotten.value.ok) {
    return writeFailure(projectFailure(forgotten.value.error), json, "project.forget");
  }
  if (json) writeProject("project.forget", forgotten.value.project, true, forgotten.value);
  else {
    process.stdout.write(
      `Forgot Kojo Project ${forgotten.value.project.identity}. Project files were not changed.\nRequest Key: ${forgotten.value.requestKey}\n`,
    );
  }
  return 0;
};
