import { Effect, Layer, Option } from "effect";
import { safeSegments } from "../guards/identifiers.ts";
import { Artifact, type ArtifactKind } from "../models/Artifact.ts";
import { ArtifactUnavailable } from "../models/ArtifactUnavailable.ts";
import { ArtifactReader, type ArtifactSubject } from "../ports/ArtifactReader.ts";

/**
 * The artifacts of one phase, as a test states them. Anything left out is absent.
 *
 * Absent rather than empty, and the difference is what the Console shows: a phase with no captured
 * session says *there is no transcript*, while a phase with an empty one says the transcript is
 * empty. A fixture that could not express the first could not exercise the state console.md
 * requires the panel to survive.
 */
export interface PhaseArtifacts {
  readonly prompt?: string | undefined;
  readonly session?: string | undefined;
  readonly diff?: string | undefined;
}

/**
 * The artifacts of a whole trace, keyed by phase id.
 *
 * Keyed by the phase alone because a phase id already carries its run — `makePhaseId` builds it
 * from one — so a second level keyed by run could only ever disagree with the first.
 */
export type Artifacts = Record<string, PhaseArtifacts>;

const unavailable = (
  kind: ArtifactKind,
  subject: ArtifactSubject,
  refusal: "refused" | "absent",
  reason: string,
): ArtifactUnavailable =>
  new ArtifactUnavailable({ kind, subject: subject.phaseId, refusal, reason });

/**
 * **The same identifier guard the real adapter applies**, applied here too.
 *
 * Deliberate, and not defensive programming for its own sake. The guard is a promise the port
 * makes, and the browser tier runs against this adapter — so a fake that answered a traversal
 * attempt with content would let a Console ship a route nobody had ever seen refuse anything.
 */
const guard = (
  kind: ArtifactKind,
  subject: ArtifactSubject,
): Effect.Effect<void, ArtifactUnavailable> => {
  if (Option.isNone(safeSegments(subject.runId))) {
    return Effect.fail(
      unavailable(kind, subject, "refused", `the run id ${subject.runId} is not a safe path`),
    );
  }
  if (Option.isNone(safeSegments(subject.phaseId))) {
    return Effect.fail(
      unavailable(kind, subject, "refused", `the phase id ${subject.phaseId} is not a safe path`),
    );
  }
  return Effect.void;
};

const service = (artifacts: Artifacts): ArtifactReader["Service"] => {
  const served = (
    kind: ArtifactKind,
    subject: ArtifactSubject,
    pick: (held: PhaseArtifacts) => string | undefined,
  ): Effect.Effect<Artifact, ArtifactUnavailable> =>
    Effect.flatMap(guard(kind, subject), () => {
      const content = pick(artifacts[subject.phaseId] ?? {});
      return content === undefined
        ? Effect.fail(
            unavailable(kind, subject, "absent", `no ${kind} was kept for ${subject.phaseId}`),
          )
        : Effect.succeed(new Artifact({ kind, content }));
    });

  return {
    prompt: (subject) => served("prompt", subject, (held) => held.prompt),
    session: (subject) => served("session", subject, (held) => held.session),
    diff: (subject) =>
      Effect.flatMap(guard("diff", subject), () =>
        // A phase that committed nothing has no diff in git either, so a fixture cannot be given one
        // by accident. It is `absent` and not a fault: the record still lists what the phase changed.
        subject.commits.length === 0
          ? Effect.fail(unavailable("diff", subject, "absent", "the phase produced no commit"))
          : served("diff", subject, (held) => held.diff),
      ),
  };
};

/** Artifacts with no filesystem and no git — what lets the Console's browser tier run with neither. */
export const of = (artifacts: Artifacts): Layer.Layer<ArtifactReader> =>
  Layer.succeed(ArtifactReader, service(artifacts));
