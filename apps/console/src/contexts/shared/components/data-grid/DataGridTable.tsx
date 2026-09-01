import type { RowData, SolidTable, TableFeatures } from "@tanstack/solid-table";
import { For, type JSX, Show } from "solid-js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../Table.tsx";

/** Zaidan-shaped Data Grid table rendering over one TanStack table instance. */
export const DataGridTable = <TFeatures extends TableFeatures, T extends RowData>(props: {
  readonly emptyMessage: string;
  readonly table: SolidTable<TFeatures, T>;
}): JSX.Element => (
  <Table>
    <TableHeader>
      <For each={props.table.getHeaderGroups()}>
        {(group) => (
          <TableRow>
            <For each={group.headers}>
              {(header) => (
                <TableHead>
                  <props.table.FlexRender header={header} />
                </TableHead>
              )}
            </For>
          </TableRow>
        )}
      </For>
    </TableHeader>
    <TableBody>
      <Show
        when={props.table.getRowModel().rows.length > 0}
        fallback={
          <TableRow>
            <TableCell class="py-10 text-center text-muted-foreground" colSpan={20}>
              {props.emptyMessage}
            </TableCell>
          </TableRow>
        }
      >
        <For each={props.table.getRowModel().rows}>
          {(row) => (
            <TableRow data-project-id={row.id}>
              <For each={row.getAllCells()}>
                {(cell) => (
                  <TableCell>
                    <props.table.FlexRender cell={cell} />
                  </TableCell>
                )}
              </For>
            </TableRow>
          )}
        </For>
      </Show>
    </TableBody>
  </Table>
);
