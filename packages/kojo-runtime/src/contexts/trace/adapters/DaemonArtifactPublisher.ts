import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CHUNK_BYTES,
} from "@carere/kojo-runner-contracts/contexts/project/contracts/artifact";
import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Context, Data, Effect, Layer } from "effect";
import { ArtifactPublisher } from "../ports/ArtifactPublisher.ts";

export type SendArtifactMutation = (
  kind: "BeginArtifact" | "WriteArtifactChunk" | "FinishArtifact",
  body: JsonValue,
) => Promise<Record<string, JsonValue>>;

class ArtifactMutationError extends Data.TaggedError("ArtifactMutationError")<{
  readonly cause: unknown;
}> {}

const send = (
  mutate: SendArtifactMutation,
  kind: Parameters<SendArtifactMutation>[0],
  body: JsonValue,
) =>
  Effect.tryPromise({
    try: () => mutate(kind, body),
    catch: (cause) => new ArtifactMutationError({ cause }),
  }).pipe(Effect.orDie);

export const layer = (mutate: SendArtifactMutation): Layer.Layer<never> =>
  Layer.succeedContext(
    Context.make(ArtifactPublisher, {
      publishText: (input) =>
        Effect.gen(function* () {
          const bytes = new TextEncoder().encode(input.content);
          if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
            return yield* Effect.die(
              new Error(`Artifact content exceeds ${MAX_ARTIFACT_BYTES} bytes`),
            );
          }
          const transferId = crypto.randomUUID();
          const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
          yield* send(mutate, "BeginArtifact", {
            artifactVersion: 1,
            transferId,
            name: input.name,
            mediaType: input.mediaType,
            totalSize: bytes.byteLength,
            sha256,
          });
          let ordinal = 0;
          for (let offset = 0; offset < bytes.byteLength; offset += MAX_ARTIFACT_CHUNK_BYTES) {
            const chunk = bytes.slice(offset, offset + MAX_ARTIFACT_CHUNK_BYTES);
            yield* send(mutate, "WriteArtifactChunk", {
              artifactChunkVersion: 1,
              transferId,
              ordinal,
              totalSize: bytes.byteLength,
              sha256,
              data: chunk.toBase64(),
            });
            ordinal += 1;
          }
          const finished = yield* send(mutate, "FinishArtifact", {
            artifactVersion: 1,
            transferId,
          });
          return { artifactId: String(finished.artifactId) };
        }),
    }),
  );
