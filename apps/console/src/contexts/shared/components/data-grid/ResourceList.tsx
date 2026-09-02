import { createMemo, For, type JSX, Show } from "solid-js";
import { resourceListState } from "../../hooks/resourceListState.ts";
import { DataGrid } from "./DataGrid.tsx";

/** Zaidan Data Grid composition for compact resource lists inside detail views. */
export const ResourceList = <T,>(props: {
  readonly emptyMessage: string;
  readonly items: ReadonlyArray<T>;
  readonly label: string;
  /** Stable and unique inside a page. It owns this list's URL filter and cursor keys. */
  readonly namespace: string;
  readonly render: (item: T) => JSX.Element;
  readonly searchText: (item: T) => string;
}): JSX.Element => {
  const state = resourceListState(props.namespace);
  const filtered = createMemo(() => {
    const query = state.filter().trim().toLocaleLowerCase();
    return query === ""
      ? props.items
      : props.items.filter((item) => props.searchText(item).toLocaleLowerCase().includes(query));
  });
  const visible = createMemo(() => filtered().slice(0, state.limit()));
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
            value={state.filter()}
            onInput={(event) => state.setFilter(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          class="self-end rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => state.setFilter("")}
        >
          Clear
        </button>
      </div>
      <Show
        when={filtered().length > 0}
        fallback={<p class="p-3 text-muted-foreground text-xs">{props.emptyMessage}</p>}
      >
        <ul class="flex flex-col gap-1 p-2">
          <For each={visible()}>{(item) => <li>{props.render(item)}</li>}</For>
        </ul>
      </Show>
      <Show when={visible().length < filtered().length}>
        <button
          type="button"
          data-load-more={props.namespace}
          class="m-2 rounded-md border border-border px-2 py-1 text-xs"
          onClick={state.loadMore}
        >
          Load more
        </button>
      </Show>
    </DataGrid>
  );
};
