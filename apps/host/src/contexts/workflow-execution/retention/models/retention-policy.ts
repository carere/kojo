import type { ProjectRetentionPolicy } from "@kojo/control";

export const DEFAULT_DIAGNOSTIC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const DEFAULT_DIAGNOSTIC_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_HOST_DIAGNOSTIC_MAX_AGE_MS = DEFAULT_DIAGNOSTIC_MAX_AGE_MS;
export const DEFAULT_HOST_DIAGNOSTIC_MAX_BYTES = 500 * 1024 * 1024;
export const DEFAULT_DISPOSABLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_DISPOSABLE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export const DEFAULT_PROJECT_RETENTION_POLICY: ProjectRetentionPolicy = {
  diagnosticMaxAgeMs: DEFAULT_DIAGNOSTIC_MAX_AGE_MS,
  diagnosticMaxBytes: DEFAULT_DIAGNOSTIC_MAX_BYTES,
  disposableMaxAgeMs: DEFAULT_DISPOSABLE_MAX_AGE_MS,
  disposableMaxBytes: DEFAULT_DISPOSABLE_MAX_BYTES,
};

export interface StoredRetentionPolicyRow {
  readonly diagnosticMaxAgeMs: number | null;
  readonly diagnosticMaxBytes: number | null;
  readonly disposableMaxAgeMs: number | null;
  readonly disposableMaxBytes: number | null;
  readonly rowVersion: number;
  readonly updatedAtMs: number;
}

/** A missing row means defaults; a present null means the developer disabled that limit. */
export const effectiveRetentionPolicy = (
  row: StoredRetentionPolicyRow | undefined,
): ProjectRetentionPolicy =>
  row === undefined
    ? DEFAULT_PROJECT_RETENTION_POLICY
    : {
        diagnosticMaxAgeMs: row.diagnosticMaxAgeMs,
        diagnosticMaxBytes: row.diagnosticMaxBytes,
        disposableMaxAgeMs: row.disposableMaxAgeMs,
        disposableMaxBytes: row.disposableMaxBytes,
      };

export interface DisposableRetentionCandidate {
  readonly key: string;
  readonly bytes: number;
  readonly createdAtMs: number;
  readonly finalizedAtMs: number | null;
  /** Continuation/session state is protected until the run is final. */
  readonly continuationRequired: boolean;
}

export interface DisposableCleanupPlan<
  Candidate extends DisposableRetentionCandidate = DisposableRetentionCandidate,
> {
  readonly currentBytes: number;
  readonly protectedBytes: number;
  readonly eligibleBytes: number;
  readonly remove: ReadonlyArray<Candidate>;
  readonly protectedOverLimit: boolean;
}

const oldestFirst = <Candidate extends DisposableRetentionCandidate>(
  left: Candidate,
  right: Candidate,
) =>
  (left.finalizedAtMs ?? left.createdAtMs) - (right.finalizedAtMs ?? right.createdAtMs) ||
  left.createdAtMs - right.createdAtMs ||
  left.key.localeCompare(right.key);

/**
 * Plans only disposable content. It never receives schedules, occurrences,
 * runs, engine rows, events, or normalized Agent results, so those records
 * cannot accidentally become cleanup candidates.
 */
export const planDisposableCleanup = <Candidate extends DisposableRetentionCandidate>(
  candidates: ReadonlyArray<Candidate>,
  policy: Pick<ProjectRetentionPolicy, "disposableMaxAgeMs" | "disposableMaxBytes">,
  nowMs: number,
): DisposableCleanupPlan<Candidate> => {
  const currentBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const eligible: Array<Candidate> = [];
  const protectedCandidates: Array<Candidate> = [];

  for (const candidate of candidates) {
    const disposable = candidate.finalizedAtMs !== null && !candidate.continuationRequired;
    if (disposable) eligible.push(candidate);
    else protectedCandidates.push(candidate);
  }

  const protectedBytes = protectedCandidates.reduce(
    (total, candidate) => total + candidate.bytes,
    0,
  );
  const eligibleBytes = eligible.reduce((total, candidate) => total + candidate.bytes, 0);
  const maxBytes = policy.disposableMaxBytes;
  const ageDue = (candidate: Candidate) =>
    policy.disposableMaxAgeMs !== null &&
    candidate.finalizedAtMs !== null &&
    nowMs - candidate.finalizedAtMs >= policy.disposableMaxAgeMs;
  const remove: ReadonlyArray<Candidate> =
    maxBytes === null
      ? policy.disposableMaxAgeMs === null
        ? []
        : [...eligible].filter(ageDue).sort(oldestFirst)
      : [...eligible].sort(oldestFirst).reduce<Array<Candidate>>((selected, candidate) => {
          const remaining = currentBytes - selected.reduce((total, item) => total + item.bytes, 0);
          if (ageDue(candidate) || remaining > maxBytes) selected.push(candidate);
          return selected;
        }, []);

  return {
    currentBytes,
    protectedBytes,
    eligibleBytes,
    remove,
    protectedOverLimit:
      policy.disposableMaxBytes !== null && protectedBytes > policy.disposableMaxBytes,
  };
};
