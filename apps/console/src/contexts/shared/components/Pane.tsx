import { type JSX, Show } from "solid-js";
import { cn } from "../lib/cn.ts";

/**
 * The two shapes the detail panel is made of: a titled block, and a labelled fact inside it.
 *
 * Both carry what they are as a data attribute rather than only as text, on the rule the waterfall
 * already follows: the element carries the fact and the class carries the look, so the browser tier
 * grades *which* facts a panel shows without grading a heading's wording or a colour.
 */

export const Pane = (props: {
  /** What this block is — `identity`, `agent`, `verdict`, `repo`, `where`, `prompt`, … */
  readonly name: string;
  readonly title: string;
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element => (
  <section data-pane={props.name} class={cn("flex flex-col gap-2", props.class)}>
    <h3 class="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
      {props.title}
    </h3>
    {props.children}
  </section>
);

/**
 * One labelled fact.
 *
 * `absent` is a first-class state and not an empty string: a record that does not carry a value is
 * saying something — no agent ran, no digest was resolved, no occupancy was reported — and a blank
 * would read as a value the Console failed to load. Every absence on this surface is written out.
 */
export const Field = (props: {
  readonly name: string;
  readonly label: string;
  readonly children?: JSX.Element;
  /** What to say when there is nothing. Drawn in the muted tone, never as a blank. */
  readonly absent?: string;
  readonly when?: boolean;
}): JSX.Element => (
  <div data-field={props.name} class="flex flex-col gap-0.5">
    <span class="text-muted-foreground text-[10px] tracking-wide uppercase">{props.label}</span>
    <Show
      when={props.when ?? true}
      fallback={<span class="text-muted-foreground text-xs italic">{props.absent ?? "—"}</span>}
    >
      <span class="font-mono text-xs break-all">{props.children}</span>
    </Show>
  </div>
);
