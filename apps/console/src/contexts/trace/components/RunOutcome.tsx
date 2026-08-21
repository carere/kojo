import { Link } from "@tanstack/solid-router";
import { For, type JSX, Show } from "solid-js";
import { Badge } from "../../shared/components/Badge.tsx";
import type { RunDoc } from "../models/RunDoc.ts";
import type { RunViewMode } from "../models/view.ts";

/**
 * Why this run died, said once, at the top, at a size a person can read.
 *
 * **The Console could not answer its own second question.** A person opens a run to learn what
 * happened; for a failed run the only statement of the cause anywhere on the page was the error tag
 * printed inside the failing span — measured at nine pixels, at 0.9 opacity, clipped by the width of
 * the span it sits in, which for a short phase is two pixels. The header said `failed` and never
 * said what of. Reading the cause meant finding the red bar, guessing it was the right one, and
 * clicking it.
 *
 * A breach outranks the error tag and gets its own line. A failed check is a run that did not do its
 * work; a breach is a run that wrote somewhere it had no permission to write, so the repository may
 * still be holding something. Those are not the same news and must not be drawn as though they are.
 *
 * It carries `data-run-outcome` rather than reusing the gate card's attribute, because the browser
 * tier asserts that a failed run with no gate has no gate card, and this component renders on
 * exactly that run.
 */
export const RunOutcome = (props: {
  readonly doc: RunDoc;
  readonly runId: string;
  readonly mode: RunViewMode;
}): JSX.Element => {
  /** The failing phases, newest attempt first — a retried phase fails at its last attempt. */
  const failed = () =>
    props.doc.phases
      .filter((phase) => phase.outcome === "failed")
      .sort((left, right) => right.endedAt - left.endedAt);

  /** Every breach in the run, whatever phase it happened in. A breach is never only local news. */
  const breached = () => props.doc.phases.filter((phase) => (phase.breaches ?? []).length > 0);

  return (
    <Show when={failed().length > 0 || breached().length > 0}>
      <section
        data-run-outcome={props.doc.run.outcome ?? "executing"}
        // The same red the `danger` badge uses. `danger` is a tone name in this codebase, not a
        // Tailwind colour, so `border-danger` would resolve to nothing and draw an unstyled box.
        class="flex flex-col gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3"
      >
        <For each={breached()}>
          {(phase) => (
            <p data-outcome-breach={phase.name} class="text-sm">
              <Badge tone="danger">permission breach</Badge>{" "}
              <span class="font-medium">{phase.name}</span> wrote{" "}
              {(phase.breaches ?? []).length === 1
                ? "a path"
                : `${(phase.breaches ?? []).length} paths`}{" "}
              it was not allowed to. The repository may still hold the change.
            </p>
          )}
        </For>

        <Show when={failed()[0]}>
          {(phase) => (
            <p data-outcome-failure={phase().name} class="text-sm">
              <Show when={phase().errorTag} fallback={<Badge tone="danger">failed</Badge>}>
                {(tag) => <Badge tone="danger">{tag()}</Badge>}
              </Show>{" "}
              in{" "}
              <Link
                to="/runs/$runId/phases/$name/$attempt"
                params={{
                  runId: props.runId,
                  name: phase().name,
                  attempt: String(phase().attempt),
                }}
                search={{ view: props.mode }}
                data-outcome-link={phase().name}
                class="font-medium underline underline-offset-2"
              >
                {phase().name}
              </Link>
              <Show when={phase().attempt > 1}>
                {" "}
                <span class="text-muted-foreground">
                  after {phase().attempt - 1}{" "}
                  {phase().attempt - 1 === 1 ? "correction" : "corrections"}
                </span>
              </Show>
              <Show when={failed().length > 1}>
                {" "}
                <span class="text-muted-foreground">
                  · {failed().length - 1} more {failed().length - 1 === 1 ? "phase" : "phases"}{" "}
                  failed
                </span>
              </Show>
            </p>
          )}
        </Show>
      </section>
    </Show>
  );
};
