/**
 * `GET /api/runs/:runId/phases/:phaseId/occurrences` — one page of what repeated inside a phase.
 *
 * The only cursor in this API, and the reason it is one: a phase's tool calls and `exec` invocations
 * are genuinely unbounded, while everything else a run has — ten to forty phase records — is polled
 * whole. Read structurally, exactly as the run document is.
 */

/** What repeated. Three kinds, because three are what a phase genuinely does many of. */
export type OccurrenceKind = "exec" | "tool" | "iteration";

/**
 * One repetition inside a phase.
 *
 * It carries no context its phase record lacks — no agent, no model, no verdict. Those are the
 * phase's, and a copy on every tool call is how a wide record turns back into thin rows.
 */
export interface OccurrenceLine {
  readonly phaseId: string;
  readonly kind: OccurrenceKind;
  /** What ran — the command line, the tool's name, the iteration's label. */
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: "succeeded" | "failed";
  /** One line about how it ended — an exit code, a tool's own error. Absent when there is none. */
  readonly detail?: string;
}

/**
 * One poll's answer.
 *
 * The cursor comes back on the page it produced and the next poll passes it in. It stands still when
 * the page is empty, so an idle second never sends a reader back to the first tool call.
 */
export interface OccurrencePageDoc {
  readonly occurrences: ReadonlyArray<OccurrenceLine>;
  readonly cursor: number;
}

/** Before the first occurrence there is. What a panel opens with; the trace's ids start at one. */
export const beginning = 0;
