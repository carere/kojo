import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import {
  downloadPublishedArtifact,
  readPublishedArtifact,
} from "../../daemon/services/browserAccess.ts";
import { Pane } from "../../shared/components/Pane.tsx";

interface ArtifactLine {
  readonly artifactId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

/** Escaped Artifact text and an explicit authenticated download action. */
export const PublishedArtifacts = (props: {
  readonly runId: string;
  readonly artifacts: ReadonlyArray<ArtifactLine>;
}): JSX.Element => {
  const [selected, select] = createSignal<string>();
  const [content] = createResource(selected, (artifactId) =>
    readPublishedArtifact(props.runId, artifactId),
  );

  return (
    <Show when={props.artifacts.length > 0}>
      <Pane name="published-artifacts" title="Captured Artifacts">
        <div class="flex flex-col gap-2">
          <For each={props.artifacts}>
            {(artifact) => (
              <div class="border-border flex flex-wrap items-center gap-2 rounded-md border p-2">
                <span class="font-mono text-xs">{artifact.name}</span>
                <span class="text-muted-foreground text-[11px]">{artifact.size} bytes</span>
                <button
                  type="button"
                  class="border-border hover:bg-muted rounded-md border px-2 py-1 text-xs"
                  data-published-artifact-display={artifact.artifactId}
                  onClick={() => select(artifact.artifactId)}
                >
                  Display as text
                </button>
                <button
                  type="button"
                  class="border-border hover:bg-muted rounded-md border px-2 py-1 text-xs"
                  data-published-artifact-download={artifact.artifactId}
                  onClick={() =>
                    downloadPublishedArtifact(props.runId, artifact.artifactId, artifact.name)
                  }
                >
                  Download
                </button>
              </div>
            )}
          </For>
          <Show when={content()}>
            {(artifact) => (
              <pre
                data-published-artifact-content={artifact().artifactId}
                class="bg-muted/40 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap"
              >
                {artifact().content}
              </pre>
            )}
          </Show>
        </div>
      </Pane>
    </Show>
  );
};
