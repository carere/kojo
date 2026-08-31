import { Option, Schema } from "effect";

/**
 * Identifies one **acquisition** of one sandbox, not one sandbox definition.
 *
 * A run that suspends at a gate tears its container down and builds it again on resume, so the same
 * scope of the same run produces two sandboxes over its life. Each gets its own id, because each is
 * its own row in the trace — a rebuild after a gate is a fact a human wants to see, not one to hide
 * behind a reused identifier.
 *
 * Branded for the same reason `RunId` and `PhaseId` are: these three sit beside each other in the
 * same rows and the same signatures, and a silent mis-join is worse than a compile error.
 */
export const SandboxId = Schema.String.pipe(Schema.brand("SandboxId"));

export type SandboxId = typeof SandboxId.Type;

/**
 * Builds an acquisition id from the run, the scope's name, and **two** discriminators: the moment
 * the sandbox was acquired, and where this acquisition falls in the acquiring process's own order.
 *
 * Neither one alone is enough, and the reason each fails is different.
 *
 * - *The clock alone* — what ticket 17 shipped — collides whenever one process acquires the same
 *   scope twice inside one millisecond. Every one of those acquisitions is a separate container owed
 *   a separate row, and two rows sharing an id is a join nobody can undo afterwards.
 * - *A counter alone* collides across processes, which is the shape this whole design is built
 *   around: `kojo run` starts a run that suspends and exits, `kojo gate answer` resumes it days
 *   later, and an in-memory counter restarts at one in the second process.
 *
 * **This is prophylactic, and the record should say so.** No run has been observed colliding. The
 * case that looks like it should — the `misplaced` scope in `sandboxed.test.ts`, eleven acquisitions
 * of one scope back to back — does not, because `retryOnInterrupt`'s schedule advances the clock
 * between attempts, so eleven distinct ids come out under the old scheme too. Ticket 17 called the
 * collision reachable-in-principle and unobserved; that is still exactly what it is. What changed is
 * the cost of being wrong about it, which is now nothing.
 *
 * Together they are strictly better than either. Within one process the sequence is unique by
 * construction, so no pair of acquisitions can collide however fast they come. Across processes a
 * collision now needs the wall clock **and** the sequence to agree, which is never more likely than
 * the clock agreeing on its own.
 *
 * The two discriminators share one slash-separated segment on purpose. `PhaseId` and `SandboxId` sit
 * in the same rows and the same `KOJO_PHASE_ID` variable, and `Correlation` promises a reader that
 * both parse as `runId/name/discriminator`.
 *
 * A cast rather than a decode, exactly as `makePhaseId` is: these parts are ours, so checking them
 * at runtime would be checking something that cannot be wrong.
 */
export const makeSandboxId = (
  runId: string,
  name: string,
  acquiredAt: number,
  sequence: number,
): SandboxId => `${runId}/${name}/${acquiredAt}-${sequence}` as SandboxId;

/**
 * The scope's name, read back out of an acquisition id — **the lane a phase ran in**.
 *
 * The inverse of `makeSandboxId`, and it lives here so a change to the format cannot leave a reader
 * behind. `PhaseRecord.sandboxId` is the only column that says which lane a phase belonged to, so
 * this is what turns *"which work was the hotfix lane's"* into a read of one column rather than a
 * join against the sandbox rows — a join which, the moment two lanes run at once, has nothing to
 * join on but overlapping timestamps.
 *
 * Parsed from the ends rather than from the front, because the middle is the only part that may
 * contain a slash: an execution id is a hash digest and the discriminator is `<millis>-<sequence>`,
 * while a scope name is whatever the author wrote. Anything that is not `a/b/c` is refused rather
 * than guessed at.
 */
export const laneOf = (sandboxId: string | undefined): Option.Option<string> => {
  if (sandboxId === undefined) return Option.none();
  const first = sandboxId.indexOf("/");
  const last = sandboxId.lastIndexOf("/");
  return first < 0 || last <= first ? Option.none() : Option.some(sandboxId.slice(first + 1, last));
};

/** How many sandboxes this process has acquired. Module state, because the process is the scope. */
let acquisitions = 0;

/**
 * The next acquisition's place in this process's order. Monotonic, and never reset.
 *
 * Deliberately not derived from anything a run can see. A per-run counter would restart at one in
 * the process that resumes the run, which is the collision it exists to prevent; a per-scope counter
 * would do the same and would also let two nested scopes of one run agree.
 */
export const nextAcquisition = (): number => (acquisitions += 1);
