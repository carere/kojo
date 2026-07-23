import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { resolveKojoHome } from "../system/lifecycle";
import { inspectSystem } from "../system/process";

const projectId = Argument.string("project-id").pipe(
  Argument.withDescription("Installation-local Project ID"),
);
const workflowName = Argument.string("workflow-name").pipe(
  Argument.withDescription("Case-sensitive Developer Workflow stable name"),
);
const runId = Argument.string("run-id").pipe(Argument.withDescription("Workflow Run ID"));
const input = Flag.string("input").pipe(
  Flag.withDefault("{}"),
  Flag.withDescription("Developer Workflow input as JSON"),
);
const fromCheckout = Flag.boolean("from-checkout").pipe(
  Flag.withDescription("Freeze and run the current checkout, including dirty and untracked source"),
);

const request = (
  command: string,
  path: string,
  init?: { body?: unknown; method?: "GET" | "POST" },
) =>
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
    const response = await fetch(`http://localhost${path}`, {
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      method: init?.method ?? "GET",
      unix: system.endpoint,
    });
    const result = (await response.json()) as unknown;
    if (!response.ok) process.exitCode = 1;
    return result;
  }).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result))));

const startCommand = Command.make(
  "start",
  { fromCheckout, input, projectId, workflowName },
  ({ fromCheckout, input, projectId, workflowName }) => {
    let decodedInput: unknown;
    try {
      decodedInput = JSON.parse(input) as unknown;
    } catch {
      process.exitCode = 1;
      return Console.log(
        JSON.stringify({
          command: "workflow.start",
          error: { code: "INVALID_INPUT", message: "--input must be valid JSON" },
          schemaVersion: 1,
          status: "failed",
        }),
      );
    }
    return request("workflow.start", "/v1/workflow-runs", {
      body: { fromCheckout, input: decodedInput, projectId, workflowName },
      method: "POST",
    });
  },
).pipe(Command.withDescription("Start one typed root Developer Workflow"));

const inspectCommand = Command.make("inspect", { runId }, ({ runId }) =>
  request("workflow.inspect", `/v1/workflow-runs/${encodeURIComponent(runId)}`),
).pipe(Command.withDescription("Inspect a durable Workflow Run by Run ID"));

const suspendCommand = Command.make("suspend", { runId }, ({ runId }) =>
  request("workflow.suspend", `/v1/workflow-runs/${encodeURIComponent(runId)}/suspend`, {
    method: "POST",
  }),
).pipe(
  Command.withDescription("Suspend a Running Workflow Run after its current Activity settles"),
);

const resumeCommand = Command.make("resume", { runId }, ({ runId }) =>
  request("workflow.resume", `/v1/workflow-runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
  }),
).pipe(Command.withDescription("Resume a compatible unfinished Workflow Run"));

const discardCommand = Command.make("discard", { runId }, ({ runId }) =>
  request("workflow.discard", `/v1/workflow-runs/${encodeURIComponent(runId)}/discard`, {
    method: "POST",
  }),
).pipe(Command.withDescription("Discard an unfinished Workflow Run while preserving evidence"));

export const workflowCommand = Command.make("workflow").pipe(
  Command.withDescription("Start, inspect, and control durable Developer Workflow Runs"),
  Command.withSubcommands([
    startCommand,
    inspectCommand,
    suspendCommand,
    resumeCommand,
    discardCommand,
  ]),
);
