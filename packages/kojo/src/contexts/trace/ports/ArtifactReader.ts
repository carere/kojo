import { Context, type Effect } from "effect";
import type { PhaseId } from "../../shared/models/PhaseId.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { Artifact } from "../models/Artifact.ts";
import type { ArtifactUnavailable } from "../models/ArtifactUnavailable.ts";

/** Which phase of which run an artifact is wanted for. Both are guarded before either is used. */
export interface ArtifactSubject {
  readonly runId: RunId;
  readonly phaseId: PhaseId;
}

/**
 * The three things the trace deliberately does not store, fetched on demand.
 *
 * **A separate port from `TraceReader`, for two reasons that both matter.** It touches the
 * filesystem and git rather than the database, so an adapter for it shares nothing with one for the
 * trace; and its failures are survivable in a way a missing trace record is not — a phase whose
 * branch was deleted still has its record, and the panel that lost the diff must keep everything
 * else on screen. Two ports is what lets a caller catch one and not the other.
 *
 * Every method is one shot. There is no cursor and no stream: a phase is immutable once it has
 * exited, so its artifacts are cacheable forever and a second read would return the same bytes.
 */
export class ArtifactReader extends Context.Service<
  ArtifactReader,
  {
    /** The rendered prompt, system and user, as the agent received it. */
    readonly prompt: (subject: ArtifactSubject) => Effect.Effect<Artifact, ArtifactUnavailable>;
    /** The captured transcript — what makes a correction count auditable rather than a number. */
    readonly session: (subject: ArtifactSubject) => Effect.Effect<Artifact, ArtifactUnavailable>;
    /**
     * The content of what the phase committed, read from git on demand.
     *
     * **The commits are passed in rather than looked up, and that is the seam between the two
     * ports.** They are on the phase record, the caller has already read that record to draw the
     * panel, and a reader that fetched it again would make this port depend on the trace — which is
     * exactly the coupling that stops the Console's browser tier running with no database.
     *
     * A phase that committed nothing has no diff in git. That is `absent`, not a failure: the
     * record still lists the paths it changed, and the panel says the content is not there.
     */
    readonly diff: (
      subject: ArtifactSubject & {
        /** What the phase committed, as `PhaseRecord.repo.commits` holds them. */
        readonly commits: ReadonlyArray<string>;
      },
    ) => Effect.Effect<Artifact, ArtifactUnavailable>;
  }
>()("kojo/trace/ArtifactReader") {}
