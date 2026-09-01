import { Context, Effect } from "effect";

export interface ArtifactPublisher {
  readonly publishText: (input: {
    readonly name: string;
    readonly mediaType: string;
    readonly content: string;
  }) => Effect.Effect<{ readonly artifactId: string }>;
}

/**
 * Publishes bounded retained Artifact content through the private Runner channel.
 *
 * The default keeps the retired single-process CLI compatible. A Daemon Project Runner replaces
 * it with atomic retained publication before it executes authored work.
 */
export const ArtifactPublisher = Context.Reference<ArtifactPublisher>(
  "kojo/trace/ArtifactPublisher",
  {
    defaultValue: () => ({
      publishText: () => Effect.succeed({ artifactId: crypto.randomUUID() }),
    }),
  },
);
