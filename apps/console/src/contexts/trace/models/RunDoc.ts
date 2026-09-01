/**
 * `GET /api/runs/:runId` — one whole run, as the wire carries it.
 *
 * Read structurally, never decoded. console.md §10 asks the Console to ignore what a newer factory
 * grew that this build does not know about, which is the whole value of the additive-migration
 * promise; a schema that refused an unknown field would spend it on nothing. So these are the fields
 * the run view reads and no others, and everything else on the record travels past unread.
 *
 * **`?` here means the key is absent, and it never means `null`** — adr/trace/0003. That is a promise
 * the *server* keeps and the type system enforces there: every optional field of every record on this
 * wire is `Schema.optionalKey`, which with `exactOptionalPropertyTypes` makes a producer that passes
 * `undefined` fail to compile, and a key that is never present holding `undefined` is a key the JSON
 * serializer never writes as `null`.
 *
 * It is written down here because this file is where a reader decides what `x === undefined` means.
 * It once meant nothing at all: the server sent `"inFlight": null`, `null === undefined` is false,
 * and the run view threw on every real run while eighty-five browser specs — fed by fixtures that
 * omitted the same keys — stayed green. Every `=== undefined` guard in this application was audited
 * against that record; none of them needed changing, because absent is now the only thing the server
 * can send.
 */

/** The three kinds of phase a workflow is made of. A sandbox is a scope, so it is not one. */
export type PhaseKind = "actor" | "code" | "agent";

/**
 * How a phase ended, or that it has not.
 *
 * `running` is the Console's own fourth value rather than the trace's: a phase record is written on
 * exit, so a phase that is still going has no outcome to read. It comes from the run row instead.
 * `interrupted` is deliberately kept apart from `failed` — a phase the suspension killed did nothing
 * wrong, and drawing it as a fault would accuse it of something.
 */
export type PhaseState = "succeeded" | "failed" | "interrupted" | "running";

/** One breached path and what became of it. The tag is what says whether anything was recovered. */
export interface BreachLine {
  readonly path: string;
  readonly outcome: { readonly _tag: string };
}

/**
 * Who was asked, and what the turn cost. Present on an agent phase whose call produced an answer.
 *
 * `contextTokens` is the one that is usually absent: most invokers do not report how much of the
 * window the conversation occupies after the turn. Absent is drawn as *not reported*, never as zero
 * — a zero would read as an empty context, which is the one thing it never is.
 */
export interface AgentLine {
  readonly agent: string;
  readonly model: string;
  readonly session: string;
  readonly resumed: boolean;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly contextTokens?: number;
}

/** What the phase's own verification cost and found. Present on every agent phase. */
export interface VerificationLine {
  readonly envelope: string;
  readonly ran: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly corrections: number;
  readonly correctable: boolean;
}

/** What the phase did to the repository that it was **allowed** to do. */
export interface RepoLine {
  /** What the envelope said it changed. */
  readonly claimed: ReadonlyArray<string>;
  /** What the working tree actually held afterwards. The pair is the point; a diff cannot say it. */
  readonly changed: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<string>;
}

/** One phase record: written once, on exit, on every path. */
export interface PhaseLine {
  readonly phaseId: string;
  readonly name: string;
  readonly description: string;
  readonly kind: PhaseKind;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly attempt: number;
  readonly startedAt: number;
  readonly endedAt: number;
  /** The acquisition it ran inside. Absent means the host, which is a fact rather than a gap. */
  readonly sandboxId?: string;
  readonly errorTag?: string;
  readonly breaches?: ReadonlyArray<BreachLine>;
  readonly verification?: VerificationLine;
  readonly agent?: AgentLine;
  readonly repo?: RepoLine;
}

/** One **acquisition** of one sandbox. A run that suspends at a gate has two of these. */
export interface SandboxLine {
  readonly sandboxId: string;
  readonly name: string;
  readonly provider: string;
  readonly kind: string;
  readonly branch: string;
  readonly worktreePath: string;
  /**
   * What crossed into the container.
   *
   * Recorded rather than assumed, because it is the join: nothing propagates into a sandbox, so
   * these three variables are the only thread from a phase back to the acquisition it ran in.
   */
  readonly environment: Record<string, string>;
  readonly acquiredAt: number;
  readonly releasedAt: number;
  readonly outcome: "released" | "interrupted" | "failed";
}

/**
 * One **settled** asking. A gate still waiting has no record; it comes from `/api/gates`.
 *
 * **Its presence is the Console's only proof that an answer was applied.** The record is written by
 * the run itself, in the activity that follows the suspension, so a record keyed by an asking means
 * the run woke up and carried on — and its absence beside a recorded verdict means it has not. That
 * is the whole of adr/gate/0001 expressed as a field that is either there or is not.
 */
export interface GateLine {
  readonly gate: string;
  readonly asking: string;
  readonly description: string;
  readonly actor: string;
  readonly requestedAt: number;
  readonly deadlineAt: number;
  /** Which way the run went, or would have gone, if nobody answered in time. */
  readonly onExpiry: string;
  readonly outcome: "answered" | "expired";
  /** Absent on a gate nobody answered — an expiry is a settlement with no answerer. */
  readonly answerer?: string;
  readonly choice?: string;
  readonly reason?: string;
  readonly answeredAt?: number;
}

/**
 * The phase a run is inside right now, off the run row.
 *
 * adr/trace/0002. It carries no outcome and no end, because neither exists yet — which is exactly
 * why it cannot be a phase record and has to be its own shape.
 */
export interface InFlightLine {
  readonly phaseId: string;
  readonly name: string;
  readonly kind: PhaseKind;
  readonly attempt: number;
  readonly startedAt: number;
  readonly sandboxId?: string;
}

export interface RunDoc {
  readonly daemon?: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly packageGraphId: string;
    readonly state:
      | "queued"
      | "executing"
      | "suspended"
      | "held"
      | "succeeded"
      | "failed"
      | "cancelled";
    readonly queueReason?: string;
    readonly executionFault?: {
      readonly code: string;
      readonly detail: string;
      readonly remedy: string;
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
  };
  readonly run: {
    readonly run: {
      readonly runId: string;
      readonly workflow: string;
      /**
       * What the run was deduplicated by — the workflow's own key for this payload.
       *
       * The wire has always carried it; this type did not, so nothing could draw it. It answers
       * *did two triggers for one ticket make one run*, which is a question about the run and about
       * no phase in it.
       */
      readonly idempotencyKey: string;
      readonly startedAt: number;
      readonly engineVersion: string;
      readonly engineCommit: string;
      readonly configDigest: string;
      readonly host: string;
      /** The image the containers were built from, when anything resolved one. */
      readonly imageDigest?: string;
    };
    readonly outcome?: "succeeded" | "failed" | "suspended" | "cancelled";
    readonly finishedAt?: number;
    readonly inFlight?: InFlightLine;
  };
  readonly phases: ReadonlyArray<PhaseLine>;
  readonly gates: ReadonlyArray<GateLine>;
  readonly sandboxes: ReadonlyArray<SandboxLine>;
}
