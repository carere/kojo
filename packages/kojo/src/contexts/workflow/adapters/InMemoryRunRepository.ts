import { Effect, Layer } from "effect";
import type { DaemonRun, PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
import { RunStoreError } from "../models/RunStoreError.ts";
import { type Admission, type AdmitRunRequest, RunRepository } from "../ports/RunRepository.ts";
import { runIdOf } from "../services/runIdentity.ts";

interface MemoryState {
  readonly runs: Map<string, DaemonRun>;
  readonly tupleRunIds: Map<string, string>;
  readonly receipts: Map<string, { readonly canonical: string; readonly admission: Admission }>;
  readonly claims: Map<string, RunAuthority>;
  readonly generations: Map<string, number>;
  readonly slots: Map<string, RunAuthority>;
  readonly results: Map<string, PhaseResult>;
  sequence: number;
}

const tupleOf = (request: AdmitRunRequest): string =>
  JSON.stringify([request.projectId, request.workflowName, request.idempotencyKey]);

const resultKey = (runId: string, phasePath: string, attempt: number): string =>
  JSON.stringify([runId, phasePath, attempt]);

const stale = (): RunStoreError =>
  new RunStoreError({ code: "STALE_AUTHORITY", message: "the Runner Claim or slot is stale" });

const attempt = <A>(evaluate: () => A): Effect.Effect<A, RunStoreError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof RunStoreError
        ? cause
        : new RunStoreError({
            code: "STORE_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });

const assertAuthority = (state: MemoryState, authority: RunAuthority): void => {
  const claim = state.claims.get(authority.runId);
  const slot = state.slots.get(authority.runId);
  if (
    claim === undefined ||
    slot === undefined ||
    claim.runnerInstanceId !== authority.runnerInstanceId ||
    slot.runnerInstanceId !== authority.runnerInstanceId ||
    claim.generation !== authority.generation ||
    slot.generation !== authority.generation ||
    claim.revisionId !== authority.revisionId
  ) {
    throw stale();
  }
};

/** In-memory adapter for Run admission and Claim use-case tests. */
export const layer: Layer.Layer<RunRepository> = Layer.effect(
  RunRepository,
  Effect.sync(() => {
    const state: MemoryState = {
      runs: new Map(),
      tupleRunIds: new Map(),
      receipts: new Map(),
      claims: new Map(),
      generations: new Map(),
      slots: new Map(),
      results: new Map(),
      sequence: 0,
    };
    return {
      admit: (request) =>
        attempt(() => {
          const receiptKey = JSON.stringify([request.dataIdentity, request.requestId]);
          const prior = state.receipts.get(receiptKey);
          if (prior !== undefined) {
            if (prior.canonical !== request.canonicalRequest) {
              throw new RunStoreError({
                code: "REQUEST_CONFLICT",
                message: "the request ID already names different canonical content",
              });
            }
            return prior.admission;
          }
          const tuple = tupleOf(request);
          const runId = runIdOf(request.projectId, request.workflowName, request.idempotencyKey);
          const tupleRunId = state.tupleRunIds.get(tuple);
          const existing = state.runs.get(runId);
          if (tupleRunId !== undefined && tupleRunId !== runId) {
            throw new RunStoreError({
              code: "DEDUP_COLLISION",
              message: "the deduplication tuple is bound to a different Run",
            });
          }
          if (existing === undefined) state.sequence += 1;
          const run: DaemonRun =
            existing ??
            ({
              runId,
              projectId: request.projectId,
              workflowName: request.workflowName,
              idempotencyKey: request.idempotencyKey,
              payload: request.payload,
              revisionId: request.revisionId,
              packageGraphId: request.packageGraphId,
              state: "queued",
              admissionSequence: state.sequence,
              admittedAt: request.admittedAt,
            } satisfies DaemonRun);
          state.runs.set(runId, run);
          state.tupleRunIds.set(tuple, runId);
          const admission = { run, duplicate: existing !== undefined };
          state.receipts.set(receiptKey, { canonical: request.canonicalRequest, admission });
          return admission;
        }),
      claim: (runId, runnerInstanceId, claimedAt) =>
        attempt(() => {
          const run = state.runs.get(runId);
          if (run === undefined) {
            throw new RunStoreError({
              code: "RUN_NOT_FOUND",
              message: `Run ${runId} was not found`,
            });
          }
          if (run.state !== "queued" || state.slots.size >= 4) {
            throw new RunStoreError({
              code: "RUN_NOT_ELIGIBLE",
              message: "the Run has no execution slot",
            });
          }
          if (
            [...state.slots.values()].some(
              (slot) => state.runs.get(slot.runId)?.projectId === run.projectId,
            )
          ) {
            throw new RunStoreError({
              code: "RUN_NOT_ELIGIBLE",
              message: "the Project execution slot is full",
            });
          }
          const generation = (state.generations.get(runId) ?? 0) + 1;
          state.generations.set(runId, generation);
          const authority = { runId, runnerInstanceId, generation, revisionId: run.revisionId };
          state.claims.set(runId, authority);
          state.slots.set(runId, authority);
          state.runs.set(runId, {
            ...run,
            state: "executing",
            startedAt: run.startedAt ?? claimedAt,
          });
          return authority;
        }),
      read: (runId) => Effect.sync(() => state.runs.get(runId)),
      list: Effect.sync(() =>
        [...state.runs.values()].sort(
          (left, right) => right.admissionSequence - left.admissionSequence,
        ),
      ),
      readResult: (authority, phasePath, attemptNumber) =>
        attempt(() => {
          assertAuthority(state, authority);
          return state.results.get(resultKey(authority.runId, phasePath, attemptNumber))
            ?.encodedResult;
        }),
      completePhase: (authority, phase) =>
        attempt(() => {
          assertAuthority(state, authority);
          const key = resultKey(authority.runId, phase.phasePath, phase.attempt);
          if (!state.results.has(key)) state.results.set(key, phase);
        }),
      completeRun: (authority, runState, finishedAt) =>
        attempt(() => {
          assertAuthority(state, authority);
          const run = state.runs.get(authority.runId);
          if (run === undefined) throw stale();
          state.runs.set(authority.runId, { ...run, state: runState, finishedAt });
          state.claims.delete(authority.runId);
          state.slots.delete(authority.runId);
        }),
      phases: (runId) =>
        Effect.sync(() =>
          [...state.results.entries()]
            .filter(([key]) => (JSON.parse(key) as [string, string, number])[0] === runId)
            .map(([, phase]) => phase)
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
        ),
    };
  }),
);
