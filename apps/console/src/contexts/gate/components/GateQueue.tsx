import { Link } from "@tanstack/solid-router";
import { For, type JSX, Show } from "solid-js";
import { Badge } from "../../shared/components/Badge.tsx";
import { Notice } from "../../shared/components/Notice.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../shared/components/Table.tsx";
import { retrying, settled } from "../../shared/hooks/settled.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useRuns } from "../../trace/hooks/useRuns.ts";
import { allSettled } from "../../trace/models/RunLine.ts";
import { useAskings } from "../hooks/useAskings.ts";
import { type QueueRow, queueRows, settledRows, waitingRows } from "../models/queue.ts";

/**
 * `/gates` — what waits on a human, across every run, and for how long.
 *
 * **The wait is the column this page exists for.** Human latency is the metric a factory lives or
 * dies by, and it is the one number nothing upstream measures: the engine knows a run is suspended,
 * not what it suspended on or how long a person has had the question. A run list can show one gate
 * per run; this shows every question in the building, worst first, so the one nobody has looked at
 * is at the top instead of buried under everything asked since.
 *
 * Rows do not disappear when they settle. A queue that emptied on a click would be claiming the run
 * had moved, which is precisely what the Console may not claim — so a settled asking drops into a
 * second list. Settled covers both ways an asking ends: **answered**, which says *recorded* and
 * sends the reader to the run (the only place that can prove whether a runner applied it), and
 * **expired**, which is the run's own account that nobody answered in time and no answer can land
 * any more. Expired is not overdue: overdue rows stay in the waiting list, because an answer may
 * still reach them.
 */
export const GateQueue = (): JSX.Element => {
  const now = useNow();
  const runs = useRuns();
  // The same rule the run list follows: an asking carries no outcome of its own, so the runs are
  // what say whether this factory still has anything that could ask or answer.
  const askings = useAskings(() => !allSettled(settled(runs) ?? []));

  const rows = () => queueRows({ askings: settled(askings) ?? [], now: now() });

  return (
    <main class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8">
      <nav class="text-muted-foreground text-xs">
        <Link to="/" class="hover:underline">
          ← every run
        </Link>
      </nav>

      <header class="flex flex-col gap-1">
        <h1 class="text-xl font-semibold">What waits on a human</h1>
        <p class="text-muted-foreground text-xs">
          Worst first: overdue above waiting, and the longest wait above the rest.
        </p>
      </header>

      <Show when={retrying(askings) || retrying(runs)}>
        <Notice tone="retrying" title="Cannot reach the Console API. Retrying…">
          <p class="mt-1">What is on screen is the last answer this Console received.</p>
        </Notice>
      </Show>

      <Show
        when={settled(askings)}
        fallback={<p class="text-muted-foreground text-sm">Loading the queue…</p>}
      >
        <Show
          when={waitingRows(rows()).length > 0}
          fallback={
            <Notice tone="empty" title="Nothing is waiting on a human.">
              <p class="mt-1">
                No run in this factory has stopped at a gate. Nothing has gone wrong.
              </p>
            </Notice>
          }
        >
          <QueueTable rows={waitingRows(rows())} />
        </Show>

        {/*
         * Settled — answered or expired — and never claimed to have been applied. This page reads
         * one list across every run and has no run document to check, so it says what it knows
         * and points at the run, which can prove the rest. The one exception is *expired*, which
         * the run itself wrote down: that fact needs no document.
         */}
        <Show when={settledRows(rows()).length > 0}>
          <section class="flex flex-col gap-2" data-queue="recorded">
            <h2 class="text-sm font-semibold">Settled</h2>
            <p class="text-muted-foreground text-xs">
              Answered, or expired. A verdict written down here is recorded, not applied — whether a
              runner has applied it is on the run, open one to see. An expired asking cannot be
              answered any more.
            </p>
            <QueueTable rows={settledRows(rows())} />
          </section>
        </Show>
      </Show>
    </main>
  );
};

/**
 * The rows, as a table.
 *
 * Hand-written rather than through TanStack Table, and that is the smaller thing here: this list has
 * no sorting, no filtering and no row model to own — the order is the one rule the queue has, and it
 * is computed with the rows. A headless table around six static columns would be machinery with
 * nothing to do.
 */
const QueueTable = (props: { readonly rows: ReadonlyArray<QueueRow> }): JSX.Element => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Run</TableHead>
        <TableHead>Gate</TableHead>
        <TableHead>Asked of</TableHead>
        <TableHead>Waited</TableHead>
        <TableHead>Deadline</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <For each={props.rows}>
        {(row) => (
          <TableRow data-queued={row.runId} data-queued-asking={row.asking}>
            <TableCell>
              <Link
                to="/runs/$runId"
                params={{ runId: row.runId }}
                search={{ view: "timeline" as const }}
                class="font-mono text-xs hover:underline"
              >
                {row.runId}
              </Link>
            </TableCell>
            <TableCell>
              {/*
               * Straight into the gate's own panel, which is where the answer controls are. The
               * queue's job is to find the question; answering it is one click from here.
               */}
              <Link
                to="/runs/$runId/gates/$gate/$asking"
                params={{ runId: row.runId, gate: row.gate, asking: row.asking }}
                search={{ view: "timeline" as const }}
                data-queued-open
                class="text-xs hover:underline"
                title={row.description}
              >
                {row.gate}
              </Link>
            </TableCell>
            <TableCell>
              <span class="text-xs">{row.actor}</span>
            </TableCell>
            <TableCell>
              <span data-queued-waited class="text-xs">
                {row.waited}
              </span>
            </TableCell>
            <TableCell>
              {/*
               * Three sentences, one cell. Expired outranks a recorded verdict, because a verdict
               * the run has already expired past is one it will never apply — and *expired* is
               * deliberately not the word *overdue*: overdue rows keep their deadline text in the
               * waiting list above, because an answer may still land on them.
               */}
              <Show
                when={row.answerer === undefined && !row.expired}
                fallback={
                  <Show
                    when={row.expired}
                    fallback={
                      <Badge tone="waiting" data-queued-recorded={row.answerer}>
                        recorded by {row.answerer}
                      </Badge>
                    }
                  >
                    <Badge tone="danger" data-queued-expired="true">
                      expired — nobody answered in time
                    </Badge>
                  </Show>
                }
              >
                <span class={row.overdue ? "text-xs text-red-700 dark:text-red-300" : "text-xs"}>
                  {row.deadline}
                </span>
              </Show>
            </TableCell>
          </TableRow>
        )}
      </For>
    </TableBody>
  </Table>
);
