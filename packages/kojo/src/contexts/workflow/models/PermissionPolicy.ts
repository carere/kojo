import { Schema } from "effect";

/**
 * What an agent may change in the repository.
 *
 * A schema, because it is read from the roster in `kojo.config.yaml` and a bad scope must be a
 * path-precise error at load rather than a surprise after an agent has already written.
 *
 * Read-only is `LimitedTo` with no patterns, not a third case. A read-only agent is read-only with
 * respect to the **repository**, never with respect to its own report — the always-writable list
 * below is what keeps a scout able to record its findings.
 */
export const WriteScope = Schema.TaggedUnion({
  /** No list at all: anything the protected paths do not bar. */
  Unrestricted: {},
  /** Only these patterns. Naming a path here is also what unlocks a protected one. */
  LimitedTo: { patterns: Schema.Array(Schema.String) },
});
export type WriteScope = typeof WriteScope.Type;

/**
 * The factory's own files — the roster, the workflows, the envelopes, the checks, the commands and
 * the prompts. An agent that can edit these can edit its own grader.
 *
 * **Rollback is the second line of defence here, not the first.** The cheaper and more certain
 * protection is never mounting these paths into the sandbox at all: an agent that cannot see its
 * grader cannot edit it, and no fingerprint has to catch it afterwards. See architecture.md §8,
 * edge 5. This list stays because the reference sandbox is a bind mount of the whole worktree, and
 * because a workflow may deliberately run an agent on the host with no sandbox at all.
 */
export const factoryOwnPaths: ReadonlyArray<string> = [
  ".kojo/kojo.config.yaml",
  ".kojo/workflows/",
  ".kojo/envelopes.ts",
  ".kojo/checks.ts",
  ".kojo/commands.ts",
  ".kojo/prompts/",
];

/** Everything the guard needs to decide one path, gathered for one agent call. */
export interface PermissionPolicy {
  /** Whose writes these are. Named on the breach, so the trace says who overstepped. */
  readonly agent: string;
  readonly writes: WriteScope;
  /** Paths no agent may change unless its own scope names them. Usually `factoryOwnPaths`. */
  readonly protectedPaths: ReadonlyArray<string>;
  /**
   * Where every agent may write whatever else its scope says — the run's own data directory, where
   * prompts, raw output, envelopes and handoffs land.
   *
   * Granted here rather than left to `.gitignore`. The data directory is normally ignored, so it
   * never reaches a fingerprint at all — but an agent's ability to record its work must not hang on
   * an ignore entry that anybody can delete.
   */
  readonly alwaysWritable: ReadonlyArray<string>;
}

/** The scope in words, for the breach and the trace. Neither should have to hold the policy. */
export const describeScope = (policy: PermissionPolicy): string => {
  if (policy.writes._tag === "Unrestricted") {
    return `barred from ${policy.protectedPaths.join(", ")}`;
  }
  if (policy.writes.patterns.length === 0) return "read-only";
  return `limited to ${policy.writes.patterns.join(", ")}`;
};
