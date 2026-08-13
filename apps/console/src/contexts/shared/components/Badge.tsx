import { type ComponentProps, type JSX, splitProps } from "solid-js";
import { cn } from "../lib/cn.ts";

/**
 * The tones a badge can take. Named after what they mean, never after the colour they happen to be.
 *
 * A `danger` badge stays `danger` when somebody re-themes the Console, and a reader of a component
 * never has to hold "red means failed" in their head to know what a row is saying.
 */
export type BadgeTone = "neutral" | "running" | "waiting" | "good" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  danger: "bg-red-500/15 text-red-700 dark:text-red-300",
};

/** A short, coloured statement of fact — a run's status, a gate that has gone overdue. */
export const Badge = (
  props: ComponentProps<"span"> & { readonly tone: BadgeTone },
): JSX.Element => {
  const [local, rest] = splitProps(props, ["class", "tone"]);
  return (
    <span
      class={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        tones[local.tone],
        local.class,
      )}
      {...rest}
    />
  );
};
