import { Effect, type Scope } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunLocked } from "../models/RunLocked.ts";
import { RunLock } from "../ports/RunLock.ts";

/**
 * Drive a run, or be refused because somebody else already is.
 *
 * **This is architecture.md §8 edge 9, and it wraps the entry point rather than the workflow.** A
 * run id names a branch and a branch names a worktree, so two processes against one run id are two
 * processes writing one directory: one of them rebuilds the sandbox the other is using, and the
 * branch — the durable state of the run — is what gets damaged. Joining a run deliberately rejoins
 * its branch; doing it twice at once is a corruption rather than a retry, so it is refused.
 *
 * The claim is **not** taken inside the workflow body. A suspended run holds nothing (D3), and a
 * body-held claim would be a thing held across a two-day gate — and would be re-taken on every
 * replay besides. What takes the claim is whatever is driving the run right now: the process that
 * starts it, and later the process that answers its gate and rides the resume.
 *
 * `Effect.scoped` is what gives it back, on success, on failure, and on interrupt alike.
 */
export const oneRunner = <A, E, R>(
  runId: RunId,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RunLocked, Exclude<R, Scope.Scope> | RunLock> =>
  Effect.gen(function* () {
    const lock = yield* RunLock;
    yield* lock.claim(runId);
    return yield* body;
  }).pipe(Effect.scoped);
