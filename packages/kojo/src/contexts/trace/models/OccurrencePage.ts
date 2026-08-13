import { Schema } from "effect";
import { Occurrence } from "./Occurrence.ts";

/**
 * How much of one phase's occurrences a reader has already been given.
 *
 * **The cursor is explicit, and that is the whole point of this type.** The transport rule is
 * poll-a-monotonic-cursor, and a cursor a caller cannot see is a cursor a caller cannot advance:
 * the reader would answer from row one on every poll and the panel would re-render the same tool
 * calls forever. So it is a value, it comes back on the page it produced, and the next call passes
 * it in.
 *
 * Branded because it is a number that means a place, not a count and not a limit — three numbers
 * that would otherwise be interchangeable in one call. It is the trace's own `id` column, which is
 * why the occurrences table names an `INTEGER PRIMARY KEY`: `select *` never expands SQLite's
 * implicit rowid, so an unnamed key gives a reader nothing to carry.
 */
export const OccurrenceCursor = Schema.Finite.pipe(Schema.brand("OccurrenceCursor"));
export type OccurrenceCursor = typeof OccurrenceCursor.Type;

/**
 * Before the first occurrence there is. What a panel opens with.
 *
 * Zero rather than a `None`, because the trace's ids start at one and the query is `id > cursor` —
 * so "everything" and "everything after row 7" are one code path rather than two.
 */
export const beginning: OccurrenceCursor = 0 as OccurrenceCursor;

/**
 * How many occurrences one poll returns when the caller names no bound.
 *
 * Shared by every adapter, because two adapters with two defaults would make a panel that behaves
 * one way against a database and another against a fixture. Large enough that a live phase is
 * usually drained in one poll, small enough that opening a panel on a phase that ran ten thousand
 * tool calls does not build one array of ten thousand records before the first paint.
 */
export const defaultPageSize = 500;

/**
 * What one poll of one phase's occurrences returns.
 *
 * The cursor on the page is the one to ask with next, and it stands still when the page is empty —
 * a poll that found nothing must not send the reader back to the beginning.
 */
export class OccurrencePage extends Schema.Class<OccurrencePage>("OccurrencePage")({
  /** What happened after the cursor that was asked with, oldest first. */
  occurrences: Schema.Array(Occurrence),
  /** Where to resume. Equal to the cursor asked with when nothing new arrived. */
  cursor: OccurrenceCursor,
}) {}
