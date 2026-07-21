import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { resolveKojoHome } from "../system/lifecycle";
import { inspectSystem } from "../system/process";

const projectId = Argument.string("project-id").pipe(
  Argument.withDescription("Installation-local Project ID"),
);
const scheduleName = Argument.string("schedule-name").pipe(
  Argument.withDescription("Case-sensitive Workflow Schedule name"),
);

const request = (command: string, path: string, method: "GET" | "POST" = "GET") =>
  Effect.promise(async () => {
    const system = await inspectSystem(resolveKojoHome());
    if (system === undefined) {
      process.exitCode = 1;
      return {
        command,
        error: { code: "SYSTEM_UNAVAILABLE", message: "The Kojo System Process is not running" },
        schemaVersion: 1,
        status: "failed",
      };
    }
    const response = await fetch(`http://localhost${path}`, { method, unix: system.endpoint });
    const result = (await response.json()) as unknown;
    if (!response.ok) process.exitCode = 1;
    return result;
  }).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result))));

const listCommand = Command.make("list", { projectId }, ({ projectId }) =>
  request("schedule.list", `/v1/projects/${encodeURIComponent(projectId)}/schedules`),
).pipe(Command.withDescription("List durable Workflow Schedules for a Project"));

const inspectCommand = Command.make(
  "inspect",
  { projectId, scheduleName },
  ({ projectId, scheduleName }) =>
    request(
      "schedule.inspect",
      `/v1/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleName)}`,
    ),
).pipe(Command.withDescription("Inspect Schedule enablement, cursor, catch-up, and history"));

const stateCommand = (operation: "disable" | "enable") =>
  Command.make(operation, { projectId, scheduleName }, ({ projectId, scheduleName }) =>
    request(
      `schedule.${operation}`,
      `/v1/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleName)}/${operation}`,
      "POST",
    ),
  ).pipe(Command.withDescription(`${operation} one installation-local Workflow Schedule`));

export const scheduleCommand = Command.make("schedule").pipe(
  Command.withDescription("Inspect and control durable Workflow Schedules"),
  Command.withSubcommands([
    listCommand,
    inspectCommand,
    stateCommand("enable"),
    stateCommand("disable"),
  ]),
);
