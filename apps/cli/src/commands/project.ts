import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { resolveKojoHome } from "../system/lifecycle";
import { inspectSystem } from "../system/process";

const projectId = Argument.string("project-id").pipe(
  Argument.withDescription("Installation-local Project ID"),
);
const path = Argument.string("path").pipe(
  Argument.withDescription("Git repository root path to register"),
);

const request = (
  command: string,
  endpointPath: string,
  options?: { readonly body?: unknown; readonly method?: "GET" | "POST" },
) =>
  Effect.promise(async () => {
    const home = resolveKojoHome();
    const system = await inspectSystem(home);
    if (system === undefined) {
      process.exitCode = 1;
      return {
        command,
        error: {
          action: "Start the Kojo System Process with `kojo start` and retry the command.",
          code: "SYSTEM_UNAVAILABLE",
          message: "The Kojo System Process is not running",
        },
        schemaVersion: 1,
        status: "failed",
      };
    }

    try {
      const response = await fetch(`http://localhost${endpointPath}`, {
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        headers: options?.body === undefined ? undefined : { "content-type": "application/json" },
        method: options?.method ?? "GET",
        unix: system.endpoint,
      });
      const result = (await response.json()) as unknown;
      if (!response.ok) {
        process.exitCode = 1;
      }
      return result;
    } catch (error) {
      process.exitCode = 1;
      return {
        command,
        error: {
          action: "Inspect `kojo status` and `kojo logs`, then retry the command.",
          code: "SYSTEM_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        },
        schemaVersion: 1,
        status: "failed",
      };
    }
  }).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result))));

const addCommand = Command.make("add", { path }, ({ path }) =>
  request("project.add", "/v1/projects", { body: { path }, method: "POST" }),
).pipe(Command.withDescription("Register a Git repository root as a Disabled Project"));

const listCommand = Command.make("list", {}, () => request("project.list", "/v1/projects")).pipe(
  Command.withDescription("List Projects from durable System Process state"),
);

const stateCommand = (operation: "archive" | "disable" | "enable") =>
  Command.make(operation, { projectId }, ({ projectId }) =>
    request(`project.${operation}`, `/v1/projects/${encodeURIComponent(projectId)}/${operation}`, {
      method: "POST",
    }),
  ).pipe(Command.withDescription(`${operation} a Project without changing its Project ID`));

const relinkCommand = Command.make("relink", { projectId, path }, ({ path, projectId }) =>
  request("project.relink", `/v1/projects/${encodeURIComponent(projectId)}/relink`, {
    body: { path },
    method: "POST",
  }),
).pipe(Command.withDescription("Change a Project repository root without changing its Project ID"));

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage installation-local Projects through the System Process"),
  Command.withSubcommands([
    addCommand,
    listCommand,
    stateCommand("enable"),
    stateCommand("disable"),
    relinkCommand,
    stateCommand("archive"),
  ]),
);
