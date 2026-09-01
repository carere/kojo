import type { WorkflowSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { DaemonPaths } from "../contexts/daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { commandFailed } from "./CommandFailed.ts";

class WorkflowClientError extends Data.TaggedError("WorkflowClientError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

const productionPaths = (): DaemonPaths => {
  if (process.platform === "darwin") return macPaths();
  if (process.platform === "linux") return linuxPaths();
  throw new WorkflowClientError({ reason: "Kojo Workflow inspection supports macOS and Linux" });
};

const readSnapshot = (projectId?: string): Effect.Effect<WorkflowSnapshot, WorkflowClientError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(productionPaths());
      if (endpoint === undefined)
        throw new Error("the Daemon is not ready; run `kojo daemon status`");
      const path =
        projectId === undefined
          ? "/api/v1/workflows"
          : `/api/v1/projects/${encodeURIComponent(projectId)}/workflows`;
      const response = await fetch(`http://localhost${path}`, {
        unix: endpoint.socketPath,
        headers: { accept: "application/json" },
      } as RequestInit & { readonly unix: string });
      if (!response.ok)
        throw new Error(`the Daemon refused Workflow inspection (${response.status})`);
      return (await response.json()) as WorkflowSnapshot;
    },
    catch: (cause) =>
      new WorkflowClientError({
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export const workflowLines = (snapshot: WorkflowSnapshot): ReadonlyArray<string> =>
  snapshot.workflows.map((workflow) =>
    [
      workflow.projectId,
      workflow.workflowName,
      `Project=${workflow.projectState}`,
      `Factory=${workflow.factoryState}`,
      `Refresh=${workflow.refreshState}`,
      `Activity=${workflow.activity}`,
      `Workflow=${workflow.availability}`,
      `Source=${workflow.sourceFault ?? workflow.source}`,
      `Revision=${workflow.candidateRevisionId ?? workflow.currentRevisionId ?? "none"}`,
      `Trigger=${workflow.trigger.state}`,
    ].join("\t"),
  );

const render = (snapshot: WorkflowSnapshot, json: boolean): Effect.Effect<void> => {
  if (json) return Console.log(JSON.stringify(snapshot));
  if (snapshot.workflows.length === 0) return Console.log("No Project Workflows are recorded.");
  return Effect.forEach(workflowLines(snapshot), (line) => Console.log(line), { discard: true });
};

const list = Command.make(
  "list",
  {
    projectId: Flag.string("project").pipe(
      Flag.withDescription("Select one full Project ID"),
      Flag.optional,
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Write one JSON snapshot")),
  },
  Effect.fn(function* ({ projectId, json }) {
    const snapshot = yield* readSnapshot(Option.getOrUndefined(projectId)).pipe(
      Effect.catch((cause) => commandFailed(cause.reason)),
    );
    yield* render(snapshot, json);
  }),
).pipe(Command.withDescription("List Project, Factory, refresh, revision, and Trigger state"));

const status = Command.make(
  "status",
  {
    projectId: Argument.string("project-id"),
    workflowName: Argument.string("workflow-name"),
    json: Flag.boolean("json").pipe(Flag.withDescription("Write one JSON snapshot")),
  },
  Effect.fn(function* ({ projectId, workflowName, json }) {
    const snapshot = yield* readSnapshot(projectId).pipe(
      Effect.catch((cause) => commandFailed(cause.reason)),
    );
    const selected = snapshot.workflows.filter(
      (workflow) => workflow.projectId === projectId && workflow.workflowName === workflowName,
    );
    if (selected.length === 0) {
      return yield* commandFailed("the selected Project Workflow was not found");
    }
    yield* render(
      { ...snapshot, workflows: selected, counts: { ...snapshot.counts, total: 1 } },
      json,
    );
  }),
).pipe(Command.withDescription("Inspect one Project Workflow by full structured identity"));

export const workflow = Command.make("workflow").pipe(
  Command.withDescription("Inspect Daemon-owned Project Workflows without executing them"),
  Command.withSubcommands([list, status]),
);
