import { Effect, Layer, Option } from "effect";
import type { WorkspaceError } from "../../sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../sandbox/ports/Workspace.ts";
import { isObjectName, safeSegments } from "../guards/identifiers.ts";
import { Artifact, type ArtifactKind } from "../models/Artifact.ts";
import { ArtifactUnavailable } from "../models/ArtifactUnavailable.ts";
import { ArtifactReader, type ArtifactSubject } from "../ports/ArtifactReader.ts";

/**
 * The three things the trace does not store, read from where they already are.
 *
 * Two sources, and the split is the reason this port exists apart from the trace:
 *
 * - **The prompt and the session are files**, under one directory per phase. They are captured
 *   because they cannot be reconstructed — a prompt is built from a template, a task and a generated
 *   schema, and a transcript is the agent's own.
 * - **The diff is not a file.** It is read from git, on demand, from the commits the phase produced.
 *   Storing it would put a blob in a trace whose whole design is one wide row per unit of work, and
 *   it would go stale the moment anything rewrote the branch.
 *
 * Everything goes through `Workspace`, which is already the port for "a filesystem and a shell,
 * wherever they physically are". That buys the escape check on every path for free — `read` refuses
 * a path that leaves the root — so the identifier guard here is the *first* of two rather than the
 * only one. Two guards on one path is the right number when the value came from a URL.
 */

/**
 * Where a factory keeps what the trace does not, relative to the workspace root.
 *
 * Under `.kojo/` because that is the factory's own directory, and the permission policy already
 * protects the tree. One directory per phase, named by the phase id — which is `<run>/<name>/
 * <attempt>`, so the layout groups by run without anything having to say so.
 */
export const artifactsRoot = ".kojo/artifacts";

const promptFile = "prompt.md";
const sessionFile = "session.jsonl";

const unavailable = (
  kind: ArtifactKind,
  subject: string,
  refusal: "refused" | "absent" | "unreadable",
  reason: string,
): ArtifactUnavailable => new ArtifactUnavailable({ kind, subject, refusal, reason });

/**
 * The identifiers, checked before either is used as a path.
 *
 * Both are checked even though only the phase id becomes a directory. A run id that is not a safe
 * segment is a run id no factory minted — run ids are thirty-two hex characters — so refusing it
 * costs a legitimate caller nothing and closes the route to anyone who is trying it on.
 */
const segmentsOf = (
  kind: ArtifactKind,
  subject: ArtifactSubject,
): Effect.Effect<ReadonlyArray<string>, ArtifactUnavailable> => {
  if (Option.isNone(safeSegments(subject.runId))) {
    return Effect.fail(
      unavailable(kind, subject.runId, "refused", `the run id ${subject.runId} is not a safe path`),
    );
  }
  return Option.match(safeSegments(subject.phaseId), {
    onNone: () =>
      Effect.fail(
        unavailable(
          kind,
          subject.phaseId,
          "refused",
          `the phase id ${subject.phaseId} is not a safe path`,
        ),
      ),
    onSome: (segments) => Effect.succeed(segments),
  });
};

const make = Effect.gen(function* () {
  const workspace = yield* Workspace;

  /** A file that may not be there. `stat` answers absence, so absence never reads as a failure. */
  const fileAt = (
    kind: ArtifactKind,
    subject: ArtifactSubject,
    filename: string,
  ): Effect.Effect<Artifact, ArtifactUnavailable> =>
    Effect.gen(function* () {
      const segments = yield* segmentsOf(kind, subject);
      const path = [artifactsRoot, ...segments, filename].join("/");

      const broken = (error: WorkspaceError) => unavailable(kind, path, "unreadable", error.reason);

      const found = yield* workspace.stat(path).pipe(Effect.mapError(broken));
      if (Option.isNone(found)) {
        return yield* unavailable(kind, path, "absent", `nothing is kept at ${path}`);
      }

      const content = yield* workspace.read(path).pipe(Effect.mapError(broken));
      return new Artifact({ kind, content });
    });

  return {
    prompt: (subject: ArtifactSubject) => fileAt("prompt", subject, promptFile),
    session: (subject: ArtifactSubject) => fileAt("session", subject, sessionFile),

    /**
     * The patch of every commit the phase produced, oldest first.
     *
     * One `git show` per commit rather than one range diff over all of them. A phase's commits are
     * not promised to be contiguous — a correction loop can commit, be sent back, and commit again
     * with the acceptance gate's own commit in between — and a range diff over a gap silently
     * includes somebody else's work under this phase's name.
     *
     * A commit that git does not have is `absent`, not a failure. The branch being gone is the case
     * console.md names: the phase record still lists the paths it changed, the diff pane says the
     * content is not there, and the rest of the panel stays on screen.
     */
    diff: (subject: ArtifactSubject & { readonly commits: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        yield* segmentsOf("diff", subject);

        if (subject.commits.length === 0) {
          return yield* unavailable(
            "diff",
            subject.phaseId,
            "absent",
            "the phase produced no commit",
          );
        }

        // Hex, or nothing. `argv` is an array here rather than a shell, so a rogue value cannot run
        // a second command — but `-` is legal in a path segment and `--upload-pack=…` is a git
        // flag, and a revision that is a flag is an argument injection.
        for (const commit of subject.commits) {
          if (!isObjectName(commit)) {
            return yield* unavailable(
              "diff",
              commit,
              "refused",
              `${commit} is not a git object name`,
            );
          }
        }

        // The record holds them newest first; a patch reads oldest first.
        const patches: Array<string> = [];
        for (const commit of [...subject.commits].reverse()) {
          const shown = yield* workspace
            .git(["show", "--patch", "--no-color", commit])
            .pipe(
              Effect.mapError((error: WorkspaceError) =>
                unavailable("diff", commit, "unreadable", error.reason),
              ),
            );
          if (shown.exitCode !== 0) {
            return yield* unavailable(
              "diff",
              commit,
              "absent",
              shown.stderr.trim() === "" ? `git does not have ${commit}` : shown.stderr.trim(),
            );
          }
          patches.push(shown.stdout);
        }

        return new Artifact({ kind: "diff", content: patches.join("\n") });
      }),
  };
});

/**
 * The artifact reader over a workspace — the repository `kojo ui` was started in.
 *
 * `Workspace` rather than `FileSystem` and a spawner directly, so this adapter holds no path
 * arithmetic and no process handling of its own, and so it can be graded against a real git
 * repository through the same port a phase uses.
 */
export const layer: Layer.Layer<ArtifactReader, never, Workspace> = Layer.effect(
  ArtifactReader,
  make,
);
