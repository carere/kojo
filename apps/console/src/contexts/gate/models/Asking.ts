/**
 * One asking of one gate, as `GET /api/gates` carries it.
 *
 * The request half is everything a person needs to decide — what is being asked, who was asked, what
 * they may answer, and by when — plus the **token**, which is the whole of the authority to answer.
 * The verdict half is present once somebody has answered, and its presence means *recorded*, which
 * is never the same thing as *applied*.
 *
 * **The asking name is carried whole and never parsed.** It is the engine's durable deferred name —
 * `gate/<gate>/<round>`, with a lane qualifier in the middle when the gate was asked inside a
 * sandbox scope — so it carries slashes and is not a Kojo identifier. Nothing on this side may read
 * a meaning out of it; it is an identity, and the route that carries it encodes it.
 */
export interface Asking {
  readonly daemonState?: "unanswered" | "recorded" | "applied" | "expired";
  readonly appliedAt?: number;
  readonly terminalInability?: "run-cancelled" | "run-failed";
  readonly request: {
    readonly runId: string;
    /** The gate's authored name, stable across every asking of it. */
    readonly gate: string;
    /** The durable deferred name — unique to this asking, and what the route addresses. */
    readonly asking: string;
    /** What is being decided, in the words the workflow author wrote. */
    readonly description: string;
    /** Who was asked to decide. */
    readonly actor: string;
    /** What this gate accepts. A choice outside this list is refused by the API, not by the page. */
    readonly choices: ReadonlyArray<string>;
    /** Holding it is what lets any process answer. It is why the Console needs no privilege. */
    readonly token: string;
    readonly requestedAt: number;
    /** The time after which the gate stops waiting. Every gate has one. */
    readonly deadlineAt: number;
    /** Which way the run goes if nobody answers in time. */
    readonly onExpiry: string;
  };
  /** Present once somebody has answered. Recorded, which is not the same as applied. */
  readonly verdict?: {
    readonly choice: string;
    readonly reason: string;
    readonly answerer: string;
    readonly answeredAt: number;
  };
  /**
   * Present once the run settled this asking by expiry: the deadline won the race, the run took its
   * expiry branch, and no answer can reach it any more. Written by the run itself, so its presence
   * is the run's own account — which is what lets the queue tell **expired** from **overdue**
   * without a run document.
   */
  readonly expiredAt?: number;
}

/**
 * The question this run is stuck on right now, if it is stuck on one.
 *
 * The newest unsettled asking, because a gate can be asked twice — a rebuild after an answer, or an
 * escalation to a second actor — and the one a person can still act on is the last. An answered
 * asking is never returned: the run list column is *open gate*, and a recorded verdict means the run
 * is no longer waiting on anybody. Neither is an expired one — the run already took its expiry
 * branch, so there is nothing left for a person to act on.
 */
export const openGateOf = (askings: ReadonlyArray<Asking>, runId: string): Asking | undefined =>
  askings
    .filter(
      (asking) =>
        asking.request.runId === runId &&
        asking.verdict === undefined &&
        asking.expiredAt === undefined,
    )
    .reduce<Asking | undefined>(
      (newest, asking) =>
        newest === undefined || asking.request.requestedAt > newest.request.requestedAt
          ? asking
          : newest,
      undefined,
    );

/**
 * The asking this run's header is about, answered or not.
 *
 * Wider than {@link openGateOf} on purpose, and the difference is the whole of adr/gate/0001: an
 * asking that has just been answered is exactly when a person most needs to see it, because that is
 * when the Console has to say whether anything applied it. Dropping it the moment a verdict lands
 * would take the card off screen at the instant it became load-bearing.
 */
export const latestAskingOf = (askings: ReadonlyArray<Asking>, runId: string): Asking | undefined =>
  askings
    .filter((asking) => asking.request.runId === runId)
    .reduce<Asking | undefined>(
      (newest, asking) =>
        newest === undefined || asking.request.requestedAt > newest.request.requestedAt
          ? asking
          : newest,
      undefined,
    );

/** One asking out of the queue, by the two segments its route carries. */
export const askingOf = (
  askings: ReadonlyArray<Asking>,
  subject: { readonly runId: string; readonly gate: string; readonly asking: string },
): Asking | undefined =>
  askings.find(
    (candidate) =>
      candidate.request.runId === subject.runId &&
      candidate.request.gate === subject.gate &&
      candidate.request.asking === subject.asking,
  );

/**
 * How long the question was with a human: request to answer, request to expiry, or request to now.
 *
 * An expired asking stops accruing at its expiry — the question left everybody's desk there, and a
 * wait that kept growing would overstate what the gate cost.
 */
export const waitedMillis = (asking: Asking, now: number): number =>
  (asking.verdict?.answeredAt ?? asking.expiredAt ?? now) - asking.request.requestedAt;
