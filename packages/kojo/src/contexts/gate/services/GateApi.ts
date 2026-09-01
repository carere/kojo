import { userInfo } from "node:os";
import type {
  AskingDocument,
  AskingSnapshot,
  RecordVerdictResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import { Cause, Data, Effect, Option } from "effect";
import { canonicalJson } from "../../workflow/services/canonicalJson.ts";
import type { RunApi } from "../../workflow/services/RunApi.ts";
import type { SqliteDaemonGateRepository } from "../adapters/SqliteDaemonGateRepository.ts";
import type { DaemonAsking, GateTransitionReceipt } from "../models/DaemonAsking.ts";
import { GateTransitionError } from "../models/GateTransitionError.ts";

class GateApiFault extends Data.TaggedError("GateApiFault")<{
  readonly message: string;
  readonly code: GateTransitionError["code"] | "DATA_IDENTITY_CHANGED";
  readonly cause?: unknown;
}> {}

const documentOf = (asking: DaemonAsking): AskingDocument => ({
  identity: asking.identity,
  token: asking.token,
  projectId: asking.projectId,
  workflowName: asking.workflowName,
  description: asking.description,
  actor: asking.actor,
  choices: asking.choices,
  createdAt: asking.createdAt,
  deadline: asking.deadline,
  expiryBranch: asking.expiryBranch,
  state: asking.state,
  ...(asking.verdict === undefined ? {} : { verdict: asking.verdict }),
  ...(asking.appliedAt === undefined ? {} : { appliedAt: asking.appliedAt }),
  ...(asking.expiredAt === undefined ? {} : { expiredAt: asking.expiredAt }),
  ...(asking.expiryAppliedAt === undefined ? {} : { expiryAppliedAt: asking.expiryAppliedAt }),
  ...(asking.terminalInability === undefined
    ? {}
    : { terminalInability: asking.terminalInability }),
});

const fault = (cause: GateTransitionError): GateApiFault =>
  new GateApiFault({ code: cause.code, message: cause.message, cause });

const runTransition = async <A>(effect: Effect.Effect<A, GateTransitionError>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Success") return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
};

/** Daemon-owned Gate recording, deadline, application scheduling, and observation use cases. */
export class GateApi {
  readonly #dataIdentity: string;
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #repository: SqliteDaemonGateRepository;
  readonly #runs: RunApi;

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly now: () => number;
    readonly repository: SqliteDaemonGateRepository;
    readonly runs: RunApi;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#instanceId = options.instanceId;
    this.#now = options.now;
    this.#repository = options.repository;
    this.#runs = options.runs;
  }

  readonly snapshot = (projectId?: string): Effect.Effect<AskingSnapshot, GateApiFault> =>
    this.#repository.reconcileTerminalInabilities().pipe(
      Effect.andThen(this.#repository.list),
      Effect.map((all) => {
        const askings = all.filter(
          (asking) => projectId === undefined || asking.projectId === projectId,
        );
        return {
          observationVersion: 1,
          instanceId: this.#instanceId,
          dataIdentity: this.#dataIdentity,
          snapshotVersion: askings.length,
          observedAt: new Date(this.#now()).toISOString(),
          refreshAfterMillis: 1_000,
          askings: askings.map(documentOf),
          counts: {
            total: askings.length,
            unanswered: askings.filter((asking) => asking.state === "unanswered").length,
            recorded: askings.filter((asking) => asking.state === "recorded").length,
            applied: askings.filter((asking) => asking.state === "applied").length,
            expired: askings.filter((asking) => asking.state === "expired").length,
          },
        } satisfies AskingSnapshot;
      }),
      Effect.mapError(fault),
    );

  readonly record = (options: {
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly token: string;
    readonly choice: string;
    readonly reason: string;
    readonly answerer?: string;
  }): Effect.Effect<RecordVerdictResult, GateApiFault> =>
    Effect.tryPromise({
      try: async () => {
        if (options.dataIdentity !== this.#dataIdentity) {
          throw new GateApiFault({
            code: "DATA_IDENTITY_CHANGED",
            message: "the Daemon data identity changed",
          });
        }
        const answerer = options.answerer ?? userInfo().username;
        const now = new Date(this.#now()).toISOString();
        let receipt: GateTransitionReceipt;
        try {
          receipt = await runTransition(
            this.#repository.recordVerdictAndSchedule({
              ...options,
              answerer,
              now,
              canonicalRequest: canonicalJson({
                operation: "recordGateVerdict",
                token: options.token,
                choice: options.choice,
                reason: options.reason,
                answerer,
              }),
            }),
          );
        } catch (cause) {
          if (cause instanceof GateTransitionError && cause.code === "DEADLINE_PASSED") {
            const asking = await runTransition(this.#repository.byToken(options.token));
            if (asking !== undefined)
              void Effect.runPromise(this.#runs.continueRun(asking.identity.runId)).catch(
                () => undefined,
              );
          }
          throw cause;
        }
        void Effect.runPromise(this.#runs.continueRun(receipt.asking.identity.runId)).catch(
          () => undefined,
        );
        return {
          asking: documentOf(receipt.asking),
          receipt: {
            requestId: receipt.requestId,
            state: "committed",
            duplicate: receipt.duplicate,
          },
        } satisfies RecordVerdictResult;
      },
      catch: (cause) =>
        cause instanceof GateApiFault
          ? cause
          : cause instanceof GateTransitionError
            ? fault(cause)
            : new GateApiFault({
                code: "STORE_FAILED",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
    });

  readonly expireDue = (): Effect.Effect<void, GateApiFault> =>
    Effect.tryPromise({
      try: async () => {
        const now = new Date(this.#now()).toISOString();
        const due = await runTransition(this.#repository.due(now));
        for (const asking of due) {
          const expired = await runTransition(
            this.#repository.expireAndSchedule(asking.token, now),
          );
          void Effect.runPromise(this.#runs.continueRun(expired.identity.runId)).catch(
            () => undefined,
          );
        }
      },
      catch: (cause) =>
        cause instanceof GateTransitionError
          ? fault(cause)
          : new GateApiFault({
              code: "STORE_FAILED",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });
}
