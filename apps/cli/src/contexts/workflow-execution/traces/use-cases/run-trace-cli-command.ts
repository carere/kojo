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
import {
  TraceExportArchiveTooLargeError,
  TraceExportDestinationExistsError,
  writeExecutionTraceExport,
} from "../services/write-execution-trace-export";

const sensitiveExportWarning = {
  code: "sensitive-content-not-scanned",
  message: "Revealed payloads may contain arbitrary secrets; Kojo did not scan them.",
  next: "Handle the ZIP as sensitive and avoid copying it into logs or issue trackers.",
};

/** The workflow-execution CLI boundary for chronological Trace inspection. */
export const runTraceCliCommand = async (args: ReadonlyArray<string>, json: boolean) => {
  const options = parseOptions(args.slice(2));
  const operation = args[1];
  const command = `trace.${operation ?? "unknown"}`;
  if (options === undefined || !["show", "follow", "export"].includes(operation ?? "")) {
    return writeFailure(
      invalid("Run: kojo trace show|follow|export <Run Identity>"),
      json,
      command,
    );
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
    (operation === "follow" && options.cursor !== undefined) ||
    (operation !== "export" &&
      (options.reveal ||
        options.includeArtifacts ||
        options.acknowledgeSensitiveExport ||
        options.output !== undefined)) ||
    (operation === "export" &&
      (options.cursor !== undefined ||
        options.limit !== undefined ||
        options.output === undefined ||
        (!options.reveal && options.acknowledgeSensitiveExport)))
  ) {
    return writeFailure(
      invalid(
        "Run: kojo trace show <Run Identity> [--limit <1-500>] [--cursor <cursor>] [--project <path>|--project-id <Project Identity>] [--json] or kojo trace follow <Run Identity> [--limit <1-500>] [--project <path>|--project-id <Project Identity>] [--json] or kojo trace export <Run Identity> --output <path.zip> [--reveal --acknowledge-sensitive-export] [--include-artifacts] [--project <path>|--project-id <Project Identity>] [--json]",
      ),
      json,
      command,
    );
  }
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  if (operation !== "export" && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
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
  if (operation === "export") {
    const destination = options.output;
    if (destination === undefined) {
      return writeFailure(invalid("Choose a ZIP export destination with --output."), json, command);
    }
    if (options.reveal && !(await acknowledgeSensitiveExport(options.acknowledgeSensitiveExport))) {
      return writeFailure(
        invalid(
          "Revealing payloads requires acknowledgement. Use --acknowledge-sensitive-export in non-interactive use.",
        ),
        json,
        command,
      );
    }
    const exported = await runEffect(
      client.exportExecutionTrace({
        identity,
        includeArtifacts: options.includeArtifacts,
        revealPayloads: options.reveal,
        runId,
      }),
    );
    if (!exported.succeeded) return writeFailure(transportFailure(exported.error), json, command);
    if (!exported.value.ok)
      return writeFailure(workflowRunFailure(exported.value.error), json, command);
    try {
      await writeExecutionTraceExport(destination, exported.value.trace, options.reveal);
    } catch (error) {
      return writeFailure(
        invalid(
          error instanceof TraceExportDestinationExistsError
            ? error.message
            : error instanceof TraceExportArchiveTooLargeError
              ? error.message
              : "Execution Trace export could not be written to that destination.",
        ),
        json,
        command,
      );
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          command,
          result: {
            destination,
            highWaterSequence: exported.value.trace.highWaterSequence,
            artifactCount: exported.value.trace.artifacts.filter(
              (artifact) => artifact.contentBase64 !== null,
            ).length,
            payloadsRevealed: options.reveal,
          },
          warnings: options.reveal ? [sensitiveExportWarning] : [],
        })}\n`,
      );
    } else {
      if (options.reveal) {
        process.stderr.write(
          `Warning: ${sensitiveExportWarning.message} ${sensitiveExportWarning.next}\n`,
        );
      }
      process.stdout.write(
        `Exported Execution Trace through sequence ${exported.value.trace.highWaterSequence} to ${destination}\n`,
      );
    }
    return 0;
  }
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
      let resyncReloaded = false;
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
                resyncReloaded = failure === undefined && !final;
                // A resync terminal notification ends the current advisory
                // stream. Stop this consumer after the authoritative reload
                // (but before returning to the outer retry loop) so it sends
                // its normal stream interrupt rather than waiting forever
                // for an RPC terminal frame that raced the notification.
                return { continueFollowing: false, processed: true };
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
      // A resync notice deliberately ends its current advisory stream after
      // authoritative history reload. Re-open a bounded subscription from
      // that durable checkpoint instead of treating the clean stream Exit as
      // a transport failure.
      // The Host deliberately ends a resync stream after the terminal notice.
      // Depending on the RPC transport's teardown timing, that completed
      // advisory stream can surface as either a normal Exit or a transport
      // failure. The authoritative reload above has already succeeded, so
      // either result must resume from the durable checkpoint.
      if (resyncReloaded) continue;
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

const acknowledgeSensitiveExport = async (acknowledged: boolean) => {
  if (acknowledged) return true;
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return false;
  process.stderr.write(
    "Warning: this ZIP will contain unredacted payloads that may include secrets. Type 'export sensitive' to continue: ",
  );
  const response = await new Promise<string>((resolve) => {
    process.stdin.once("data", (value) => resolve(String(value)));
    process.stdin.resume();
  });
  return response.trim() === "export sensitive";
};
