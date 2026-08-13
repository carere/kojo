import { Effect, Result } from "effect";
import type { ExecResult } from "../../sandbox/models/ExecResult.ts";
import { WorkspaceError } from "../../sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../sandbox/ports/Workspace.ts";
import { PathRollback, type RollbackOutcome } from "../../shared/models/PathRollback.ts";
import { PermissionBreach } from "../models/PermissionBreach.ts";
import { describeScope, type PermissionPolicy } from "../models/PermissionPolicy.ts";
import { matchesPattern } from "./pathPattern.ts";

/**
 * What an agent may change, enforced in code after the fact.
 *
 * A tool allowlist is a capability list, not a boundary, and two holes make it unenforceable on its
 * own: a shell runs anything — including `git checkout` over the very files the agent is about to
 * be graded by — and a write tool reaches any path, not only the report file it was granted for.
 *
 * So permission is verified the way every other claim in Kojo is: after the fact, against the
 * repository. The working tree's change-set is fingerprinted before an agent call and compared
 * afterwards. Comparing change-sets rather than watching writes is what catches the `git checkout`
 * case — a path that was dirty before and is clean afterwards has been reverted, and a reversion is
 * a modification. Appearing, disappearing and changing all count.
 *
 * Everything here goes through the `Workspace` port. Reading the host filesystem would grade a tree
 * the agent never touched the moment the agent runs in a container.
 */

/** Every path the working tree currently differs on, and by how much. */
export type Fingerprint = ReadonlyMap<string, string>;

/** The fingerprint of a path git does not track yet. Any edit to it leaves the value unchanged. */
const untracked = "untracked";

/**
 * One git command whose output the guard depends on.
 *
 * A non-zero exit is an error here, unlike everywhere else in the workspace port, and the asymmetry
 * is deliberate: an empty answer from a failed `git diff` reads as "the tree changed nothing", so
 * the guard would report all clear on exactly the repositories it cannot see. A guard that cannot
 * look must say so.
 */
const output = (args: ReadonlyArray<string>): Effect.Effect<string, WorkspaceError, Workspace> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const result = yield* workspace.git(args);
    if (result.succeeded) return result.stdout;
    return yield* new WorkspaceError({
      operation: "exec",
      target: ["git", ...args].join(" "),
      reason: `the working tree could not be fingerprinted: ${reasonFrom(result)}`,
      cause: undefined,
    });
  });

const reasonFrom = (result: ExecResult): string => {
  const said = result.stderr.trim();
  return said === "" ? `exit ${result.exitCode}` : said;
};

/**
 * Fingerprint the change-set the working tree holds right now.
 *
 * Tracked files carry their numstat counts, so an edit to an already-dirty file still registers.
 * Untracked files are listed by name. Ignored paths never appear at all, which is why the run's own
 * data directory — where handoff files legitimately land — needs no special case here.
 */
export const snapshot: Effect.Effect<Fingerprint, WorkspaceError, Workspace> = Effect.gen(
  function* () {
    const fingerprints = new Map<string, string>();

    for (const line of (yield* output(["diff", "HEAD", "--numstat"])).split("\n")) {
      const fields = line.split("\t");
      if (fields.length < 3) continue;
      const path = (fields[fields.length - 1] ?? "").trim();
      if (path !== "") fingerprints.set(path, `${fields[0] ?? ""},${fields[1] ?? ""}`);
    }

    for (const line of (yield* output(["ls-files", "--others", "--exclude-standard"])).split(
      "\n",
    )) {
      const path = line.trim();
      if (path !== "") fingerprints.set(path, untracked);
    }

    return fingerprints;
  },
);

/** Every path whose state differs between two fingerprints — appeared, vanished, or was rewritten. */
export const changedPaths = (before: Fingerprint, after: Fingerprint): ReadonlyArray<string> =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();

/**
 * The run's own runtime first, then the agent's own list, then what is protected.
 *
 * The middle test is what lets one agent be the maintainer of a path every other agent is barred
 * from: naming a path in a scope is what unlocks a protected one.
 */
export const permits = (policy: PermissionPolicy, path: string): boolean => {
  const under = (patterns: ReadonlyArray<string>) =>
    patterns.some((pattern) => matchesPattern(path, pattern));

  if (under(policy.alwaysWritable)) return true;
  if (policy.writes._tag === "LimitedTo" && under(policy.writes.patterns)) return true;
  if (under(policy.protectedPaths)) return false;
  return policy.writes._tag === "Unrestricted";
};

/**
 * Undo one unauthorised change, and say what happened.
 *
 * Only what the agent **introduced** is undone. A path that was already dirty when the agent
 * started belongs to whoever left it that way, and discarding their uncommitted work to tidy up
 * would be the same harm this module exists to prevent.
 *
 * The undo can fail, and failing is an outcome rather than an error: the phase is dying either way,
 * and the point of the record is to tell a human which paths the repository is still holding.
 */
const rollBack = (
  path: string,
  before: Fingerprint,
  after: Fingerprint,
): Effect.Effect<RollbackOutcome, never, Workspace> =>
  Effect.gen(function* () {
    if (before.has(path)) {
      return after.has(path) ? { _tag: "LeftAsIs" as const } : { _tag: "WorkLost" as const };
    }

    const workspace = yield* Workspace;
    if (after.get(path) === untracked) {
      yield* workspace.unlink(path);
      return { _tag: "Deleted" as const };
    }

    // `HEAD`, not the index. A path the agent introduced was identical to HEAD before the call, so
    // restoring from HEAD also undoes a change the agent staged; `git checkout -- <path>` would
    // restore from the index and keep it.
    const restored = yield* workspace.git(["checkout", "HEAD", "--", path]);
    if (restored.succeeded) return { _tag: "Restored" as const };

    // A file the agent created and then staged is tracked but absent from HEAD, so the restore
    // above has nothing to restore from. Removing it is the same undo for that case.
    const removed = yield* workspace.git(["rm", "--force", "--quiet", "--", path]);
    if (removed.succeeded) return { _tag: "Deleted" as const };
    return { _tag: "NotUndone" as const, reason: reasonFrom(restored) };
  }).pipe(
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.succeed({ _tag: "NotUndone" as const, reason: error.reason }),
    ),
  );

/**
 * Compare the tree against `before`; undo and fail if the agent overstepped.
 *
 * Returns the paths it legitimately changed, so the trace records what an agent actually touched
 * rather than only what it claimed in its envelope.
 */
export const enforce = (
  policy: PermissionPolicy,
  before: Fingerprint,
): Effect.Effect<ReadonlyArray<string>, PermissionBreach | WorkspaceError, Workspace> =>
  Effect.gen(function* () {
    const after = yield* snapshot;
    const touched = changedPaths(before, after);
    const breached = touched.filter((path) => !permits(policy, path));
    if (breached.length === 0) return touched;

    // Sequential on purpose: these are index operations on one repository.
    const paths = yield* Effect.forEach(breached, (path) =>
      rollBack(path, before, after).pipe(
        Effect.map((outcome) => new PathRollback({ path, outcome })),
      ),
    );

    return yield* new PermissionBreach({
      agent: policy.agent,
      scope: describeScope(policy),
      paths,
    });
  });

/** One agent call and everything it was allowed to leave behind. */
export interface Permitted<A> {
  readonly value: A;
  readonly changed: ReadonlyArray<string>;
}

/**
 * Fingerprint, call, enforce.
 *
 * The enforcement runs on the failing path too. An agent whose call errored may have written first,
 * and leaving an unauthorised change in the repository because the call also failed is the one
 * outcome nobody wants. Interruption is the exception, and deliberately so: a run interrupted at a
 * gate is tearing its sandbox down, and the branch — not the working tree — is what survives.
 */
export const withPermissions = <A, E, R>(
  policy: PermissionPolicy,
  call: Effect.Effect<A, E, R>,
): Effect.Effect<Permitted<A>, E | PermissionBreach | WorkspaceError, R | Workspace> =>
  Effect.gen(function* () {
    const before = yield* snapshot;
    const result = yield* Effect.result(call);
    const changed = yield* enforce(policy, before);
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
    return { value: result.success, changed };
  });
