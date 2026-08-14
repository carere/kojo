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
 * **Rollback is the second line of defence here, not the first.** The first is that these paths are
 * taken out of the worktree the agent works in — `sandboxed` defaults `SandboxRequest.hidden` to this
 * very list, and `guards/hiddenPaths.ts` in the sandbox context does the work. An agent that cannot
 * see its grader cannot edit it, and no fingerprint has to catch it afterwards. See architecture.md
 * §8, edge 5.
 *
 * **This list is what still protects the three cases the first line cannot reach**, and each of them
 * is real rather than theoretical:
 *
 *  - **`--sandbox none`.** The agent is a host process; the unmasked repository is three directories
 *    above its working directory. Rollback is the only protection a `none` run has.
 *  - **An isolated provider** (Vercel, Daytona) materialises its tree from the object database, so
 *    the factory reappears in the sandbox whatever the host worktree looks like.
 *  - **A file the agent creates** under a hidden directory. `.kojo/workflows/evil.ts` has no index
 *    entry, so nothing masks it, `git add --all` stages it, and the merge would land it. `permits`
 *    returns false for it under either write scope — `matchesPattern` reads the trailing slash of
 *    `.kojo/workflows/` as a directory prefix — and `rollBack` unlinks it.
 *
 * So the two lines are not redundant, and neither one may be deleted on the strength of the other.
 *
 * **And there is a third case that neither line catches, measured rather than reasoned.** A file
 * created at the **root** of `.kojo/` — `.kojo/evil.ts` — is under no entry of this list, because
 * every entry names a file or a directory and none of them is `.kojo/` itself. `permits(Unrestricted,
 * ".kojo/evil.ts")` is therefore **true**, so no breach is raised and nothing is rolled back; and it
 * has no index entry, so the mask cannot hide it either. `.kojo/workflows/lane/common.ts` gives this
 * repository's own builder, fixer and tidier `Unrestricted`, so the gap is reachable here and not
 * only in principle. An earlier revision of this docstring used exactly that path as the example of
 * what rollback *does* catch, and was wrong. Widening the list to `.kojo/` would close it and would
 * also bar the artifacts directory and the run's own data, so it is a decision rather than a patch.
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
