import { Link } from "@tanstack/solid-router";
import { createColumnHelper, createTable, tableFeatures } from "@tanstack/solid-table";
import { createEffect, For, Index, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../shared/components/Table.tsx";
import type { RunStatus } from "../models/RunLine.ts";
import type { RunRow } from "../models/RunRow.ts";

/**
 * Every run this factory has, as the five columns console.md §3 names.
 *
 * **The rows arrive finished.** Every value here is already a string, computed against an injected
 * clock by `runRows`, so no cell renderer reaches for the time and no screenshot can move under a
 * test. The table is headless — it owns the row model and this file owns the markup — and no
 * feature beyond the core is switched on, because sorting and filtering belong in the URL
 * (console.md §8) rather than in component state.
 */

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, RunRow>();

/** What each status looks like. A colour per meaning, decided once. */
const statusTones: Record<RunStatus, BadgeTone> = {
  queued: "waiting",
  executing: "running",
  suspended: "waiting",
  held: "danger",
  succeeded: "good",
  failed: "danger",
  cancelled: "danger",
};

const columns = helper.columns([
  helper.accessor("runId", {
    header: "Run",
    // The list is a way in, and the run view is what it is a way in to. A `Link` rather than a click
    // handler on the row: a run's URL is the thing a person pastes into a chat.
    cell: (info) => (
      <Link
        to="/runs/$runId"
        params={{ runId: info.row.original.runId }}
        search={{ view: "timeline" as const }}
        class="font-mono text-xs hover:underline"
      >
        {info.row.original.runId}
      </Link>
    ),
  }),
  helper.accessor("workflow", {
    header: "Workflow",
    cell: (info) => <span>{info.row.original.workflow}</span>,
  }),
  helper.accessor("status", {
    header: "Status",
    cell: (info) => (
      <Badge tone={statusTones[info.row.original.status]}>{info.row.original.status}</Badge>
    ),
  }),
  helper.accessor("queueReason", {
    header: "Queue reason",
    cell: (info) => <span>{info.getValue()}</span>,
  }),
  helper.accessor("gate", {
    header: "Open gate",
    cell: (info) => <span>{info.row.original.gate}</span>,
  }),
  helper.accessor("deadline", {
    header: "Deadline",
    cell: (info) => (
      <span
        title={info.row.original.deadlineAt}
        class={info.row.original.overdue ? "text-red-700 dark:text-red-300" : undefined}
      >
        {info.row.original.deadline}
      </span>
    ),
  }),
]);

export const RunList = (props: { readonly rows: ReadonlyArray<RunRow> }): JSX.Element => {
  const [rows, setRows] = createStore<Array<RunRow>>([]);
  createEffect(() => setRows(reconcile([...props.rows], { key: "runId" })));
  const table = createTable({
    features,
    columns,
    // Reconcile by Run identity before the table reads the array. The clock and Daemon polling
    // update row fields in place, so a person can click a link without that link being replaced.
    get data() {
      return [...rows];
    },
  });

  return (
    <Table>
      <TableHeader>
        <For each={table.getHeaderGroups()}>
          {(group) => (
            <TableRow>
              <For each={group.headers}>
                {(header) => (
                  <TableHead>
                    <table.FlexRender header={header} />
                  </TableHead>
                )}
              </For>
            </TableRow>
          )}
        </For>
      </TableHeader>
      <TableBody>
        <Index each={table.getRowModel().rows}>
          {(row) => (
            <TableRow data-run={row().original.runId}>
              <Index each={row().getAllCells()}>
                {(cell) => (
                  <TableCell>
                    <table.FlexRender cell={cell()} />
                  </TableCell>
                )}
              </Index>
            </TableRow>
          )}
        </Index>
      </TableBody>
    </Table>
  );
};
