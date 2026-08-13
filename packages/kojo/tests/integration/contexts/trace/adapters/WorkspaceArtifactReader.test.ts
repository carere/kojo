// Deep path, never the package barrel: the barrel re-exports BunRedis, which imports the `bun`
// builtin and would end this worker before a single test ran.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import type { PhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as WorkspaceArtifactReader from "../../../../../src/contexts/trace/adapters/WorkspaceArtifactReader.ts";
import type { ArtifactUnavailable } from "../../../../../src/contexts/trace/models/ArtifactUnavailable.ts";
import { ArtifactReader } from "../../../../../src/contexts/trace/ports/ArtifactReader.ts";

/**
 * The three artifacts, read off a real disk and out of a real git repository.
 *
 * The real adapter, per the testing rule — no in-memory workspace appears here, because the two
 * things worth grading are exactly the two an in-memory workspace fakes: whether the file layout
 * this adapter builds is the one on disk, and whether `git show` says what this adapter reads it as.
 */

const runId = "a4f0c9" as RunId;
const phaseId = makePhaseId(runId, "hotfix", 1);

/** Where this adapter says the artifacts of a phase live. Built here the way the reader builds it. */
const directory = `${WorkspaceArtifactReader.artifactsRoot}/${phaseId}`;

const identity = ["-c", "user.name=Kojo", "-c", "user.email=kojo@example.invalid"] as const;

/** A repository with one commit, and the artifacts of one phase beside it. */
const setUp = Effect.gen(function* () {
  const workspace = yield* Workspace;
  yield* workspace.git(["init", "--quiet"]);
  yield* workspace.write("src/health.ts", "export const ok = true\n");
  yield* workspace.git(["add", "."]);
  yield* workspace.git([...identity, "commit", "--quiet", "--message", "seed"]);

  yield* workspace.write("src/health.ts", "export const ok = false\n");
  yield* workspace.git(["add", "."]);
  yield* workspace.git([...identity, "commit", "--quiet", "--message", "the hotfix"]);

  yield* workspace.write(`${directory}/prompt.md`, "## The answer\n\nOne JSON object.\n");
  // A file outside the artifact root, named so that a traversal would actually land on it. Without
  // it, a test for the guard would only prove that the escaped path happened to hold nothing.
  yield* workspace.write("src/prompt.md", "NOT AN ARTIFACT\n");
  yield* workspace.write(
    `${directory}/session.jsonl`,
    '{"type":"session","cwd":"/w"}\n{"type":"message"}\n',
  );

  const head = yield* workspace.git(["rev-parse", "HEAD"]);
  return head.stdout.trim();
});

const inRepository = <A, E>(use: (head: string) => Effect.Effect<A, E, ArtifactReader>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-artifacts-" });

    return yield* Effect.flatMap(setUp, use).pipe(
      Effect.provide(
        WorkspaceArtifactReader.layer.pipe(Layer.provideMerge(BindMountWorkspace.layer({ root }))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.orDie);

/** The refusal, or a failure of the test itself — never a success mistaken for one. */
const refused = <A, R>(
  program: Effect.Effect<A, ArtifactUnavailable, R>,
): Effect.Effect<ArtifactUnavailable, never, R> =>
  program.pipe(
    Effect.flip,
    Effect.mapError(() => new Error("the reader answered where it was expected to refuse")),
    Effect.orDie,
  );

describe("what is kept as a file", () => {
  it.live("reads the prompt and the session from the phase's own directory", () =>
    inRepository(() =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;

        const prompt = yield* artifacts.prompt({ runId, phaseId });
        expect(prompt.kind).toBe("prompt");
        expect(prompt.content).toContain("One JSON object");

        const session = yield* artifacts.session({ runId, phaseId });
        // The phase id is `<run>/<name>/<attempt>`, so the layout nests by run without anything
        // having to say so — and this only passes if the reader splits the id the same way.
        expect(session.content).toContain('"type":"session"');
      }),
    ),
  );

  it.live("says absent for a phase that kept nothing, and does not fail", () =>
    inRepository(() =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;
        const missing = yield* refused(
          artifacts.prompt({ runId, phaseId: makePhaseId(runId, "route", 1) }),
        );

        // `absent`, not `unreadable`: nothing failed. A phase whose prompt was never captured still
        // has a whole panel worth of record, and one missing artifact never takes it down.
        expect(missing.refusal).toBe("absent");
        expect(missing.subject).toContain(WorkspaceArtifactReader.artifactsRoot);
      }),
    ),
  );
});

describe("the diff, read from git on demand", () => {
  it.live("serves the patch of what the phase committed", () =>
    inRepository((head) =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;
        const diff = yield* artifacts.diff({ runId, phaseId, commits: [head] });

        expect(diff.kind).toBe("diff");
        // Content out of git rather than out of the trace: the record lists *which* paths changed,
        // and this is the only place the change itself exists.
        expect(diff.content).toContain("the hotfix");
        expect(diff.content).toContain("diff --git a/src/health.ts b/src/health.ts");
        expect(diff.content).toContain("-export const ok = true");
        expect(diff.content).toContain("+export const ok = false");
      }),
    ),
  );

  it.live("says absent when git does not have the commit, rather than failing the panel", () =>
    inRepository(() =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;
        const gone = yield* refused(artifacts.diff({ runId, phaseId, commits: ["0".repeat(40)] }));

        // The branch being gone is the case console.md names. The pane says the content is not
        // there; the phase record still lists the paths it changed.
        expect(gone.refusal).toBe("absent");
      }),
    ),
  );

  it.live("says absent for a phase that committed nothing", () =>
    inRepository(() =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;
        const none = yield* refused(artifacts.diff({ runId, phaseId, commits: [] }));

        expect(none.refusal).toBe("absent");
        expect(none.reason).toBe("the phase produced no commit");
      }),
    ),
  );
});

describe("what the reader will not do", () => {
  it.live("refuses a traversal in an identifier before it touches the disk", () =>
    inRepository(() =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;

        // Two directories up from `.kojo/artifacts` is the repository root, and `src/prompt.md` is
        // seeded there — so without this guard the reader would resolve
        // `.kojo/artifacts/../../src/prompt.md` and serve a file that is not an artifact. The
        // workspace's own escape check never fires on it, because the path never leaves the root.
        // That is precisely why the identifier is guarded before it becomes a path.
        const outside = yield* refused(
          artifacts.prompt({ runId, phaseId: "../../src" as PhaseId }),
        );
        expect(outside.refusal).toBe("refused");

        const byRun = yield* refused(artifacts.session({ runId: ".." as RunId, phaseId }));
        expect(byRun.refusal).toBe("refused");
      }),
    ),
  );

  it.live("refuses a revision git would read as a flag", () =>
    inRepository(() =>
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;

        // `-` is legal in a path segment, so `--upload-pack=…` passes the path guard and is also a
        // git flag. `argv` is an array rather than a shell, so this is argument injection and not
        // command injection — a smaller hole, and still one. A revision is hex or it is nothing.
        const flag = yield* refused(
          artifacts.diff({ runId, phaseId, commits: ["--upload-pack=/bin/sh"] }),
        );
        expect(flag.refusal).toBe("refused");
        expect(flag.reason).toContain("git object name");

        const named = yield* refused(artifacts.diff({ runId, phaseId, commits: ["HEAD"] }));
        expect(named.refusal).toBe("refused");
      }),
    ),
  );
});
