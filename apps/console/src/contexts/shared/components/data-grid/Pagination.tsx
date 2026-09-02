import type { JSX } from "solid-js";

export const resourcePageSize = 50;

export const resourcePage = <A,>(rows: ReadonlyArray<A>, cursor: number): ReadonlyArray<A> =>
  rows.slice(cursor, cursor + resourcePageSize);

export const Pagination = (props: {
  readonly cursor: number;
  readonly matchedCount: number;
  readonly onChange: (cursor: number) => void;
}): JSX.Element => {
  const end = () => Math.min(props.cursor + resourcePageSize, props.matchedCount);
  return (
    <nav
      aria-label="Resource pages"
      class="flex items-center justify-end gap-2 border-border border-t px-3 py-2"
    >
      <span class="text-muted-foreground text-xs">
        {props.matchedCount === 0 ? 0 : props.cursor + 1}–{end()} of {props.matchedCount}
      </span>
      <button
        type="button"
        class="rounded border px-2 py-1 text-xs disabled:opacity-50"
        disabled={props.cursor === 0}
        onClick={() => props.onChange(Math.max(0, props.cursor - resourcePageSize))}
      >
        Previous
      </button>
      <button
        type="button"
        class="rounded border px-2 py-1 text-xs disabled:opacity-50"
        disabled={end() >= props.matchedCount}
        onClick={() => props.onChange(props.cursor + resourcePageSize)}
      >
        Next
      </button>
    </nav>
  );
};
