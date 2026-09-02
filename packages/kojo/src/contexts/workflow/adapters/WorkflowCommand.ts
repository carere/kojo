import { readFile } from "node:fs/promises";
import type {
  RunDocument,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type {
  StartTriggerWorkflowResult,
  StopWorkflowResult,
  WorkflowSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { clientExit } from "../../../cli/ClientExit.ts";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import { prepareHostClientRequest } from "../../daemon/adapters/prepareHostClientRequest.ts";
import type { DaemonPaths } from "../../daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../../daemon/services/daemonStatus.ts";
import { linuxPaths } from "../../daemon/services/linuxPaths.ts";
import { macPaths } from "../../daemon/services/macPaths.ts";

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
      `Trigger=${workflow.trigger.state}${workflow.trigger.detail === undefined ? "" : `:${workflow.trigger.detail}`}`,
      `CurrentRuns=${workflow.currentRuns.length}`,
    ].join("\t"),
  );

const render = (snapshot: WorkflowSnapshot, json: boolean): Effect.Effect<void> => {
  if (json) return Console.log(JSON.stringify(snapshot));
  if (snapshot.workflows.length === 0) return Console.log("No Project Workflows are recorded.");
  return Effect.forEach(workflowLines(snapshot), (line) => Console.log(line), { discard: true });
};

export const decodePayloadText = (text: string): unknown => JSON.parse(text) as unknown;

export const timeoutMillis = (text: string): number | undefined => {
  if (text === "none") return undefined;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (match === null)
    throw new Error("--timeout needs positive ms, s, m, h, bare seconds, or none");
  const value = Number(match[1]);
  if (!(value > 0)) throw new Error("--timeout must be positive");
  const scale =
    match[2] === "ms" ? 1 : match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 1_000;
  return value * scale;
};

const startRun = Command.make(
  "start",
  {
    projectId: Argument.string("project-id"),
    workflowName: Argument.string("workflow-name"),
    payload: Flag.string("payload").pipe(Flag.optional),
    payloadFile: Flag.string("payload-file").pipe(Flag.optional),
    wait: Flag.boolean("wait"),
    timeout: Flag.string("timeout").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ projectId, workflowName, payload, payloadFile, wait, timeout, json }) {
    const inline = Option.getOrUndefined(payload);
    const file = Option.getOrUndefined(payloadFile);
    if (inline !== undefined && file !== undefined) {
      return yield* clientExit(2, "Start accepts at most one --payload or --payload-file");
    }
    if (!wait && Option.isSome(timeout)) {
      return yield* clientExit(2, "--timeout is valid only with --wait");
    }
    const parsed = yield* Effect.tryPromise({
      try: async () => {
        if (inline === undefined && file === undefined) return undefined;
        const text =
          inline ??
          (file === "-"
            ? await readFile("/dev/stdin", "utf8")
            : await readFile(file as string, "utf8"));
        return decodePayloadText(text);
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.catch((message) =>
        clientExit(2, `the supplied payload is not valid JSON: ${message}`),
      ),
    );
    const deadline = yield* Effect.try({
      try: () => {
        const duration = Option.isSome(timeout) ? timeoutMillis(timeout.value) : 60_000;
        return duration === undefined ? undefined : Date.now() + duration;
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    const result = yield* Effect.tryPromise({
      try: async () => {
        const endpoint = readDaemonEndpoint(productionPaths());
        if (endpoint === undefined)
          throw new Error("the Daemon is not ready; run `kojo daemon start`");
        const requestId = crypto.randomUUID();
        prepareHostClientRequest(productionPaths(), {
          mutationVersion: 1,
          requestId,
          dataIdentity: endpoint.dataIdentity,
          operation: "startWorkflow",
          target: { identityVersion: 1, kind: "workflow", parts: [projectId, workflowName] },
          arguments: parsed === undefined ? {} : { payload: parsed as JsonValue },
          preconditions: {},
        });
        const path = `/api/v1/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/actions/start`;
        const response = await fetch(`http://localhost${path}`, {
          unix: endpoint.socketPath,
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            requestId,
            dataIdentity: endpoint.dataIdentity,
            ...(parsed === undefined ? {} : { payload: parsed }),
          }),
        } as RequestInit & { readonly unix: string });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { readonly message?: string };
          throw new Error(body.message ?? `the Daemon refused Start (${response.status})`);
        }
        return {
          endpoint,
          result: (await response.json()) as StartRunResult | StartTriggerWorkflowResult,
        };
      },
      catch: (cause) =>
        new WorkflowClientError({
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    if (!wait) {
      if (result.result.kind === "trigger") {
        yield* Console.log(
          json
            ? JSON.stringify({ formatVersion: 1, ...result.result })
            : `Workflow ${workflowName} is active and its Trigger is listening.`,
        );
        return;
      }
      yield* Console.log(
        json
          ? JSON.stringify({ formatVersion: 1, ...result.result })
          : `Run ${result.result.runId} admitted at revision ${result.result.revisionId}.`,
      );
      return;
    }
    if (result.result.kind === "trigger") {
      yield* Console.log(
        json
          ? JSON.stringify({ formatVersion: 1, ...result.result })
          : `Workflow ${workflowName} is active and its Trigger is listening.`,
      );
      return;
    }
    const runResult = result.result;
    let run: RunDocument | undefined;
    while (deadline === undefined || Date.now() < deadline) {
      const response = yield* Effect.promise(() =>
        fetch(`http://localhost/api/v1/runs/${encodeURIComponent(runResult.runId)}`, {
          unix: result.endpoint.socketPath,
          headers: { accept: "application/json" },
        } as RequestInit & { readonly unix: string }),
      );
      if (response.ok) {
        run = (yield* Effect.promise(() => response.json())) as RunDocument;
        if (run.state === "succeeded" || run.state === "failed") break;
      }
      yield* Effect.sleep("50 millis");
    }
    if (run?.state !== "succeeded" && run?.state !== "failed") {
      return yield* clientExit(3, `Run ${runResult.runId} continues after the client timeout`);
    }
    yield* Console.log(
      json ? JSON.stringify({ formatVersion: 1, run }) : `Run ${run.runId} ${run.state}.`,
    );
    if (run.state === "failed") return yield* clientExit(1, `Run ${run.runId} failed`);
  }),
).pipe(Command.withDescription("Admit one no-Trigger JSON Run through the Daemon"));

const stopWorkflow = Command.make(
  "stop",
  {
    projectId: Argument.string("project-id"),
    workflowName: Argument.string("workflow-name"),
    force: Flag.boolean("force"),
    wait: Flag.boolean("wait"),
    timeout: Flag.string("timeout").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ projectId, workflowName, force, wait, timeout, json }) {
    if (!wait && Option.isSome(timeout)) {
      return yield* clientExit(2, "--timeout is valid only with --wait");
    }
    const duration = yield* Effect.try({
      try: () => (wait ? timeoutMillis(Option.getOrUndefined(timeout) ?? "60s") : undefined),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    const deadline = duration === undefined ? undefined : Date.now() + duration;
    const receipt = yield* Effect.tryPromise({
      try: async () => {
        const endpoint = readDaemonEndpoint(productionPaths());
        if (endpoint === undefined)
          throw new Error("the Daemon is not ready; run `kojo daemon start`");
        const requestId = crypto.randomUUID();
        prepareHostClientRequest(productionPaths(), {
          mutationVersion: 1,
          requestId,
          dataIdentity: endpoint.dataIdentity,
          operation: "stopWorkflow",
          target: { identityVersion: 1, kind: "workflow", parts: [projectId, workflowName] },
          arguments: { ...(force ? { force } : {}) },
          preconditions: {},
        });
        const path = `/api/v1/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/actions/stop`;
        const response = await fetch(`http://localhost${path}`, {
          unix: endpoint.socketPath,
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            requestId,
            dataIdentity: endpoint.dataIdentity,
            ...(force ? { force: true } : {}),
          }),
        } as RequestInit & { readonly unix: string });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { readonly message?: string };
          throw new Error(body.message ?? `the Daemon refused Stop (${response.status})`);
        }
        return (await response.json()) as StopWorkflowResult;
      },
      catch: (cause) =>
        new WorkflowClientError({
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(
      json
        ? JSON.stringify({ formatVersion: 1, ...receipt })
        : force
          ? `Workflow ${workflowName} is inactive. Forced Stop targeted ${receipt.targetedRunIds?.length ?? 0} Runs.`
          : `Workflow ${workflowName} is inactive. Its admitted Runs remain eligible.`,
    );
    if (force && wait) {
      const endpoint = readDaemonEndpoint(productionPaths());
      if (endpoint === undefined) return yield* commandFailed("the Daemon endpoint disappeared");
      for (const runId of receipt.targetedRunIds ?? []) {
        let stopped = false;
        while (deadline === undefined || Date.now() < deadline) {
          const response = yield* Effect.promise(() =>
            fetch(`http://localhost/api/v1/runs/${encodeURIComponent(runId)}`, {
              unix: endpoint.socketPath,
              headers: { accept: "application/json" },
            } as RequestInit & { readonly unix: string }),
          );
          if (response.ok) {
            const run = (yield* Effect.promise(() => response.json())) as RunDocument;
            if (run.state === "cancelled") {
              stopped = true;
              break;
            }
            if (run.state === "succeeded" || run.state === "failed") {
              return yield* clientExit(
                1,
                `Run ${runId} reached ${run.state}; forced cancellation did not take effect`,
              );
            }
          }
          yield* Effect.sleep("50 millis");
        }
        if (!stopped) {
          return yield* clientExit(3, `Forced Stop target ${runId} still has executing work`);
        }
      }
    }
  }),
).pipe(
  Command.withDescription("Stop future Trigger admission; --force cancels the accepted target set"),
);

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
  Command.withDescription("Start and inspect Daemon-owned Project Workflows"),
  Command.withSubcommands([list, status, startRun, stopWorkflow]),
);
