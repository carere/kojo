import { type JSX, splitProps } from "solid-js";
import { cn } from "../lib/cn.ts";

/** Show an empty or retry state where its data would appear. */
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
