import { createEffect, For, type JSX, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { PhaseLine } from "../models/RunDoc.ts";
import { publicHttpUrl } from "../utils/publicHttpUrl.ts";

const resultValue = (phase: PhaseLine): unknown => {
  const result = phase.result as {
    readonly _tag?: unknown;
    readonly exit?: { readonly _tag?: unknown; readonly value?: unknown; readonly cause?: unknown };
  } | null;
  return result?._tag === "Complete"
    ? result.exit?._tag === "Success"
      ? result.exit.value
      : result.exit?.cause
    : phase.result;
};

/** Keep returned checks, review findings, commits, and delivery links together on the Run. */
export const PhaseResults = (props: { readonly phases: ReadonlyArray<PhaseLine> }): JSX.Element => {
  const [phases, setPhases] = createStore<Array<PhaseLine>>([]);
  createEffect(() => setPhases(reconcile([...props.phases], { key: "phaseId" })));
  const results = () =>
    phases.filter(
      (phase) =>
        phase.result !== undefined &&
        resultValue(phase) !== null &&
        resultValue(phase) !== undefined,
    );
  return (
    <Show when={results().length > 0}>
      <section class="grid gap-2" aria-label="Results and checks">
        <h2 class="text-base font-semibold">Results and checks</h2>
        <For each={results()}>
          {(phase) => {
            const value = () => resultValue(phase);
            const url = () =>
              typeof value() === "string" ? publicHttpUrl(String(value()).trim()) : undefined;
            return (
              <details class="rounded-lg border border-border p-3">
                <summary class="cursor-pointer break-words text-sm">
                  <span class="font-medium">{phase.description}</span> · {phase.name} ·{" "}
                  {phase.outcome === "succeeded" ? "result recorded" : phase.outcome}
                </summary>
                <Show
                  when={url()}
                  fallback={
                    <pre class="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {typeof value() === "string"
                        ? String(value())
                        : JSON.stringify(value(), null, 2)}
                    </pre>
                  }
                >
                  {(href) => (
                    <a
                      href={href()}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="mt-3 block break-all text-sm underline"
                    >
                      {href()}
                    </a>
                  )}
                </Show>
              </details>
            );
          }}
        </For>
      </section>
    </Show>
  );
};
