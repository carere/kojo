import { Context, type Effect } from "effect";

/**
 * Publishes bounded retained Artifact content through the private Runner channel.
 *
 * Execution has no default. A Project Runner needs the private Daemon publication channel.
 */
export class ArtifactPublisher extends Context.Service<
  ArtifactPublisher,
  {
    readonly publishText: (input: {
      readonly name: string;
      readonly mediaType: string;
      readonly content: string;
    }) => Effect.Effect<{ readonly artifactId: string }>;
  }
>()("kojo/trace/ArtifactPublisher") {}
