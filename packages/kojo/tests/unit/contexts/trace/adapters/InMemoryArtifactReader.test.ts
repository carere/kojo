import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryArtifactReader from "../../../../../src/contexts/trace/adapters/InMemoryArtifactReader.ts";
import type { ArtifactUnavailable } from "../../../../../src/contexts/trace/models/ArtifactUnavailable.ts";
import { ArtifactReader } from "../../../../../src/contexts/trace/ports/ArtifactReader.ts";

/**
 * The three things the trace does not store, served with no filesystem and no git.
 *
 * The point of this adapter is that a Console can render a whole phase panel without either, so
 * what is graded is the *contract*: what comes back, what is refused, and — the one that matters —
 * that a missing artifact is an ordinary answer rather than an alarm.
 */

const runId = "a4f0c9" as RunId;
const phaseId = makePhaseId(runId, "scout", 1);

const reader = InMemoryArtifactReader.of({
  [phaseId]: {
    prompt: "## The answer\n\nAnswer with one JSON object.",
    session: '{"type":"session","cwd":"/w"}\n{"type":"message"}\n',
    diff: "diff --git a/src/health.ts b/src/health.ts\n",
  },
  [makePhaseId(runId, "bare", 1)]: {},
});

const asking = <A, E>(program: Effect.Effect<A, E, ArtifactReader>) =>
  program.pipe(Effect.provide(reader));

/** The error, or a failure of the test itself — never a success mistaken for one. */
const refused = <A, R>(
  program: Effect.Effect<A, ArtifactUnavailable, R>,
): Effect.Effect<ArtifactUnavailable, never, R> =>
  program.pipe(
    Effect.flip,
    Effect.mapError(() => new Error("the reader answered where it was expected to refuse")),
    Effect.orDie,
  );

/** The same, against the reader every test but the last one uses. */
const refusalOf = <A>(
  program: Effect.Effect<A, ArtifactUnavailable, ArtifactReader>,
): Effect.Effect<ArtifactUnavailable> => refused(asking(program));

describe("what the reader serves", () => {
  it.effect("hands back each artifact with what it is", () =>
    asking(
      Effect.gen(function* () {
        const artifacts = yield* ArtifactReader;

        const prompt = yield* artifacts.prompt({ runId, phaseId });
        expect(prompt.kind).toBe("prompt");
        expect(prompt.content).toContain("Answer with one JSON object");
        // The kind travels with the content because whatever receives this has to label it: an HTTP
        // response needs a content type, and a panel needs to know what it is rendering.
        expect(prompt.mediaType).toBe("text/markdown; charset=utf-8");

        const session = yield* artifacts.session({ runId, phaseId });
        expect(session.mediaType).toBe("application/x-ndjson; charset=utf-8");
        expect(session.content.split("\n")).toHaveLength(3);

        const diff = yield* artifacts.diff({ runId, phaseId, commits: ["c0ffee"] });
        expect(diff.mediaType).toBe("text/x-diff; charset=utf-8");
        expect(diff.content).toContain("diff --git");
      }),
    ),
  );
});

describe("when an artifact is not there", () => {
  it.effect("says absent, which is an answer and not a fault", () =>
    Effect.gen(function* () {
      const missing = yield* refusalOf(
        Effect.flatMap(ArtifactReader, (artifacts) =>
          artifacts.session({ runId, phaseId: makePhaseId(runId, "bare", 1) }),
        ),
      );

      // `absent` rather than `unreadable`: nothing failed. console.md's rule is that one missing
      // artifact never fails the whole panel, and the refusal is what carries that distinction.
      expect(missing.refusal).toBe("absent");
      expect(missing.kind).toBe("session");
    }),
  );

  it.effect("says absent for a phase that committed nothing", () =>
    Effect.gen(function* () {
      const missing = yield* refusalOf(
        Effect.flatMap(ArtifactReader, (artifacts) =>
          artifacts.diff({ runId, phaseId, commits: [] }),
        ),
      );

      // A phase that committed nothing has no diff in git either. The record still lists the paths
      // it changed, so the panel says the content is not there rather than that the phase is broken.
      expect(missing.refusal).toBe("absent");
      expect(missing.reason).toBe("the phase produced no commit");
    }),
  );
});

describe("the identifier guard", () => {
  it.effect("refuses a traversal in either identifier, before looking for anything", () =>
    Effect.gen(function* () {
      const byPhase = yield* refusalOf(
        Effect.flatMap(ArtifactReader, (artifacts) =>
          artifacts.prompt({ runId, phaseId: "../../etc/passwd" as typeof phaseId }),
        ),
      );
      expect(byPhase.refusal).toBe("refused");

      const byRun = yield* refusalOf(
        Effect.flatMap(ArtifactReader, (artifacts) =>
          artifacts.session({ runId: ".." as RunId, phaseId }),
        ),
      );
      expect(byRun.refusal).toBe("refused");

      // The guard runs on the diff too, and it runs *before* the commit list is looked at — a
      // refused identifier must not be reported as an empty commit list.
      const onDiff = yield* refusalOf(
        Effect.flatMap(ArtifactReader, (artifacts) =>
          artifacts.diff({ runId, phaseId: "a4f0/../../x" as typeof phaseId, commits: [] }),
        ),
      );
      expect(onDiff.refusal).toBe("refused");
    }),
  );

  it.effect("refuses even when the fixture holds an artifact under that key", () =>
    Effect.gen(function* () {
      // The fake applies the same guard the real adapter does, on purpose: the browser tier runs
      // against this, and a fake that answered a traversal with content would let the Console ship
      // a route nobody had ever seen refuse anything.
      const seeded = InMemoryArtifactReader.of({ "../../etc/passwd": { prompt: "secrets" } });
      const traversal = yield* refused(
        Effect.flatMap(ArtifactReader, (artifacts) =>
          artifacts.prompt({ runId, phaseId: "../../etc/passwd" as typeof phaseId }),
        ).pipe(Effect.provide(seeded)),
      );

      expect(traversal.refusal).toBe("refused");
    }),
  );
});
