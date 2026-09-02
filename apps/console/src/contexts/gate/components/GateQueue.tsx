import { Link } from "@tanstack/solid-router";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { Badge } from "../../shared/components/Badge.tsx";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { Pagination, resourcePage } from "../../shared/components/data-grid/Pagination.tsx";
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
  const search = new URLSearchParams(window.location.search);
  const [text, setText] = createSignal(search.get("q") ?? "");
  const [state, setState] = createSignal(search.get("state") ?? "all");
  const [cursor, setCursor] = createSignal(Math.max(0, Number(search.get("cursor") ?? 0) || 0));
  const filteredRows = createMemo(() => {
    const query = text().trim().toLocaleLowerCase();
    return rows().filter(
      (row) =>
        (state() === "all" || row.state === state()) &&
        (query === "" ||
          `${row.runId}\n${row.gate}\n${row.actor}\n${row.description}\n${row.answerer ?? ""}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  });
  const visibleRows = createMemo(() => resourcePage(filteredRows(), cursor()));

  createEffect(() => {
    const url = new URL(window.location.href);
    url.search = "";
    if (text() !== "") url.searchParams.set("q", text());
    if (state() !== "all") url.searchParams.set("state", state());
    if (cursor() > 0) url.searchParams.set("cursor", String(cursor()));
    window.history.replaceState(window.history.state, "", url);
  });

  return (
    <div class="mx-auto grid min-h-screen max-w-7xl gap-8 p-4 lg:grid-cols-[13rem_1fr] lg:p-8">
      <ConsoleNavigation current="Gate" />
      <main class="flex min-w-0 flex-col gap-4">
        <header class="flex flex-col gap-1">
          <h1 class="text-xl font-semibold">What waits on a human</h1>
          <p class="text-muted-foreground text-xs">
            Worst first: overdue above waiting, and the longest wait above the rest.
          </p>
          <div class="flex flex-wrap gap-2" data-slot="filters">
            <label class="grid gap-1 text-muted-foreground text-xs">
              Find
              <input
                aria-label="Find Gates"
                class="min-w-56 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
                type="search"
                value={text()}
                onInput={(event) => {
                  setText(event.currentTarget.value);
                  setCursor(0);
                }}
              />
            </label>
            <label class="grid gap-1 text-muted-foreground text-xs">
              State
              <select
                aria-label="Gate state"
                class="rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
                value={state()}
                onChange={(event) => {
                  setState(event.currentTarget.value);
                  setCursor(0);
                }}
              >
                <option value="all">All states</option>
                <option value="unanswered">Unanswered</option>
                <option value="recorded">Recorded</option>
                <option value="applied">Applied</option>
                <option value="expired">Expired</option>
              </select>
            </label>
          </div>
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
            when={waitingRows(visibleRows()).length > 0}
            fallback={
              <Notice tone="empty" title="Nothing is waiting on a human.">
                <p class="mt-1">
                  No run in this factory has stopped at a gate. Nothing has gone wrong.
                </p>
              </Notice>
            }
          >
            <QueueTable rows={waitingRows(visibleRows())} />
          </Show>

          {/*
           * Settled — answered or expired — and never claimed to have been applied. This page reads
           * one list across every run and has no run document to check, so it says what it knows
           * and points at the run, which can prove the rest. The one exception is *expired*, which
           * the run itself wrote down: that fact needs no document.
           */}
          <Show when={settledRows(visibleRows()).length > 0}>
            <section class="flex flex-col gap-2" data-queue="recorded">
              <h2 class="text-sm font-semibold">Settled</h2>
              <p class="text-muted-foreground text-xs">
                Answered, or expired. A verdict written down here is recorded, not applied — whether
                a runner has applied it is on the run, open one to see. An expired asking cannot be
                answered any more.
              </p>
              <QueueTable rows={settledRows(visibleRows())} />
            </section>
          </Show>
        </Show>
        <Pagination cursor={cursor()} matchedCount={filteredRows().length} onChange={setCursor} />
      </main>
    </div>
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
