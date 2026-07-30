import { join, resolve } from "node:path";
import {
  type ProjectCondition,
  ProjectIdentity as ProjectIdentitySchema,
  type ProjectSelector,
  type ProjectSnapshot,
  type RequestKey,
} from "@kojo/control";
import {
  defaultSocketPath,
  makeDefaultLocalClient,
  makeNonActivatingLocalClient,
} from "@kojo/control/local-client";
import { Schema } from "effect";
import {
  initializeProject,
  ProjectInitializationError,
  resolveInitializedProject,
} from "../../workflow-authoring/projects/services/project-initializer";
import { resolveProjectSelectionPath } from "../../workflow-authoring/projects/services/project-selection-path";
import { validateProjectDefinition } from "../../workflow-authoring/projects/services/subprocess-project-definition-validator";
import { selectProject } from "../../workflow-authoring/projects/use-cases/select-project";
import { runEffect } from "./cli-effect";
import { canonicalSelectorPath, decodeRequestKey, parseOptions } from "./cli-options";
import {
  type CliFailure,
  invalid,
  pendingRegistrationWarning,
  projectCursorFailure,
  projectFailure,
  projectQueryFailure,
  transportFailure,
  writeFailure,
  writeProject,
} from "./cli-output";

export const runCliCommand = async (rawArgs: ReadonlyArray<string>) => {
  const json = rawArgs.includes("--json");
  const args = rawArgs.filter((argument) => argument !== "--json");

  if (args[0] === "workflow") {
    const options = parseOptions(args.slice(2));
    if (options === undefined) {
      return writeFailure(
        invalid("Run: kojo workflow validate|list|show"),
        json,
        `workflow.${args[1] ?? "unknown"}`,
      );
    }
    if (args[1] === "validate") {
      if (
        options.args.length > 1 ||
        options.projectId !== undefined ||
        options.projectPath !== undefined ||
        options.requestKey !== undefined ||
        options.conditions.length > 0 ||
        options.cursor !== undefined ||
        options.limit !== undefined
      ) {
        return writeFailure(
          invalid("Run: kojo workflow validate [Project path or kojo.config.ts] [--json]"),
          json,
          "workflow.validate",
        );
      }
      const input = options.args[0] ?? process.cwd();
      const configurationPath = input.endsWith(".ts")
        ? resolve(input)
        : join(resolve(input), "kojo.config.ts");
      const validation = await validateProjectDefinition(configurationPath);
      if (validation.ok) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              schemaVersion: 1,
              command: "workflow.validate",
              result: validation.snapshot,
              warnings: [],
            })}\n`,
          );
        } else {
          process.stdout.write(
            `Kojo Configuration is valid. Accepted Workflow Definitions: ${validation.snapshot.workflows.length}\n`,
          );
        }
        return 0;
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            command: "workflow.validate",
            error: {
              code: validation.findingKey,
              message: validation.message,
              findings: validation.findings,
            },
            warnings: [],
          })}\n`,
        );
      }
      process.stderr.write(`${validation.message}\n`);
      for (const finding of validation.findings.slice(1)) {
        process.stderr.write(`${finding.message}\n`);
      }
      return 1;
    }

    if (
      (args[1] !== "list" && args[1] !== "show") ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined ||
      options.requestKey !== undefined ||
      (args[1] === "list" && options.args.length !== 0) ||
      (args[1] === "show" && options.args.length !== 1)
    ) {
      return writeFailure(
        invalid(
          "Run: kojo workflow list [--project <path>|--project-id <Project Identity>] or kojo workflow show <Workflow Key> [--project <path>|--project-id <Project Identity>]",
        ),
        json,
        `workflow.${args[1] ?? "unknown"}`,
      );
    }
    let identity: ProjectSnapshot["identity"];
    if (options.projectId !== undefined) {
      try {
        identity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
      } catch {
        return writeFailure(invalid("Use a full Project Identity."), json, `workflow.${args[1]}`);
      }
    } else {
      try {
        identity = (await resolveInitializedProject(options.projectPath ?? process.cwd())).identity;
      } catch (error) {
        return writeFailure(
          invalid(
            error instanceof ProjectInitializationError
              ? error.message
              : "Choose an initialized Kojo Project.",
          ),
          json,
          `workflow.${args[1]}`,
        );
      }
    }
    const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());
    if (args[1] === "list") {
      const listed = await runEffect(client.listWorkflowDefinitions(identity));
      if (!listed.succeeded)
        return writeFailure(transportFailure(listed.error), json, "workflow.list");
      if (!listed.value.ok) {
        return writeFailure(projectQueryFailure(listed.value.error), json, "workflow.list");
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            command: "workflow.list",
            result: listed.value.snapshot,
            warnings: [],
          })}\n`,
        );
      } else {
        const workflows = listed.value.snapshot.definitions.workflows;
        process.stdout.write(
          `${workflows.length === 0 ? "No accepted Workflow Definitions." : workflows.map((workflow) => `${workflow.workflowKey}\t${workflow.revision}`).join("\n")}\n`,
        );
      }
      return 0;
    }
    const shown = await runEffect(client.showWorkflowDefinition(identity, options.args[0]));
    if (!shown.succeeded) return writeFailure(transportFailure(shown.error), json, "workflow.show");
    if (!shown.value.ok) {
      return writeFailure(projectQueryFailure(shown.value.error), json, "workflow.show");
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          command: "workflow.show",
          result: shown.value,
          warnings: [],
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${shown.value.workflow.workflowKey}\t${shown.value.workflow.revision}\t${shown.value.snapshotId}\n`,
      );
    }
    return 0;
  }

  if (args[0] === "init") {
    const options = parseOptions(args.slice(1));
    if (
      options === undefined ||
      options.args.length > 1 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined
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
          ...(error instanceof ProjectInitializationError && error.layoutMutated
            ? { requestKey }
            : {}),
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
      return writeFailure(projectFailure(registration.value), json, "init");
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
      return writeFailure(
        invalid(
          "Run: kojo project list [--condition <condition>] [--limit <1-200>] [--cursor <cursor>] [--json]",
        ),
        json,
        "project.list",
      );
    }
    const allowedConditions = new Set<ProjectCondition>(["ready", "limited", "needs-attention"]);
    if (
      options.conditions.some((condition) => !allowedConditions.has(condition as ProjectCondition))
    ) {
      return writeFailure(
        invalid("Use --condition ready, limited, or needs-attention."),
        json,
        "project.list",
      );
    }
    const limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return writeFailure(
        invalid("Use --limit with a whole number from 1 to 200."),
        json,
        "project.list",
      );
    }
    const listed = await runEffect(
      client.listProjectPage({
        conditions: options.conditions as ReadonlyArray<ProjectCondition>,
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }),
    );
    if (!listed.succeeded)
      return writeFailure(transportFailure(listed.error), json, "project.list");
    if (!listed.value.ok)
      return writeFailure(projectCursorFailure(listed.value.error), json, "project.list");
    const page = listed.value.page;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command: "project.list", result: page, warnings: [] })}\n`,
      );
    } else {
      const lines =
        page.items.length === 0
          ? "No Kojo Projects."
          : page.items
              .map((project) => `${project.identity}\t${project.condition}\t${project.path}`)
              .join("\n");
      process.stdout.write(`${lines}\n`);
      if (page.nextCursor !== null)
        process.stdout.write(
          `More Projects are available. Continue with --cursor ${page.nextCursor}\n`,
        );
    }
    return 0;
  }

  if (args[1] === "register") {
    if (
      options.args.length !== 1 ||
      options.projectId !== undefined ||
      options.projectPath !== undefined ||
      options.conditions.length > 0 ||
      options.cursor !== undefined ||
      options.limit !== undefined
    ) {
      return writeFailure(
        invalid("Run: kojo project register <path> [--request-key <Request Key>] [--json]"),
        json,
        "project.register",
      );
    }
    const requestKey = decodeRequestKey(options.requestKey);
    if (requestKey === undefined) {
      return writeFailure(
        invalid("Use a non-empty Request Key of at most 256 characters."),
        json,
        "project.register",
      );
    }
    const result = await runEffect(client.registerProject(options.args[0], requestKey));
    if (!result.succeeded) {
      return writeFailure(transportFailure(result.error), json, "project.register");
    }
    if (!result.value.ok) {
      return writeFailure(projectFailure(result.value), json, "project.register");
    }
    writeProject("project.register", result.value.project, json, result.value);
    return 0;
  }

  if (
    (args[1] !== "show" && args[1] !== "forget") ||
    options.args.length !== 0 ||
    options.conditions.length > 0 ||
    options.cursor !== undefined ||
    options.limit !== undefined ||
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
  let forgetSelector: ProjectSelector | undefined;
  const forgetRequestKey = args[1] === "forget" ? decodeRequestKey(options.requestKey) : undefined;
  if (args[1] === "forget" && forgetRequestKey === undefined) {
    return writeFailure(
      invalid("Use a non-empty Request Key of at most 256 characters."),
      json,
      "project.forget",
    );
  }
  if (args[1] === "forget" && options.projectId !== undefined) {
    try {
      forgetIdentity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
      forgetSelector = { kind: "identity", identity: forgetIdentity };
    } catch {
      return writeFailure(invalid("Use a full Project Identity."), json, "project.forget");
    }
  } else if (args[1] === "forget") {
    forgetSelector = {
      kind: "path",
      path: await canonicalSelectorPath(options.projectPath ?? process.cwd()),
    };
    try {
      forgetIdentity = (await resolveInitializedProject(options.projectPath ?? process.cwd()))
        .identity;
    } catch {
      // A damaged or unavailable local Project can still be selected from the Host Index below.
    }
  }

  if (forgetIdentity === undefined && chosen === undefined) {
    const projects: Array<ProjectSnapshot> = [];
    let cursor: string | undefined;
    let listFailure: CliFailure | undefined;
    do {
      const list = await runEffect(
        client.listProjectPage({
          conditions: [],
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (!list.succeeded) {
        listFailure = transportFailure(list.error);
        break;
      }
      if (!list.value.ok) {
        listFailure = projectCursorFailure(list.value.error);
        break;
      }
      projects.push(...list.value.page.items);
      cursor = list.value.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    if (listFailure !== undefined) {
      if (args[1] === "show") {
        return writeFailure(listFailure, json, "project.show");
      }
    } else {
      const selection = await selectProject(
        projects,
        options,
        options.projectId === undefined
          ? await resolveProjectSelectionPath(options.projectPath ?? process.cwd())
          : undefined,
      );
      if ("exitCode" in selection) {
        if (args[1] === "show") {
          return writeFailure(selection, json, "project.show");
        }
      } else {
        chosen = selection;
      }
    }
  }

  if (args[1] === "show") {
    if (chosen === undefined) {
      return writeFailure(invalid("Choose a Kojo Project."), json, "project.show");
    }
    const shown = await runEffect(client.showProject(chosen.identity));
    if (!shown.succeeded) {
      return writeFailure(transportFailure(shown.error), json, "project.show");
    }
    if (!shown.value.ok) {
      return writeFailure(projectQueryFailure(shown.value.error), json, "project.show");
    }
    writeProject("project.show", shown.value.project, json);
    return 0;
  }

  const requestKey = forgetRequestKey as RequestKey;
  const identity = forgetIdentity ?? chosen?.identity;
  const selector = forgetSelector as ProjectSelector;
  const forgotten = await runEffect(
    identity === undefined
      ? client.replayForgetProject(selector, requestKey)
      : client.forgetProject(identity, selector, requestKey),
  );
  if (!forgotten.succeeded) {
    return writeFailure(transportFailure(forgotten.error), json, "project.forget");
  }
  if (!forgotten.value.ok) {
    return writeFailure(projectFailure(forgotten.value), json, "project.forget");
  }
  if (json) writeProject("project.forget", forgotten.value.project, true, forgotten.value);
  else {
    process.stdout.write(
      `Forgot Kojo Project ${forgotten.value.project.identity}. Project files were not changed.\nRequest Key: ${forgotten.value.requestKey}\n`,
    );
  }
  return 0;
};
