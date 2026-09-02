import type { JsonValue } from "../../shared/codecs/json.ts";

export type RunExecutionState =
  | "queued"
  | "executing"
  | "suspended"
  | "held"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunPhaseDocument {
  readonly phasePath: string;
  readonly attempt: number;
  readonly kind: "actor" | "code" | "agent";
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly description: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly sandboxId?: string;
  readonly errorTag?: string;
  readonly result?: JsonValue;
  readonly agent?: {
    readonly agent: string;
    readonly model: string;
    readonly session: string;
    readonly resumed: boolean;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly contextTokens?: number;
  };
  readonly repo?: {
    readonly claimed: ReadonlyArray<string>;
    readonly changed: ReadonlyArray<string>;
    readonly commits: ReadonlyArray<string>;
  };
  readonly breaches?: ReadonlyArray<{
    readonly path: string;
    readonly outcome: { readonly _tag: string };
  }>;
  readonly verification?: {
    readonly envelope: string;
    readonly ran: ReadonlyArray<string>;
    readonly failed: ReadonlyArray<string>;
    readonly corrections: number;
    readonly correctable: boolean;
  };
}

export interface RunGateDocument {
  readonly gate: string;
  readonly asking: string;
  readonly description: string;
  readonly actor: string;
  readonly requestedAt: string;
  readonly deadlineAt: string;
  readonly onExpiry: "fail" | "reject" | "escalate";
  readonly outcome: "answered" | "expired";
  readonly answerer?: string;
  readonly choice?: string;
  readonly reason?: string;
  readonly answeredAt?: string;
}

export interface RunSandboxDocument {
  readonly sandboxId: string;
  readonly name: string;
  readonly provider: string;
  readonly kind: "bind-mount" | "isolated" | "none";
  readonly branch: string;
  readonly worktreePath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly acquiredAt: string;
  readonly releasedAt: string;
  readonly outcome: "released" | "interrupted" | "failed";
}

/** One Daemon-owned Run observation. The authored payload is intentionally not exposed. */
export interface RunDocument {
  readonly runId: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly state: RunExecutionState;
  readonly queueReason?:
    | "execution-capacity"
    | "project-capacity"
    | "runner-starting"
    | "package-switch"
    | "pinned-content";
  readonly executionFault?: {
    readonly code:
      | "RETAINED_CONTENT_MISSING"
      | "RETAINED_CONTENT_CORRUPT"
      | "RETAINED_HOST_INCOMPATIBLE"
      | "RETAINED_BUN_INCOMPATIBLE"
      | "RETAINED_EFFECT_INCOMPATIBLE"
      | "RETAINED_PROTOCOL_INCOMPATIBLE"
      | "PROJECT_RECOVERY_REQUIRED";
    readonly detail: string;
    readonly remedy: string;
    readonly retry?: "after-repair" | "after-compatible-release";
    readonly scope?: {
      readonly projectId: string;
      readonly workflowName: string;
      readonly revisionId: string;
      readonly packageGraphId: string;
    };
    readonly diagnostic?: string;
  };
  readonly cancellation?: {
    readonly state: "requested" | "confirmed";
    readonly source: "run" | "forced-workflow-stop";
    readonly requestedAt: string;
    readonly confirmedAt?: string;
    readonly targetSetId?: string;
  };
  readonly recovery?: {
    readonly state: "interrupted-sibling";
    readonly interruptedAt: string;
    readonly detail: string;
  };
  readonly cleanup?: {
    readonly state: "not-required" | "pending" | "confirmed" | "fault";
    readonly detail?: string;
  };
  readonly uncertainty?: {
    readonly actionId: string;
    readonly revisionId: string;
    readonly phasePath: string;
    readonly attempt: number;
    readonly inputHash: string;
    readonly recoveryPolicy:
      | "recover-result"
      | "prove-not-performed"
      | "safe-repetition"
      | "unresolved";
    readonly state:
      | "intended"
      | "unresolved"
      | "retry-authorized"
      | "result-confirmed"
      | "not-performed"
      | "repetition-safe";
    readonly uncertaintyRevision: number;
    readonly evidence?: {
      readonly kind: "original-result" | "not-performed" | "safe-repetition" | "unresolved";
      readonly detail: string;
      readonly observedAt: string;
    };
    readonly retryAuthorization?: {
      readonly reason: string;
      readonly possibleDuplicationAcknowledged: true;
      readonly uncertaintyRevision: number;
      readonly authorizedAt: string;
      readonly consumedAt?: string;
    };
  };
  readonly admittedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly inFlight?: {
    readonly phasePath: string;
    readonly attempt: number;
    readonly kind: "actor" | "code" | "agent";
    readonly startedAt: string;
    readonly sandboxId?: string;
  };
  readonly phases: ReadonlyArray<RunPhaseDocument>;
  readonly gates?: ReadonlyArray<RunGateDocument>;
  readonly sandboxes?: ReadonlyArray<RunSandboxDocument>;
  readonly artifacts?: ReadonlyArray<{
    readonly artifactId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when a terminal Run has no external-action record or has a confirmed original result. */
export const isTerminalRunUncertaintyResolved = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value) || value.state !== "result-confirmed") return false;
  if (
    typeof value.actionId !== "string" ||
    value.actionId.length === 0 ||
    typeof value.revisionId !== "string" ||
    value.revisionId.length === 0 ||
    typeof value.phasePath !== "string" ||
    value.phasePath.length === 0 ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    typeof value.inputHash !== "string" ||
    value.inputHash.length === 0 ||
    typeof value.recoveryPolicy !== "string" ||
    !["recover-result", "prove-not-performed", "safe-repetition", "unresolved"].includes(
      value.recoveryPolicy,
    ) ||
    !Number.isSafeInteger(value.uncertaintyRevision) ||
    Number(value.uncertaintyRevision) < 0
  ) {
    return false;
  }
  const evidence = value.evidence;
  return (
    isRecord(evidence) &&
    evidence.kind === "original-result" &&
    typeof evidence.detail === "string" &&
    evidence.detail.length > 0 &&
    typeof evidence.observedAt === "string" &&
    evidence.observedAt.length > 0
  );
};

export interface RetryUncertainActionResult {
  readonly kind: "retry-uncertain";
  readonly runId: string;
  readonly actionId: string;
  readonly uncertaintyRevision: number;
  readonly state: "retry-authorized";
}

export interface CancelRunResult {
  readonly kind: "cancel";
  readonly runId: string;
  readonly cancellation: "requested" | "confirmed";
  readonly executionStopped: boolean;
  readonly state: RunExecutionState;
}

export interface RunSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly snapshotVersion: number;
  readonly observedAt: string;
  readonly refreshAfterMillis: number;
  readonly runs: ReadonlyArray<RunDocument>;
}

export interface StartRunResult {
  readonly kind: "run";
  readonly runId: string;
  readonly duplicate: boolean;
  readonly revisionId: string;
  readonly state: RunExecutionState;
}
