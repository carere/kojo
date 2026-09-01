import type {
  AskingDocument,
  AskingSnapshot,
  RecordVerdictRequest,
  RecordVerdictResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { DaemonPaths } from "../contexts/daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { clientExit } from "./ClientExit.ts";
import { commandFailed } from "./CommandFailed.ts";
import { timeoutMillis } from "./workflow.ts";

class GateClientError extends Data.TaggedError("GateClientError")<{
  readonly reason: string;
  readonly code?: string;
}> {}

const productionPaths = (): DaemonPaths => {
  if (process.platform === "darwin") return macPaths();
  if (process.platform === "linux") return linuxPaths();
  throw new GateClientError({ reason: "Kojo Gate access supports macOS and Linux" });
};

const daemonEndpoint = (paths: () => DaemonPaths) => {
  const endpoint = readDaemonEndpoint(paths());
  if (endpoint === undefined)
    throw new GateClientError({
      code: "ENDPOINT_UNAVAILABLE",
      reason: "the Daemon is not ready; run `kojo daemon start`",
    });
  return endpoint;
};

const problemOf = async (
  response: Response,
): Promise<{ readonly code?: string; readonly message: string }> => {
  const body = (await response.json().catch(() => ({}))) as {
    readonly code?: string;
    readonly message?: string;
  };
  return {
    ...(body.code === undefined ? {} : { code: body.code }),
    message: body.message ?? `the Daemon refused Gate access (${response.status})`,
  };
};

const readSnapshot = (
  paths: () => DaemonPaths,
  projectId?: string,
): Effect.Effect<AskingSnapshot, GateClientError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = daemonEndpoint(paths);
      const path =
        projectId === undefined
          ? "/api/v1/askings"
          : `/api/v1/projects/${encodeURIComponent(projectId)}/askings`;
      const response = await fetch(`http://localhost${path}`, {
        unix: endpoint.socketPath,
        headers: { accept: "application/json" },
      } as RequestInit & { readonly unix: string });
      if (!response.ok) {
        const problem = await problemOf(response);
        throw new GateClientError({
          reason: problem.message,
          ...(problem.code === undefined ? {} : { code: problem.code }),
        });
      }
      return (await response.json()) as AskingSnapshot;
    },
    catch: (cause) =>
      cause instanceof GateClientError
        ? cause
        : new GateClientError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  });

const recordVerdict = (
  paths: () => DaemonPaths,
  input: Omit<RecordVerdictRequest, "dataIdentity">,
): Effect.Effect<
  {
    readonly endpoint: ReturnType<typeof daemonEndpoint>;
    readonly result: RecordVerdictResult;
  },
  GateClientError
> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = daemonEndpoint(paths);
      const body: RecordVerdictRequest = { ...input, dataIdentity: endpoint.dataIdentity };
      const response = await fetch("http://localhost/api/v1/gate-answers", {
        unix: endpoint.socketPath,
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      } as RequestInit & { readonly unix: string });
      if (!response.ok) {
        const problem = await problemOf(response);
        throw new GateClientError({
          reason: problem.message,
          ...(problem.code === undefined ? {} : { code: problem.code }),
        });
      }
      return { endpoint, result: (await response.json()) as RecordVerdictResult };
    },
    catch: (cause) =>
      cause instanceof GateClientError
        ? cause
        : new GateClientError({
            code: "OUTCOME_UNKNOWN",
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
  });

/** Default Gate listing includes each Asking that can still change what the user must do. */
export const visibleAskings = (
  snapshot: AskingSnapshot,
  all: boolean,
): ReadonlyArray<AskingDocument> =>
  all
    ? snapshot.askings
    : snapshot.askings.filter(
        (asking) => asking.state === "unanswered" || asking.state === "recorded",
      );

export const askingLine = (asking: AskingDocument): string =>
  [
    asking.identity.runId,
    asking.identity.gatePath,
    `Asking=${asking.identity.askingNumber}`,
    `Escalation=${asking.identity.escalationStage}`,
    `Actor=${asking.actor}`,
    `State=${asking.state}`,
    `Deadline=${asking.deadline}`,
    `Choices=${asking.choices.join(",")}`,
    `Token=${asking.token}`,
    ...(asking.verdict === undefined
      ? []
      : [`Verdict=${asking.verdict.choice}`, `Answerer=${asking.verdict.answerer}`]),
    ...(asking.terminalInability === undefined
      ? []
      : [`TerminalInability=${asking.terminalInability}`]),
  ].join("\t");

export const validateGateAnswerFlags = (options: {
  readonly wait: boolean;
  readonly timeout?: string;
}): number | undefined => {
  if (!options.wait && options.timeout !== undefined)
    throw new Error("--timeout is valid only with --wait");
  if (!options.wait) return undefined;
  return timeoutMillis(options.timeout ?? "60s");
};

/** A terminal inability is an unsuccessful wait, even though the Verdict remains Recorded. */
export const gateWaitExit = (asking: AskingDocument): 0 | 1 | undefined => {
  if (asking.terminalInability !== undefined) return 1;
  if (asking.state === "applied") return 0;
  return undefined;
};

const sameAsking = (left: AskingDocument, right: AskingDocument): boolean =>
  left.identity.runId === right.identity.runId &&
  left.identity.gatePath === right.identity.gatePath &&
  left.identity.askingNumber === right.identity.askingNumber &&
  left.identity.escalationStage === right.identity.escalationStage;

export const makeGateCommand = (paths: () => DaemonPaths = productionPaths) => {
  const list = Command.make(
    "list",
    {
      projectId: Flag.string("project").pipe(Flag.optional),
      all: Flag.boolean("all"),
      limit: Flag.integer("limit").pipe(Flag.withDefault(50)),
      cursor: Flag.integer("cursor").pipe(Flag.optional),
      json: Flag.boolean("json"),
    },
    Effect.fn(function* ({ projectId, all, limit, cursor, json }) {
      if (limit < 1) return yield* clientExit(2, "--limit must be a positive integer");
      const offset = Option.getOrElse(cursor, () => 0);
      if (offset < 0) return yield* clientExit(2, "--cursor must not be negative");
      const snapshot = yield* readSnapshot(paths, Option.getOrUndefined(projectId)).pipe(
        Effect.catch((cause) => commandFailed(cause.reason)),
      );
      const visible = visibleAskings(snapshot, all);
      const selected = all ? visible : visible.slice(offset, offset + limit);
      if (json) {
        yield* Console.log(JSON.stringify({ formatVersion: 1, ...snapshot, askings: selected }));
        return;
      }
      if (selected.length === 0) {
        yield* Console.log("No unsettled Gate Askings are recorded.");
        return;
      }
      yield* Effect.forEach(selected, (asking) => Console.log(askingLine(asking)), {
        discard: true,
      });
    }),
  ).pipe(Command.withDescription("List Daemon-owned Gate Askings without starting a Runner"));

  const answer = Command.make(
    "answer",
    {
      token: Argument.string("token"),
      choice: Flag.string("choice"),
      reason: Flag.string("reason").pipe(Flag.withDefault("")),
      as: Flag.string("as").pipe(Flag.optional),
      wait: Flag.boolean("wait"),
      timeout: Flag.string("timeout").pipe(Flag.optional),
      json: Flag.boolean("json"),
    },
    Effect.fn(function* ({ token, choice, reason, as, wait, timeout, json }) {
      const timeoutText = Option.getOrUndefined(timeout);
      const within = yield* Effect.try({
        try: () =>
          validateGateAnswerFlags({
            wait,
            ...(timeoutText === undefined ? {} : { timeout: timeoutText }),
          }),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.catch((message) => clientExit(2, message)));
      const answerer = Option.getOrUndefined(as);
      const recorded = yield* recordVerdict(paths, {
        requestId: crypto.randomUUID(),
        token,
        choice,
        reason,
        ...(answerer === undefined ? {} : { answerer }),
      }).pipe(
        Effect.catch((cause) => clientExit(cause.code === "OUTCOME_UNKNOWN" ? 4 : 1, cause.reason)),
      );
      if (!wait) {
        yield* Console.log(
          json
            ? JSON.stringify({ formatVersion: 1, ...recorded.result })
            : `Recorded ${choice} for Run ${recorded.result.asking.identity.runId} as ${recorded.result.asking.verdict?.answerer ?? "unknown"}.`,
        );
        return;
      }

      const deadline = within === undefined ? undefined : Date.now() + within;
      while (deadline === undefined || Date.now() < deadline) {
        const snapshot = yield* readSnapshot(paths, recorded.result.asking.projectId).pipe(
          Effect.catch((cause) => commandFailed(cause.reason)),
        );
        const asking = snapshot.askings.find((candidate) =>
          sameAsking(candidate, recorded.result.asking),
        );
        if (asking !== undefined) {
          const exit = gateWaitExit(asking);
          if (exit === 0) {
            yield* Console.log(
              json
                ? JSON.stringify({ formatVersion: 1, asking })
                : `Applied the Verdict to Run ${asking.identity.runId}.`,
            );
            return;
          }
          if (exit === 1) {
            return yield* clientExit(
              1,
              `Run ${asking.identity.runId} cannot apply the Recorded Verdict: ${asking.terminalInability}`,
            );
          }
        }
        yield* Effect.sleep("50 millis");
      }
      return yield* clientExit(
        3,
        `the Verdict is Recorded but Run ${recorded.result.asking.identity.runId} continues after the client timeout`,
      );
    }),
  ).pipe(Command.withDescription("Record one Gate Verdict through the Daemon and optionally wait"));

  return Command.make("gate").pipe(
    Command.withDescription("List and answer Daemon-owned Gate Askings"),
    Command.withSubcommands([list, answer]),
  );
};

export const gate = makeGateCommand();
