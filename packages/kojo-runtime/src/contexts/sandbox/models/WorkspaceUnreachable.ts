import { Schema } from "effect";
import { WorkspaceReach } from "./WorkspaceReach.ts";

/**
 * Every container this scope built came back with a workspace it could not work in.
 *
 * This is architecture.md §8, edge 11, and it is the **last resort** rather than the response. An
 * unreachable workspace says nothing about the run — the branch is intact, the phases that ran are
 * recorded, the answer a human gave is still there — so the scope rebuilds instead of failing, and
 * only a run of rebuilds that all come back the same way reaches here.
 *
 * What it exists to prevent is the *other* message. Left alone, the fault surfaces at the first
 * command a phase runs, as `AgentInvocationError{fault: "provider-failed"}` carrying a container
 * runtime's own words about `config.json` — a sentence that names neither the workspace nor the
 * branch, and sends the reader to look at the agent, which is the one thing that was working.
 *
 * A `Schema.TaggedError` because it travels a workflow error channel, and the engine persists what
 * it records.
 */
export class WorkspaceUnreachable extends Schema.TaggedError<WorkspaceUnreachable>()(
  "WorkspaceUnreachable",
  {
    /** The branch the run is on, which is what survives this and what a human resumes from. */
    branch: Schema.String,
    /** The host path the sandbox mounted, and the thing that is actually missing. */
    worktreePath: Schema.String,
    /** How many containers were built and thrown away before the scope gave up. */
    containers: Schema.Finite,
    /** The last reading, so the evidence travels with the sentence rather than after it. */
    reach: WorkspaceReach,
  },
) {
  /**
   * One sentence for a human: the workspace, the branch, and only then what the probe said.
   *
   * The order is the whole point. The raw text stays, because it is the evidence and removing it
   * would replace one unhelpful message with another, but it arrives after the two facts that say
   * where to look.
   */
  get summary(): string {
    return (
      `the workspace at ${this.worktreePath} for ${this.branch} could not be reached from inside ` +
      `the sandbox, and ${this.containers} containers in a row came back the same way — ` +
      `\`${this.reach.probe}\` said: ${this.reach.detail}`
    );
  }
}
