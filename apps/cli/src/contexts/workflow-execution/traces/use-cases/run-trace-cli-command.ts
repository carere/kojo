import {
  EMPTY_EXECUTION_TRACE_FILTERS,
  ProjectIdentity as ProjectIdentitySchema,
  type ProjectSnapshot,
  type WorkflowRunId,
  WorkflowRunId as WorkflowRunIdSchema,
} from "@kojo/control";
import { defaultSocketPath, makeDefaultLocalClient } from "@kojo/control/local-client";
import { Effect, Exit, Schema, Stream } from "effect";
import { runEffect } from "../../../shared/cli/cli-effect";
import { parseOptions } from "../../../shared/cli/cli-options";
import {
  invalid,
  transportFailure,
  workflowRunFailure,
  writeExecutionTraceEvent,
  writeExecutionTracePage,
  writeFailure,
} from "../../../shared/cli/cli-output";
import {
  ProjectInitializationError,
  resolveInitializedProject,
} from "../../../workflow-authoring/projects/services/project-initializer";

/** The workflow-execution CLI boundary for chronological Trace inspection. */
export const runTraceCliCommand = async (args: ReadonlyArray<string>, json: boolean) => {
  const options = parseOptions(args.slice(2));
  const operation = args[1];
  const command = `trace.${operation ?? "unknown"}`;
  if (options === undefined || (operation !== "show" && operation !== "follow")) {
    return writeFailure(invalid("Run: kojo trace show|follow <Run Identity>"), json, command);
  }
  if (
    options.args.length !== 1 ||
    options.input !== undefined ||
    options.value !== undefined ||
    options.valueFile !== undefined ||
    options.requestKey !== undefined ||
    options.revision !== undefined ||
    options.conditions.length > 0 ||
    options.outcomes.length > 0 ||
    options.states.length > 0 ||
    options.workflowKeys.length > 0 ||
    options.scheduleKeys.length > 0 ||
    options.parentRunId !== undefined ||
    options.reveal ||
    (operation === "follow" && options.cursor !== undefined)
  ) {
    return writeFailure(
      invalid(
        "Run: kojo trace show <Run Identity> [--limit <1-500>] [--cursor <cursor>] [--project <path>|--project-id <Project Identity>] [--json] or kojo trace follow <Run Identity> [--limit <1-500>] [--project <path>|--project-id <Project Identity>] [--json]",
      ),
      json,
      command,
    );
  }
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return writeFailure(invalid("Use --limit with a whole number from 1 to 500."), json, command);
  }
  let identity: ProjectSnapshot["identity"];
  if (options.projectId !== undefined) {
    try {
      identity = Schema.decodeUnknownSync(ProjectIdentitySchema)(options.projectId);
    } catch {
      return writeFailure(invalid("Use a full Project Identity."), json, command);
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
        command,
      );
    }
  }
  let runId: WorkflowRunId;
  try {
    runId = Schema.decodeUnknownSync(WorkflowRunIdSchema)(options.args[0]);
  } catch {
    return writeFailure(invalid("Use a valid Run Identity."), json, command);
  }
  const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());
  const traceInput = (continuation: {
    readonly afterSequence?: number;
    readonly cursor?: string;
  }) =>
    client.readExecutionTrace({
      identity,
      runId,
      ...(continuation.afterSequence === undefined
        ? {}
        : { afterSequence: continuation.afterSequence }),
      ...(continuation.cursor === undefined ? {} : { cursor: continuation.cursor }),
      filters: EMPTY_EXECUTION_TRACE_FILTERS,
      limit,
    });
  if (operation === "show") {
    const trace = await runEffect(traceInput({ cursor: options.cursor }));
    if (!trace.succeeded) return writeFailure(transportFailure(trace.error), json, command);
    if (!trace.value.ok) return writeFailure(workflowRunFailure(trace.value.error), json, command);
    writeExecutionTracePage(command, trace.value.page, json);
    return 0;
  }

  // Snapshot history always precedes the advisory stream. The durable sequence
  // is the only resume checkpoint, so transport loss never creates duplicates.
  let lastSequence = 0;
  let final = false;
  const reload = async (continuation: {
    readonly cursor?: string;
    readonly afterSequence?: number;
  }) => {
    let cursor = continuation.cursor;
    let nextAfter = continuation.afterSequence;
    do {
      const trace = await runEffect(
        traceInput(cursor === undefined ? { afterSequence: nextAfter } : { cursor }),
      );
      if (!trace.succeeded) return { failure: transportFailure(trace.error) } as const;
      if (!trace.value.ok) return { failure: workflowRunFailure(trace.value.error) } as const;
      for (const event of trace.value.page.events) {
        if (event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        writeExecutionTraceEvent(command, event, json);
      }
      final = trace.value.page.final && lastSequence >= trace.value.page.highWaterSequence;
      cursor = trace.value.page.nextCursor ?? undefined;
      nextAfter = undefined;
    } while (cursor !== undefined);
    return { failure: undefined } as const;
  };

  const history = await reload({});
  if (history.failure !== undefined) return writeFailure(history.failure, json, command);
  if (final) return 0;

  const controller = new AbortController();
  let detached = false;
  const detach = () => {
    detached = true;
    controller.abort();
  };
  process.once("SIGINT", detach);
  process.once("SIGTERM", detach);
  try {
    for (let attempt = 1; attempt <= 5 && !detached && !final; attempt += 1) {
      let failure:
        | ReturnType<typeof transportFailure>
        | ReturnType<typeof workflowRunFailure>
        | undefined;
      const exit = await Effect.runPromiseExit(
        Stream.runForEachWhile(
          client.subscribeControl({
            projects: [identity],
            topics: ["traces"],
            traces: [{ identity, runId, afterSequence: lastSequence }],
          }),
          (update) => {
            const processUpdate = Effect.promise(async () => {
              if (detached || final) return { continueFollowing: false, processed: false };
              if (update.kind === "resync-required") {
                const resync = await reload({ afterSequence: lastSequence });
                failure = resync.failure;
                return { continueFollowing: failure === undefined && !final, processed: true };
              }
              if (update.kind !== "trace-event" || update.sequence <= lastSequence) {
                return { continueFollowing: true, processed: true };
              }
              lastSequence = update.sequence;
              writeExecutionTraceEvent(command, update.event, json);
              if (!["run.completed", "run.failed", "run.stopped"].includes(update.event.kind))
                return { continueFollowing: true, processed: true };
              const outcome = await reload({ afterSequence: lastSequence });
              failure = outcome.failure;
              return { continueFollowing: failure === undefined && !final, processed: true };
            });
            return processUpdate.pipe(
              // The CLI writes or reloads the update before advancing the
              // Host's ephemeral delivery window. A disconnected CLI never
              // acknowledges a message it did not finish processing.
              Effect.flatMap(({ continueFollowing, processed }) =>
                !processed
                  ? Effect.succeed(false)
                  : client
                      .acknowledgeControlSubscription(update)
                      .pipe(Effect.as(continueFollowing)),
              ),
            );
          },
        ),
        { signal: controller.signal },
      );
      if (detached) return 0;
      if (failure !== undefined) return writeFailure(failure, json, command);
      if (final) return 0;
      if (attempt === 5 || Exit.isSuccess(exit)) {
        return writeFailure(
          transportFailure(new Error("subscription disconnected")),
          json,
          command,
        );
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 50));
    }
    return detached || final
      ? 0
      : writeFailure(transportFailure(new Error("subscription unavailable")), json, command);
  } finally {
    process.off("SIGINT", detach);
    process.off("SIGTERM", detach);
  }
};
