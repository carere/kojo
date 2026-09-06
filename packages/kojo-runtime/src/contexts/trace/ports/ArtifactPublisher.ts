import { Context, type Effect } from "effect";

interface ArtifactPublisherService {
  readonly publishText: (input: {
    readonly name: string;
    readonly mediaType: string;
    readonly content: string;
  }) => Effect.Effect<{ readonly artifactId: string }>;
}

const ArtifactPublisherBase: Context.ServiceClass<
  ArtifactPublisher,
  "kojo/trace/ArtifactPublisher",
  ArtifactPublisherService
> = Context.Service<ArtifactPublisher, ArtifactPublisherService>()("kojo/trace/ArtifactPublisher");

/**
 * Publishes bounded retained Artifact content through the private Runner channel.
 *
 * Execution has no default. A Project Runner needs the private Daemon publication channel.
 */
export class ArtifactPublisher extends ArtifactPublisherBase {}
