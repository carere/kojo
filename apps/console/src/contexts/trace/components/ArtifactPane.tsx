import { createSignal, type JSX, Show } from "solid-js";
import { Pane } from "../../shared/components/Pane.tsx";
import { refusal, settled } from "../../shared/hooks/settled.ts";
import { type ArtifactKind, useArtifact } from "../hooks/useArtifact.ts";

/**
 * One of the three things the trace does not store, fetched when somebody asks for it.
 *
 * **A missing artifact degrades this pane and nothing else** — console.md §10 says so about the diff
 * of a deleted branch, and the rule is the same for all three. The panel around this is built from
 * the phase record, which is already in hand; nothing here can fail in a way that takes the record
 * off the screen. So every refusal is rendered as a sentence inside this box:
 *
 * - **`no-such-artifact`** — the phase kept none. A diff is absent when the phase committed nothing,
 *   and absent when git can no longer produce it; the server's own reason says which, and repeating
 *   it is more honest than guessing at a cause the Console cannot see.
 * - **`artifact-unreadable`** — the artifact root or `git` could not be read. A fault, said plainly.
 * - **`no-such-phase`** — the phase has not exited yet. The panel does not offer the button in that
 *   case, so this is only reachable if a phase exits between the render and the click.
 *
 * The pane is closed until it is opened, which is what *on demand* means: opening the prompt never
 * fetches the transcript, and clicking through five spans costs five requests for the run document
 * that is already cached and none at all for artifacts nobody looked at.
 */
export const ArtifactPane = (props: {
  readonly runId: string;
  readonly phaseId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  /** What this artifact is for, in one line — a pane nobody opens still has to say what is in it. */
  readonly about: string;
  /** False while the phase is still running: there is no record yet, so there is nothing to fetch. */
  readonly available: boolean;
}): JSX.Element => {
  const [wanted, want] = createSignal(false);
  const artifact = useArtifact({
    runId: () => props.runId,
    phaseId: () => props.phaseId,
    kind: props.kind,
    wanted,
  });

  return (
    <Pane name={props.kind} title={props.title}>
      <p class="text-muted-foreground text-[11px]">{props.about}</p>

      <Show
        when={props.available}
        fallback={
          <p data-artifact={props.kind} data-artifact-state="not-yet" class="text-xs italic">
            This phase has not exited. Its prompt, transcript and diff are readable once the record
            is written.
          </p>
        }
      >
        <Show
          when={wanted()}
          fallback={
            <button
              type="button"
              data-artifact={props.kind}
              data-artifact-state="unasked"
              class="border-border hover:bg-muted self-start rounded-md border px-2 py-1 text-xs"
              onClick={() => want(true)}
            >
              Fetch the {props.kind}
            </button>
          }
        >
          <Show
            when={refusal(artifact)}
            fallback={
              <Show
                // Asked against `undefined` rather than for truthiness, because an artifact that
                // exists and is empty is its own state: a phase with **no** captured session and one
                // whose session is empty are different facts, and a falsy test would render the
                // second as *still fetching*, for ever.
                when={settled(artifact) !== undefined}
                fallback={
                  <p data-artifact={props.kind} data-artifact-state="loading" class="text-xs">
                    Fetching…
                  </p>
                }
              >
                <Show
                  when={settled(artifact) !== ""}
                  fallback={
                    <p
                      data-artifact={props.kind}
                      data-artifact-state="empty"
                      class="text-muted-foreground text-xs italic"
                    >
                      This phase kept a {props.kind}, and it is empty.
                    </p>
                  }
                >
                  <pre
                    data-artifact={props.kind}
                    data-artifact-state="present"
                    class="bg-muted/40 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap"
                  >
                    {settled(artifact)}
                  </pre>
                </Show>
              </Show>
            }
          >
            {(error) => (
              <p
                data-artifact={props.kind}
                data-artifact-state="absent"
                data-artifact-code={error().code}
                class="text-muted-foreground text-xs"
              >
                {error().message}
              </p>
            )}
          </Show>
        </Show>
      </Show>
    </Pane>
  );
};
