import { Context, type Effect, type Option } from "effect";
import type { PhaseId } from "../../shared/models/PhaseId.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { OccurrenceCursor, OccurrencePage } from "../models/OccurrencePage.ts";
import type { RunDocument } from "../models/RunDocument.ts";
import type { RunSummary } from "../models/RunSummary.ts";
import type { TraceReadError } from "../models/TraceReadError.ts";

/**
 * The query side of the trace: every question the Console asks, and no others.
 *
 * **The read counterpart of `Tracer`, kept apart from it on purpose.** `Tracer` takes completed
 * records and returns nothing; this returns query shapes and takes nothing. One port doing both
 * would put the Console's document shapes on the write path, where a phase that is trying to record
 * what it did would carry them — and every later query shape would be a change to the interface
 * every phase depends on.
 *
 * Three methods, because console.md §7 lists three read endpoints over the trace and this port is
 * what answers them. What is *not* here matters as much:
 *
 * - **The gate queue is not here.** `/api/gates` is what waits on a human, and a gate that is still
 *   waiting has no trace record — the trace writes one when the asking settles. The open questions
 *   live in `GateRepository`, which already answers that, and asking twice would give the Console
 *   two sources for one list.
 * - **There is no search, no fleet aggregate, and no filter.** The Console drills into one run. A
 *   fleet view is a separate surface over the same records, and it is deferred until this one is
 *   right.
 */
export class TraceReader extends Context.Service<
  TraceReader,
  {
    /**
     * Every run, newest first.
     *
     * The whole list, unpaged. One factory's trace is one repository's runs, and the run list is
     * polled whole for the same reason the run document is — replacing a small list removes every
     * merge concern. A factory that outgrows that has outgrown one SQLite file first.
     */
    readonly runs: Effect.Effect<ReadonlyArray<RunSummary>, TraceReadError>;
    /**
     * One whole run: its record, its phases, its settled askings and its acquisitions.
     *
     * `None` for a run this trace has never seen. A URL a person pasted with one character wrong is
     * not a failure of the trace, and the Console renders it as *no such run* rather than as an
     * error page — so absence is an answer here, not an error.
     */
    readonly run: (runId: RunId) => Effect.Effect<Option.Option<RunDocument>, TraceReadError>;
    /**
     * One phase's occurrences, from a cursor — the only cursor in this port.
     *
     * The phase id alone identifies the phase: `makePhaseId` builds it from the run, so it already
     * carries its run and a second parameter could only ever disagree with it. The endpoint's path
     * carries both because a URL is read by people.
     */
    readonly occurrences: (options: {
      readonly phaseId: PhaseId;
      /** Everything after this. `beginning` for a panel that has just opened. */
      readonly since: OccurrenceCursor;
      /** At most this many. Adapters apply their own default, which is what a live poll wants. */
      readonly limit?: number | undefined;
    }) => Effect.Effect<OccurrencePage, TraceReadError>;
  }
>()("kojo/trace/TraceReader") {}
