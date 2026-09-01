import { Effect, Layer } from "effect";
import type { RunAuthority } from "../../workflow/models/DaemonRun.ts";
import type {
  DaemonAsking,
  DeferredApplication,
  GateTransitionReceipt,
} from "../models/DaemonAsking.ts";
import { GateTransitionError } from "../models/GateTransitionError.ts";
import { DaemonGateRepository } from "../ports/DaemonGateRepository.ts";

const identityKey = (asking: DaemonAsking): string =>
  JSON.stringify([
    1,
    asking.identity.runId,
    asking.identity.gatePath,
    asking.identity.askingNumber,
    asking.identity.escalationStage,
  ]);

const wakeupId = (asking: DaemonAsking, kind: "verdict" | "expiry"): string =>
  JSON.stringify([1, identityKey(asking), kind]);

export interface InMemoryGateState {
  readonly askings: Map<string, DaemonAsking>;
  readonly tokens: Map<string, string>;
  readonly receipts: Map<
    string,
    { readonly canonical: string; readonly receipt: GateTransitionReceipt }
  >;
  readonly wakeups: Map<string, DeferredApplication>;
  readonly appliedWakeups: Set<string>;
  readonly authority: Map<string, RunAuthority>;
}

export const makeState = (): InMemoryGateState => ({
  askings: new Map(),
  tokens: new Map(),
  receipts: new Map(),
  wakeups: new Map(),
  appliedWakeups: new Set(),
  authority: new Map(),
});

const fail = (code: GateTransitionError["code"], message: string): never => {
  throw new GateTransitionError({ code, message });
};

const attempt = <A>(evaluate: () => A): Effect.Effect<A, GateTransitionError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof GateTransitionError
        ? cause
        : new GateTransitionError({
            code: "STORE_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });

export const layer = (state: InMemoryGateState = makeState()): Layer.Layer<DaemonGateRepository> =>
  Layer.succeed(DaemonGateRepository, {
    createAskingAndSuspend: (authority, request) =>
      attempt(() => {
        const asking: DaemonAsking = { ...request, state: "unanswered" };
        const key = identityKey(asking);
        const prior = state.askings.get(key);
        if (prior !== undefined) {
          if (
            prior.token !== asking.token ||
            prior.internalDeferredName !== asking.internalDeferredName ||
            prior.deadline !== asking.deadline
          ) {
            return fail("ASKING_CONFLICT", "the Asking identity already has different content");
          }
          return prior;
        }
        if (state.tokens.has(asking.token))
          return fail("ASKING_CONFLICT", "the Gate token already names another Asking");
        state.askings.set(key, asking);
        state.tokens.set(asking.token, key);
        state.authority.set(authority.runId, authority);
        return asking;
      }),
    recordVerdictAndSchedule: (request) =>
      attempt(() => {
        const receiptKey = JSON.stringify([request.dataIdentity, request.requestId]);
        const priorReceipt = state.receipts.get(receiptKey);
        if (priorReceipt !== undefined) {
          if (priorReceipt.canonical !== request.canonicalRequest)
            return fail("REQUEST_CONFLICT", "the request ID names different canonical content");
          return { ...priorReceipt.receipt, duplicate: true };
        }
        const key = state.tokens.get(request.token);
        if (key === undefined) return fail("ASKING_NOT_FOUND", "the Gate token was not found");
        const asking = state.askings.get(key) as DaemonAsking;
        if (Date.parse(request.now) >= Date.parse(asking.deadline)) {
          const expired: DaemonAsking = { ...asking, state: "expired", expiredAt: asking.deadline };
          state.askings.set(key, expired);
          state.wakeups.set(wakeupId(expired, "expiry"), {
            deferredName: `DurableClock/${asking.internalDeferredName}/deadline`,
            result: null,
            wakeupId: wakeupId(expired, "expiry"),
            kind: "expiry",
          });
          return fail("DEADLINE_PASSED", "the Verdict was not recorded before the Deadline");
        }
        if (asking.state !== "unanswered")
          return fail("ALREADY_SETTLED", "the Asking already has a Verdict or expiry");
        if (!asking.choices.includes(request.choice))
          return fail("CHOICE_REFUSED", "the Verdict choice is not declared by this Asking");
        const recorded: DaemonAsking = {
          ...asking,
          state: "recorded",
          verdict: {
            choice: request.choice,
            reason: request.reason,
            answerer: request.answerer,
            recordedAt: request.now,
          },
        };
        state.askings.set(key, recorded);
        state.wakeups.set(wakeupId(recorded, "verdict"), {
          deferredName: recorded.internalDeferredName,
          result: recorded.verdict ?? null,
          wakeupId: wakeupId(recorded, "verdict"),
          kind: "verdict",
        });
        const receipt = { asking: recorded, requestId: request.requestId, duplicate: false };
        state.receipts.set(receiptKey, { canonical: request.canonicalRequest, receipt });
        return receipt;
      }),
    expireAndSchedule: (token, now) =>
      attempt(() => {
        const key = state.tokens.get(token);
        if (key === undefined) return fail("ASKING_NOT_FOUND", "the Gate token was not found");
        const asking = state.askings.get(key) as DaemonAsking;
        if (asking.state === "recorded" || asking.state === "applied") return asking;
        if (Date.parse(now) < Date.parse(asking.deadline))
          return fail("DEADLINE_PASSED", "the Asking has not reached its Deadline");
        const expired: DaemonAsking = { ...asking, state: "expired", expiredAt: asking.deadline };
        state.askings.set(key, expired);
        state.wakeups.set(wakeupId(expired, "expiry"), {
          deferredName: `DurableClock/${asking.internalDeferredName}/deadline`,
          result: null,
          wakeupId: wakeupId(expired, "expiry"),
          kind: "expiry",
        });
        return expired;
      }),
    markApplied: (authority, id, appliedAt) =>
      attempt(() => {
        const current = state.authority.get(authority.runId);
        if (
          current === undefined ||
          current.runnerInstanceId !== authority.runnerInstanceId ||
          current.generation !== authority.generation ||
          current.revisionId !== authority.revisionId
        ) {
          return fail("STALE_AUTHORITY", "the Runner authority is stale");
        }
        const wakeup = state.wakeups.get(id);
        if (wakeup === undefined) return fail("ASKING_NOT_FOUND", "the wake-up was not found");
        const asking = [...state.askings.values()].find(
          (candidate) =>
            candidate.identity.runId === authority.runId && wakeupId(candidate, wakeup.kind) === id,
        );
        if (asking === undefined) return fail("ASKING_NOT_FOUND", "the Asking was not found");
        if (state.appliedWakeups.has(id)) return asking;
        const applied: DaemonAsking =
          wakeup.kind === "verdict"
            ? { ...asking, state: "applied", appliedAt }
            : { ...asking, expiryAppliedAt: appliedAt };
        state.askings.set(identityKey(applied), applied);
        state.appliedWakeups.add(id);
        return applied;
      }),
    byToken: (token) =>
      Effect.sync(() => {
        const key = state.tokens.get(token);
        return key === undefined ? undefined : state.askings.get(key);
      }),
    list: Effect.sync(() => [...state.askings.values()]),
    due: (now) =>
      Effect.sync(() =>
        [...state.askings.values()].filter(
          (asking) =>
            asking.state === "unanswered" && Date.parse(asking.deadline) <= Date.parse(now),
        ),
      ),
    deferredApplications: (runId) =>
      Effect.sync(() =>
        [...state.wakeups.values()].filter(
          (wakeup) =>
            !state.appliedWakeups.has(wakeup.wakeupId) &&
            [...state.askings.values()].some(
              (asking) =>
                asking.identity.runId === runId &&
                wakeupId(asking, wakeup.kind) === wakeup.wakeupId,
            ),
        ),
      ),
    deferredResults: (runId) =>
      Effect.sync(() =>
        [...state.wakeups.values()].filter((wakeup) =>
          [...state.askings.values()].some(
            (asking) =>
              asking.identity.runId === runId && wakeupId(asking, wakeup.kind) === wakeup.wakeupId,
          ),
        ),
      ),
  });
