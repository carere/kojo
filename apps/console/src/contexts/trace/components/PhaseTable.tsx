import { createColumnHelper, createTable, tableFeatures } from "@tanstack/solid-table";
import { For, type JSX } from "solid-js";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../shared/components/Table.tsx";
import { axisDuration } from "../../shared/lib/duration.ts";
import type { PhaseState } from "../models/RunDoc.ts";
import type { PhaseSpan } from "../models/waterfall.ts";
import { hostRow } from "../models/waterfall.ts";

/**
 * The same phase records, as rows.
 *
 * console.md §4 keeps this available behind a toggle and adr/trace/0001 says why it is not the
 * centrepiece: the two costs this whole design exists to manage — how long a human held a gate, and
 * what a sandbox rebuild took — are durations, and a table gives a two-second phase and a
 * forty-one-hour wait the same row height. It costs nothing to offer because it is the same data.
 *
 * **The same spans, not a second read.** It renders what the waterfall renders, so a phase cannot be
 * on one and missing from the other — including the in-flight one, which appears here with its
 * duration still growing.
 */

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, PhaseSpan>();

const stateTones: Record<PhaseState, BadgeTone> = {
  running: "running",
  interrupted: "waiting",
  succeeded: "good",
  failed: "danger",
};

/** The scope a phase ran in, as a word. `host` is a fact, not an absence. */
const scopeOf = (span: PhaseSpan): string =>
  span.rowId === hostRow ? "host" : (span.rowId.split("/")[1] ?? span.rowId);

const columns = helper.columns([
  helper.accessor("name", {
    header: "Phase",
    cell: (info) => <span class="font-medium">{info.row.original.name}</span>,
  }),
  helper.accessor("kind", {
    header: "Kind",
    cell: (info) => <span>{info.row.original.kind}</span>,
  }),
  helper.accessor("state", {
    header: "Outcome",
    cell: (info) => (
      <Badge tone={stateTones[info.row.original.state]}>{info.row.original.state}</Badge>
    ),
  }),
  helper.accessor("rowId", {
    header: "Scope",
    cell: (info) => <span>{scopeOf(info.row.original)}</span>,
  }),
  helper.accessor("startedAt", {
    header: "Duration",
    cell: (info) => (
      <span class="tabular-nums">
        {axisDuration(info.row.original.endedAt - info.row.original.startedAt)}
      </span>
    ),
  }),
  helper.accessor("corrections", {
    header: "Corrections",
    cell: (info) => <span class="tabular-nums">{info.row.original.corrections}</span>,
  }),
  helper.accessor("errorTag", {
    header: "Error",
    cell: (info) => <span>{info.row.original.errorTag ?? "—"}</span>,
  }),
]);

export const PhaseTable = (props: { readonly spans: ReadonlyArray<PhaseSpan> }): JSX.Element => {
  const table = createTable({
    features,
    columns,
    get data() {
      return [...props.spans].sort((left, right) => left.startedAt - right.startedAt);
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
        <For each={table.getRowModel().rows}>
          {(row) => (
            <TableRow data-phase-row={row.original.phaseId}>
              <For each={row.getAllCells()}>
                {(cell) => (
                  <TableCell>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                )}
              </For>
            </TableRow>
          )}
        </For>
      </TableBody>
    </Table>
  );
};
