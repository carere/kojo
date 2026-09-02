import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { DataGrid } from "./DataGrid.tsx";

/** Zaidan Data Grid composition for compact resource lists inside detail views. */
export const ResourceList = <T,>(props: {
  readonly emptyMessage: string;
  readonly items: ReadonlyArray<T>;
  readonly label: string;
  readonly render: (item: T) => JSX.Element;
  readonly searchText: (item: T) => string;
}): JSX.Element => {
  const [text, setText] = createSignal("");
  const filtered = createMemo(() => {
    const query = text().trim().toLocaleLowerCase();
    return query === ""
      ? props.items
      : props.items.filter((item) => props.searchText(item).toLocaleLowerCase().includes(query));
  });
  return (
    <DataGrid
      matchedCount={filtered().length}
      recordCount={props.items.length}
      resourceName={props.label}
      selectedCount={0}
    >
      <div class="flex flex-wrap gap-2 border-border border-b p-2" data-slot="filters">
        <label class="grid flex-1 gap-1 text-muted-foreground text-xs">
          Find
          <input
            aria-label={`Find ${props.label}`}
            class="min-w-32 rounded-md border border-border bg-background px-2 py-1 text-foreground text-xs"
            type="search"
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          class="self-end rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setText("")}
        >
          Clear
        </button>
      </div>
      <Show
        when={filtered().length > 0}
        fallback={<p class="p-3 text-muted-foreground text-xs">{props.emptyMessage}</p>}
      >
        <ul class="flex flex-col gap-1 p-2">
          <For each={filtered()}>{(item) => <li>{props.render(item)}</li>}</For>
        </ul>
      </Show>
    </DataGrid>
  );
};
