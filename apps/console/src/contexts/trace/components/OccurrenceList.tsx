import { For, type JSX, Show } from "solid-js";
import { Badge } from "../../shared/components/Badge.tsx";
import { Pane } from "../../shared/components/Pane.tsx";
import { axisDuration } from "../../shared/lib/duration.ts";
import type { OccurrenceLine } from "../models/OccurrenceDoc.ts";

/**
 * What the agent did inside one phase — its tool calls, its `exec` invocations, its iterations.
 *
 * **They live here and only here.** console.md §5 keeps the waterfall phase-grained: a corrected
 * phase is one span and a phase that ran four hundred tool calls is one span, because the timeline
 * answers *what happened to this run* and not *what happened inside this phase*. Putting occurrences
 * on it would turn a run's history into an event log with a time axis, which is the shape the whole
 * trace design exists to avoid.
 *
 * The heading says which of the two states this is in, because they are genuinely different: a phase
 * in flight is being streamed and the list will grow while somebody watches it, and a phase that has
 * exited is a list that is complete. A reader who cannot tell the two apart cannot tell a phase that
 * made two tool calls from one whose third has not arrived yet.
 */
export const OccurrenceList = (props: {
  readonly occurrences: ReadonlyArray<OccurrenceLine>;
  /** Whether the phase is the one the run is inside right now. */
  readonly live: boolean;
}): JSX.Element => (
  <Pane
    name="occurrences"
    title={props.live ? "Agent activity — live" : "Agent activity"}
    class="gap-1"
  >
    <Show
      when={props.occurrences.length > 0}
      fallback={
        <p data-occurrences="none" class="text-muted-foreground text-xs italic">
          {props.live
            ? "The agent has not recorded a tool call or command yet."
            : "The agent recorded no tool call and ran no command."}
        </p>
      }
    >
      <ol data-occurrences={props.live ? "streaming" : "listed"} class="flex flex-col">
        <For each={props.occurrences}>
          {(occurrence) => (
            <li
              data-occurrence={occurrence.kind}
              data-occurrence-outcome={occurrence.outcome}
              class="border-border/60 flex flex-col gap-0.5 border-b py-1 last:border-0"
            >
              <div class="flex items-center gap-2">
                <Badge tone={occurrence.outcome === "failed" ? "danger" : "neutral"}>
                  {occurrence.kind}
                </Badge>
                <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{occurrence.name}</span>
                <span class="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                  {axisDuration(occurrence.endedAt - occurrence.startedAt)}
                </span>
              </div>
              {/*
               * The detail is the only line an occurrence carries about how it ended, and it is
               * usually the reason the phase above it died. It is never truncated away.
               */}
              <Show when={occurrence.detail}>
                {(detail) => (
                  <span data-occurrence-detail class="text-muted-foreground text-[10px]">
                    {detail()}
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ol>
    </Show>
  </Pane>
);
