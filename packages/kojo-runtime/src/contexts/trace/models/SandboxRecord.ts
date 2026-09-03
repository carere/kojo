import { Schema } from "effect";
import { SandboxKind } from "../../sandbox/models/SandboxProvider.ts";
import { RunId } from "../../shared/models/RunId.ts";
import { SandboxId } from "../../shared/models/SandboxId.ts";

/**
 * How a sandbox's life ended.
 *
 * `interrupted` is the interesting one, and it is not a fault: it is what a suspension looks like
 * from inside the scope. A row carrying it says *this container was torn down because the run
 * stopped to wait for a human*, which is the single most valuable fact this table holds.
 */
export const SandboxOutcome = Schema.Literals(["released", "interrupted", "failed"]);
export type SandboxOutcome = typeof SandboxOutcome.Type;

/**
 * Everything known about one **acquisition** of one sandbox, written once, when it is released.
 *
 * One row per acquisition, deliberately. A run that suspends at a gate and resumes on Monday builds
 * its container twice, and both are facts: the first says how long the work ran before it stopped,
 * the second says what the rebuild cost. Reusing one row for both would hide precisely the thing
 * this design's central decision needs to be observable.
 *
 * This row **is** the sandbox's wide event. There is deliberately no `sandbox_start` /
 * `sandbox_end` pair — a pair of thin rows for one lifecycle is the pattern the whole trace design
 * exists to avoid.
 */
export class SandboxRecord extends Schema.Class<SandboxRecord>("SandboxRecord")({
  runId: RunId,
  sandboxId: SandboxId,
  /** The scope's name as the author wrote it. Two lanes of one factory are told apart by it. */
  name: Schema.String,
  /** The provider that built it — `"docker"`, `"no-sandbox"`. */
  provider: Schema.String,
  kind: SandboxKind,
  /** The durable state this sandbox was derived from, and the thing that outlives it. */
  branch: Schema.String,
  worktreePath: Schema.String,
  /**
   * What crossed into the container.
   *
   * Recorded rather than assumed, because it is the join. Sandcastle runs on its own bundled Effect
   * runtime inside a separate process inside a container, so nothing propagates: `KOJO_RUN_ID`,
   * `KOJO_PHASE_ID` and `KOJO_ATTEMPT` are the only thread back to this row, and a row that only
   * claimed they were sent could not be checked.
   */
  environment: Schema.Record(Schema.String, Schema.String),
  acquiredAt: Schema.Finite,
  /**
   * When the scope began releasing it.
   *
   * The start of teardown rather than its end: the container's `close()` is `orDie` and its own
   * duration says nothing about the run. What this pair measures is the sandbox's useful life.
   */
  releasedAt: Schema.Finite,
  outcome: SandboxOutcome,
}) {
  /** How long the sandbox was available to the run. Rebuild cost is the gap between two rows. */
  get lifetimeMillis(): number {
    return this.releasedAt - this.acquiredAt;
  }
}
