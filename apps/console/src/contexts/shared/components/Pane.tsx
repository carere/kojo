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
  /*
   * A rule and a title, not a title alone.
   *
   * Every block in the panel used to be an uppercase line at 11 px followed by more small text, and
   * a reader had no way to see where one section stopped and the next began — the heading was the
   * same weight and nearly the same size as the facts under it. A hairline across the top is what
   * separates them, and it costs one pixel of the space the panel now has plenty of.
   */
  <section
    data-pane={props.name}
    class={cn(
      "border-border/60 flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0",
      props.class,
    )}
  >
    <h3 class="text-foreground/70 text-[11px] font-semibold tracking-[0.08em] uppercase">
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
  /*
   * The label and the value must not look alike, and they did.
   *
   * A 10-px uppercase label above a 12-px monospace value is two lines of small grey text, and a
   * reader scanning a panel of twenty facts cannot tell which half is the question and which is the
   * answer. The value is bigger now, in the full foreground colour; the label stays small, muted and
   * uppercase and does not compete with it.
   *
   * `break-words` rather than `break-all`: a long branch name should wrap at a word, and only a
   * value with no spaces in it — a digest, a session id — is broken mid-token.
   */
  <div data-field={props.name} class="flex min-w-0 flex-col gap-1">
    <span class="text-muted-foreground text-[10px] font-medium tracking-[0.08em] uppercase">
      {props.label}
    </span>
    <Show
      when={props.when ?? true}
      fallback={<span class="text-muted-foreground/70 text-sm italic">{props.absent ?? "—"}</span>}
    >
      <span class="text-foreground font-mono text-sm break-words">{props.children}</span>
    </Show>
  </div>
);
