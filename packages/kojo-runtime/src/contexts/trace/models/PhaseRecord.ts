import { Schema } from "effect";
import { PathRollback } from "../../shared/models/PathRollback.ts";
import { PhaseId } from "../../shared/models/PhaseId.ts";
import { RunId } from "../../shared/models/RunId.ts";
import { SandboxId } from "../../shared/models/SandboxId.ts";
import { AgentCallRecord } from "./AgentCallRecord.ts";
import { RepoEffect } from "./RepoEffect.ts";
import { Verification } from "./Verification.ts";

/** The three kinds of phase a workflow is made of. A sandbox is a scope, so it is not here. */
export const PhaseKind = Schema.Literals(["actor", "code", "agent"]);
export type PhaseKind = typeof PhaseKind.Type;

/**
 * How a phase ended. `interrupted` is its own outcome rather than a flavour of failure, because a
 * phase interrupted at a gate did nothing wrong and must not read as a fault.
 */
export const PhaseOutcome = Schema.Literals(["succeeded", "failed", "interrupted"]);
export type PhaseOutcome = typeof PhaseOutcome.Type;

/**
 * Everything known about one phase, written once, on exit, on every path.
 *
 * This is the canonical wide record of the trace. A phase with no record is a phase nobody can
 * debug, and interruption is precisely when that matters — so the write happens on every exit
 * path, not at the end of the happy one.
 */
export class PhaseRecord extends Schema.Class<PhaseRecord>("PhaseRecord")({
  runId: RunId,
  phaseId: PhaseId,
  name: Schema.String,
  description: Schema.String,
  kind: PhaseKind,
  outcome: PhaseOutcome,
  attempt: Schema.Finite,
  startedAt: Schema.Finite,
  endedAt: Schema.Finite,
  /**
   * **Where it ran.** The acquisition this phase ran inside, absent when it ran on the host.
   *
   * One nullable column, and it is what makes *"which phases needed a container"* a `where` clause
   * rather than a join against the sandbox rows on overlapping timestamps. It names the
   * **acquisition**, not the scope, so a phase that ran before a gate and its twin that re-ran after
   * the rebuild point at different sandboxes — which is the honest answer, because they did.
   */
  sandboxId: Schema.optionalKey(SandboxId),
  /** The terminal error tag, when there is one. Absent on a phase that succeeded. */
  errorTag: Schema.optionalKey(Schema.String),
  /**
   * Every path the phase changed without permission, and what became of each.
   *
   * Absent on a phase that breached nothing, which is nearly all of them. Present, it is the one
   * place a human learns that the repository is still holding something the rollback could not
   * undo — the error that killed the phase is gone once the run ends; the record is not.
   */
  breaches: Schema.optionalKey(Schema.Array(PathRollback)),
  /**
   * What the phase did to the repository that it was **allowed** to do — claimed, changed, commits.
   *
   * Absent on a phase that touches no repository, and absent on one whose call never reached the
   * permission guard. `withPermissions` is what produces `changed`; the field is the trace's half of
   * that contract, and it stays absent until a phase is wired to run its call through it.
   */
  repo: Schema.optionalKey(RepoEffect),
  /**
   * Who was asked, and what the turn cost. Present on an agent phase whose call produced an answer
   * — so absent on a code phase, and absent on an agent phase whose call never happened.
   */
  agent: Schema.optionalKey(AgentCallRecord),
  /**
   * What the phase's own after-the-fact verification cost and found — which checks ran, which did
   * not hold, and how many correction turns the answer took. Present on every agent phase, because
   * decoding the envelope is already a verification; absent on a code phase, which grades nothing.
   */
  verification: Schema.optionalKey(Verification),
}) {
  get durationMillis(): number {
    return this.endedAt - this.startedAt;
  }
}
