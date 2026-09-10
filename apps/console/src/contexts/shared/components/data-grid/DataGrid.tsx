import type { JSX } from "solid-js";

/** A small local adaptation of Zaidan's source-registry Data Grid container. */
export const DataGrid = (props: {
  readonly children: JSX.Element;
  readonly matchedCount: number;
  readonly recordCount: number;
  readonly resourceName: string;
}): JSX.Element => (
  <section
    class="overflow-hidden rounded-lg border border-border"
    data-slot="data-grid"
    data-list-composition="zaidan-data-grid"
  >
    {props.children}
    <footer class="flex flex-wrap justify-between gap-2 border-border border-t px-3 py-2 text-muted-foreground text-xs">
      <span>
        {props.matchedCount} of {props.recordCount} {props.resourceName}
      </span>
    </footer>
  </section>
);
