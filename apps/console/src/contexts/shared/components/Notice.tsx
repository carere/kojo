import { type JSX, splitProps } from "solid-js";
import { cn } from "../lib/cn.ts";

/**
 * A statement about the world, put where the data would have been.
 *
 * console.md §10 is emphatic that none of the Console's broken states is an error page: a repository
 * with no factory, a factory with no runs, and an API that cannot be reached are all ordinary
 * conditions with something useful to say. This component exists so that saying them is the cheap
 * option and throwing an error page is the one nobody reaches for.
 *
 * `role` follows the tone. A `retrying` notice appears while a person is already looking at the
 * table, so it is a live region; the other two replace the table and are read in place.
 */
export type NoticeTone = "empty" | "retrying";

const tones: Record<NoticeTone, string> = {
  empty: "border-border bg-muted/40 text-foreground",
  retrying: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
};

export const Notice = (props: {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly children?: JSX.Element;
  readonly class?: string;
}): JSX.Element => {
  const [local] = splitProps(props, ["tone", "title", "children", "class"]);
  return (
    <div
      data-notice={local.tone}
      role={local.tone === "retrying" ? "status" : "note"}
      class={cn("rounded-lg border px-4 py-3 text-sm", tones[local.tone], local.class)}
    >
      <p class="font-medium">{local.title}</p>
      {local.children}
    </div>
  );
};
