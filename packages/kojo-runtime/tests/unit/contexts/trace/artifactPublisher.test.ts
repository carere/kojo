import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as DaemonArtifactPublisher from "../../../../src/contexts/trace/adapters/DaemonArtifactPublisher.ts";
import { ArtifactPublisher } from "../../../../src/contexts/trace/ports/ArtifactPublisher.ts";

describe("Daemon Artifact publication", () => {
  it("scopes identical content transfer identities to the Run", async () => {
    const transferIds: string[] = [];
    const publish = (runId: string) =>
      Effect.gen(function* () {
        const publisher = yield* ArtifactPublisher;
        return yield* publisher.publishText({
          name: "same.txt",
          mediaType: "text/plain",
          content: "same content\n",
        });
      }).pipe(
        Effect.provide(
          DaemonArtifactPublisher.layer(runId, async (kind, body) => {
            const transferId = String((body as Record<string, JsonValue>).transferId);
            if (kind === "BeginArtifact") transferIds.push(transferId);
            return kind === "FinishArtifact"
              ? { artifactId: `published_${transferId}` }
              : { transferId };
          }),
        ),
      );

    await Effect.runPromise(Effect.all([publish("run-a"), publish("run-b")]));

    expect(transferIds).toHaveLength(2);
    expect(new Set(transferIds).size).toBe(2);
  });

  it("retries the same stable transfer after chunk and finish replies are lost", async () => {
    const calls: Array<{ readonly kind: string; readonly body: JsonValue }> = [];
    const chunks = new Set<string>();
    const finished = new Set<string>();
    let droppedChunk = false;
    let droppedFinish = false;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const publisher = yield* ArtifactPublisher;
        return yield* publisher.publishText({
          name: "controlled.txt",
          mediaType: "text/plain; charset=utf-8",
          content: "controlled Artifact\n",
        });
      }).pipe(
        Effect.provide(
          DaemonArtifactPublisher.layer("run-controlled", async (kind, body) => {
            calls.push({ kind, body });
            const record = body as Record<string, JsonValue>;
            const transferId = String(record.transferId);
            if (kind === "WriteArtifactChunk") {
              chunks.add(`${transferId}:${String(record.ordinal)}`);
              if (!droppedChunk) {
                droppedChunk = true;
                throw new Error("the committed chunk reply was lost");
              }
              return { transferId, written: true };
            }
            if (kind === "FinishArtifact") {
              finished.add(transferId);
              if (!droppedFinish) {
                droppedFinish = true;
                throw new Error("the committed finish reply was lost");
              }
              return { artifactId: `published_${transferId}` };
            }
            return { transferId };
          }),
        ),
      ),
    );

    const transferIds = new Set(
      calls.map((call) => String((call.body as Record<string, JsonValue>).transferId)),
    );
    expect([...transferIds]).toEqual([expect.stringMatching(/^artifact_[a-f0-9]{64}$/)]);
    expect(calls.filter((call) => call.kind === "WriteArtifactChunk")).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "FinishArtifact")).toHaveLength(2);
    expect(chunks).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(result.artifactId).toMatch(/^published_artifact_/);
  });
});
