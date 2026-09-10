import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { createEffect, For, type JSX, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Badge } from "../../shared/components/Badge.tsx";
import { isTerminal, type RunStatus } from "../models/RunLine.ts";
import { publicHttpUrl } from "../utils/publicHttpUrl.ts";

type Item = NonNullable<RunDocument["progress"]>[number];

const label = (item: Item, run: RunStatus): string => {
  if ((item.state === "executing" || item.state === "integrating") && run !== "executing")
    return "Execution stopped";
  if (item.state === "waiting" && isTerminal(run)) return "Not completed";
  return item.state === "waiting" ? `Waiting for ${item.waitingFor ?? "progress"}` : item.state;
};

/** Show supplied work observations without making them execution or cleanup authority. */
export const WorkProgress = (props: {
  readonly items: ReadonlyArray<Item>;
  readonly state: RunStatus;
}): JSX.Element => {
  const [items, setItems] = createStore<Array<Item>>([]);
  createEffect(() => setItems(reconcile([...props.items], { key: "key" })));
  return (
    <section class="grid gap-3" aria-label="Work progress">
      <h2 class="text-base font-semibold">Work progress</h2>
      <p class="text-sm text-muted-foreground">Last recorded progress from the Workflow.</p>
      <div class="grid gap-3 md:grid-cols-2">
        <For each={items}>
          {(item) => (
            <article class="grid content-start gap-2 rounded-lg border border-border p-4">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <h3 class="min-w-0 break-words font-medium">
                  <Show when={publicHttpUrl(item.url)} fallback={item.title}>
                    {(url) => (
                      <a class="underline" href={url()} target="_blank" rel="noopener noreferrer">
                        {item.title}
                      </a>
                    )}
                  </Show>
                </h3>
                <Badge
                  tone={
                    item.state === "failed"
                      ? "danger"
                      : ["accepted", "integrated"].includes(item.state)
                        ? "good"
                        : "neutral"
                  }
                >
                  {label(item, props.state)}
                </Badge>
              </div>
              <p class="whitespace-pre-wrap break-words text-sm">{item.detail}</p>
              <Show when={item.dependencies.length > 0}>
                <p class="break-words text-xs text-muted-foreground">
                  Dependencies: {item.dependencies.join(", ")}
                </p>
              </Show>
              <time class="text-xs text-muted-foreground" dateTime={item.observedAt}>
                Recorded {new Date(item.observedAt).toLocaleString()}
              </time>
            </article>
          )}
        </For>
      </div>
    </section>
  );
};
