import { Schema } from "effect";
import { RunId } from "../../shared/models/RunId.ts";

/**
 * Another process is already driving this run.
 *
 * **Refused, never raced** (architecture.md §8, edge 9). Joining a run deliberately rejoins its
 * branch, and two runners on one branch contend for one worktree — which is a corruption, not a
 * retry. So this is a typed failure the caller sees immediately, and it is deliberately **not**
 * retried, queued, or waited on anywhere in Kojo.
 *
 * The holder and the time are on the error because the only useful next step is a human one: find
 * that runner, or find out that it died and take its claim away.
 */
export class RunLocked extends Schema.TaggedError<RunLocked>()("RunLocked", {
  runId: RunId,
  /** Who says they are driving it. Unknown only when the claim itself could not be read. */
  holder: Schema.String,
  since: Schema.Finite,
}) {}

/** What a holder is called when the claim exists and cannot be read back. */
export const unknownHolder = "unknown";
