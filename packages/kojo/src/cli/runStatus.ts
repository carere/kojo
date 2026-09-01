import type {
  CancelRunResult,
  RetryUncertainActionResult,
  RunDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { DaemonPaths } from "../contexts/daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { clientExit } from "./ClientExit.ts";
import { commandFailed } from "./CommandFailed.ts";
import { timeoutMillis } from "./workflow.ts";

class RunStatusClientError extends Data.TaggedError("RunStatusClientError")<{
  readonly reason: string;
}> {}

export interface RunStatusFlags {
  readonly details: boolean;
  readonly follow: boolean;
  readonly wait: boolean;
  readonly timeout?: string;
}

const productionPaths = (): DaemonPaths => {
  if (process.platform === "darwin") return macPaths();
  if (process.platform === "linux") return linuxPaths();
  throw new RunStatusClientError({ reason: "Kojo Run inspection supports macOS and Linux" });
};

export const validateRunStatusFlags = (flags: RunStatusFlags): number | undefined => {
  if (flags.follow && flags.wait) throw new Error("--follow and --wait cannot be used together");
  if (flags.timeout !== undefined && !flags.follow && !flags.wait) {
    throw new Error("--timeout is valid only with --follow or --wait");
  }
  return flags.follow || flags.wait
    ? timeoutMillis(flags.timeout ?? (flags.follow ? "none" : "60s"))
    : undefined;
};

export const runStatusLine = (run: RunDocument, json: boolean, details = false): string =>
  json
    ? JSON.stringify({ formatVersion: 1, run })
    : [
        `Run ${run.runId}`,
        `Project=${run.projectId}`,
        `Workflow=${run.workflowName}`,
        `State=${run.state}`,
        `Revision=${run.revisionId}`,
        `Graph=${run.packageGraphId}`,
        ...(run.queueReason === undefined ? [] : [`Queue=${run.queueReason}`]),
        ...(run.executionFault === undefined
          ? []
          : [
              `Fault=${run.executionFault.code}:${run.executionFault.detail}`,
              `Remedy=${run.executionFault.remedy}`,
            ]),
        ...(run.cancellation === undefined
          ? []
          : [
              `Cancellation=${run.cancellation.state}:${run.cancellation.source}`,
              `CancellationRequested=${run.cancellation.requestedAt}`,
            ]),
        ...(run.recovery === undefined
          ? []
          : [`Recovery=${run.recovery.state}:${run.recovery.detail}`]),
        ...(run.cleanup === undefined
          ? []
          : [
              `Cleanup=${run.cleanup.state}${run.cleanup.detail === undefined ? "" : `:${run.cleanup.detail}`}`,
            ]),
        ...(run.uncertainty === undefined
          ? []
          : [
              `Uncertainty=${run.uncertainty.state}:${run.uncertainty.actionId}`,
              `Action=${run.uncertainty.phasePath}#${run.uncertainty.attempt}:${run.uncertainty.inputHash}`,
              `RecoveryPolicy=${run.uncertainty.recoveryPolicy}`,
              ...(run.uncertainty.evidence === undefined
                ? []
                : [`Evidence=${run.uncertainty.evidence.kind}:${run.uncertainty.evidence.detail}`]),
            ]),
        `Phases=${run.phases.length}`,
        ...(details
          ? [
              `Admitted=${run.admittedAt}`,
              ...(run.startedAt === undefined ? [] : [`Started=${run.startedAt}`]),
              ...(run.finishedAt === undefined ? [] : [`Finished=${run.finishedAt}`]),
              ...run.phases.map(
                (phase) =>
                  `Phase=${phase.phasePath}#${phase.attempt}:${phase.kind}:${phase.outcome}`,
              ),
            ]
          : []),
      ].join("\t");

export const requestedRunExitCode = (run: RunDocument, observingCondition: boolean): 0 | 1 =>
  observingCondition && (run.state === "failed" || run.state === "cancelled") ? 1 : 0;

const terminal = (run: RunDocument): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";

export const runStatusRequest = (
  runId: string,
): { readonly method: "GET"; readonly path: string } => ({
  method: "GET",
  path: `/api/v1/runs/${encodeURIComponent(runId)}`,
});

const readRun = (runId: string): Effect.Effect<RunDocument, RunStatusClientError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(productionPaths());
      if (endpoint === undefined)
        throw new Error("the Daemon is not ready; run `kojo daemon start`");
      const request = runStatusRequest(runId);
      const response = await fetch(`http://localhost${request.path}`, {
        unix: endpoint.socketPath,
        method: request.method,
        headers: { accept: "application/json" },
      } as RequestInit & { readonly unix: string });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { readonly message?: string };
        throw new Error(body.message ?? `the Daemon refused Run inspection (${response.status})`);
      }
      return (await response.json()) as RunDocument;
    },
    catch: (cause) =>
      new RunStatusClientError({
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const status = Command.make(
  "status",
  {
    runId: Argument.string("run"),
    details: Flag.boolean("details"),
    follow: Flag.boolean("follow"),
    wait: Flag.boolean("wait"),
    timeout: Flag.string("timeout").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ runId, details, follow, wait, timeout, json }) {
    const timeoutText = Option.getOrUndefined(timeout);
    const within = yield* Effect.try({
      try: () =>
        validateRunStatusFlags({
          details,
          follow,
          wait,
          ...(timeoutText === undefined ? {} : { timeout: timeoutText }),
        }),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    const deadline = within === undefined ? undefined : Date.now() + within;
    let lastState: string | undefined;
    let observed: RunDocument | undefined;
    do {
      observed = yield* readRun(runId).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
      if (!follow || observed.state !== lastState) {
        yield* Console.log(runStatusLine(observed, json, details));
        lastState = observed.state;
      }
      if (!follow && !wait) return;
      if (terminal(observed)) break;
      if (deadline !== undefined && Date.now() >= deadline) {
        return yield* clientExit(3, `Run ${runId} continues after the client timeout`);
      }
      yield* Effect.sleep("50 millis");
    } while (true);
    if (requestedRunExitCode(observed, true) === 1) {
      return yield* clientExit(1, `Run ${runId} failed`);
    }
  }),
).pipe(Command.withDescription("Inspect, wait for, or follow one Daemon Run"));

const cancel = Command.make(
  "cancel",
  {
    runId: Argument.string("run"),
    wait: Flag.boolean("wait"),
    timeout: Flag.string("timeout").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ runId, wait, timeout, json }) {
    if (!wait && Option.isSome(timeout)) {
      return yield* clientExit(2, "--timeout is valid only with --wait");
    }
    const within = yield* Effect.try({
      try: () => timeoutMillis(Option.getOrUndefined(timeout) ?? "60s"),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    const deadline = within === undefined ? undefined : Date.now() + within;
    const accepted = yield* Effect.tryPromise({
      try: async () => {
        const endpoint = readDaemonEndpoint(productionPaths());
        if (endpoint === undefined)
          throw new Error("the Daemon is not ready; run `kojo daemon start`");
        const response = await fetch(
          `http://localhost/api/v1/runs/${encodeURIComponent(runId)}/actions/cancel`,
          {
            unix: endpoint.socketPath,
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              dataIdentity: endpoint.dataIdentity,
            }),
          } as RequestInit & { readonly unix: string },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { readonly message?: string };
          throw new Error(body.message ?? `the Daemon refused cancellation (${response.status})`);
        }
        return (await response.json()) as CancelRunResult;
      },
      catch: (cause) =>
        new RunStatusClientError({
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    if (!wait) {
      yield* Console.log(
        json
          ? JSON.stringify({ formatVersion: 1, ...accepted })
          : accepted.cancellation === "confirmed"
            ? `Run ${runId} is Cancelled. Execution stopped.`
            : `Cancellation requested for Run ${runId}. Execution stop is not confirmed.`,
      );
      return;
    }
    let observed = yield* readRun(runId).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    while (observed.state !== "cancelled") {
      if (terminal(observed)) {
        return yield* clientExit(
          1,
          `Run ${runId} reached ${observed.state}; cancellation did not become Cancelled`,
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        return yield* clientExit(3, `Run ${runId} still has unconfirmed cancellation intent`);
      }
      yield* Effect.sleep("50 millis");
      observed = yield* readRun(runId).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    }
    yield* Console.log(
      json ? JSON.stringify({ formatVersion: 1, run: observed }) : `Run ${runId} is Cancelled.`,
    );
  }),
).pipe(Command.withDescription("Request Run cancellation without owning its execution"));

export const validateUncertainRetry = (input: {
  readonly actionId: string;
  readonly reason: string;
  readonly possibleDuplicationAcknowledged: boolean;
}): void => {
  if (input.actionId.trim() === "")
    throw new Error("--retry-uncertain requires the exact action ID");
  if (input.reason.trim() === "") throw new Error("--reason must explain this exact retry");
  if (!input.possibleDuplicationAcknowledged)
    throw new Error("--acknowledge-possible-duplication is required");
};

const resume = Command.make(
  "resume",
  {
    runId: Argument.string("run"),
    actionId: Flag.string("retry-uncertain"),
    reason: Flag.string("reason"),
    possibleDuplicationAcknowledged: Flag.boolean("acknowledge-possible-duplication"),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ runId, actionId, reason, possibleDuplicationAcknowledged, json }) {
    yield* Effect.try({
      try: () => validateUncertainRetry({ actionId, reason, possibleDuplicationAcknowledged }),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    const accepted = yield* Effect.tryPromise({
      try: async () => {
        const endpoint = readDaemonEndpoint(productionPaths());
        if (endpoint === undefined)
          throw new Error("the Daemon is not ready; run `kojo daemon start`");
        const response = await fetch(
          `http://localhost/api/v1/runs/${encodeURIComponent(runId)}/actions/retry-uncertain`,
          {
            unix: endpoint.socketPath,
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              dataIdentity: endpoint.dataIdentity,
              actionId,
              reason,
              possibleDuplicationAcknowledged: true,
            }),
          } as RequestInit & { readonly unix: string },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { readonly message?: string };
          throw new Error(
            body.message ?? `the Daemon refused uncertain retry (${response.status})`,
          );
        }
        return (await response.json()) as RetryUncertainActionResult;
      },
      catch: (cause) =>
        new RunStatusClientError({
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(
      json
        ? JSON.stringify({ formatVersion: 1, ...accepted })
        : `Run ${runId} may retry exact Action ${actionId}. Possible duplication was acknowledged.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Authorize repetition of one exact unresolved action without manufacturing a result",
  ),
);

export const runStatusCommands = [status, cancel, resume] as const;
