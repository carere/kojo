import { Link } from "@tanstack/solid-router";
import { createEffect, createMemo, createSignal, type JSX, Show } from "solid-js";
import { useAskings } from "../../gate/hooks/useAskings.ts";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { Pagination, resourcePage } from "../../shared/components/data-grid/Pagination.tsx";
import { Notice } from "../../shared/components/Notice.tsx";
import { retrying, settled } from "../../shared/hooks/settled.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useRuns } from "../hooks/useRuns.ts";
import { allSettled } from "../models/RunLine.ts";
import { runRows } from "../models/RunRow.ts";
import { RunList } from "./RunList.tsx";

/**
 * The Daemon Run catalogue, and what each Run waits on.
 *
 * Four states, and console.md §10 makes three of them part of the feature rather than polish:
 *
 * - **No Runs yet.** No registered Project has admitted a Run.
 * - **The API is unreachable.** The table stays exactly as it was and a banner says the Console is
 *   still trying. Never a blank view, and never an error page over data that is still on screen.
 *
 * The fourth is the ordinary one. The rows are rebuilt whenever the runs, the askings or the clock
 * move, so a gate crossing its deadline turns red without anything being refetched.
 */
export const Runs = (): JSX.Element => {
  const now = useNow();
  const runs = useRuns();
  // The askings stop polling exactly when the runs do. An asking carries no outcome of its own, so
  // the run list is the only thing that can say whether this factory has anything left to watch.
  const askings = useAskings(() => !allSettled(settled(runs) ?? []));

  const lines = () => settled(runs);
  const rows = () => runRows({ runs: lines() ?? [], askings: settled(askings) ?? [], now: now() });
  const search = new URLSearchParams(window.location.search);
  const [text, setText] = createSignal(search.get("q") ?? "");
  const [status, setStatus] = createSignal(search.get("status") ?? "all");
  const [cursor, setCursor] = createSignal(Math.max(0, Number(search.get("cursor") ?? 0) || 0));
  const filteredRows = createMemo(() => {
    const query = text().trim().toLocaleLowerCase();
    return rows().filter(
      (row) =>
        (status() === "all" || row.status === status()) &&
        (query === "" ||
          `${row.runId}\n${row.workflow}\n${row.status}\n${row.queueReason}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  });
  const visibleRows = createMemo(() => resourcePage(filteredRows(), cursor()));

  createEffect(() => {
    const url = new URL(window.location.href);
    url.search = "";
    if (text() !== "") url.searchParams.set("q", text());
    if (status() !== "all") url.searchParams.set("status", status());
    if (cursor() > 0) url.searchParams.set("cursor", String(cursor()));
    window.history.replaceState(window.history.state, "", url);
  });

  const unreachable = () => retrying(runs) || retrying(askings);
  /**
   * How many questions are with a person right now. A settled asking is not waiting on anybody —
   * answered means somebody took it, and expired means nobody can any more.
   */
  const waitingCount = () =>
    (settled(askings) ?? []).filter(
      (asking) => asking.verdict === undefined && asking.expiredAt === undefined,
    ).length;

  return (
    <div class="mx-auto grid min-h-screen max-w-7xl gap-8 p-4 lg:grid-cols-[13rem_1fr] lg:p-8">
      <ConsoleNavigation current="Runs" />
      <main class="flex min-w-0 flex-col gap-4">
        <header class="flex flex-col gap-1">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h1 class="text-xl font-semibold">Runs</h1>
            {/*
             * The way into the queue, and it carries the count because the count is the point: how
             * many questions are sitting with a person right now is the first thing worth knowing
             * about a factory, and it is not a column of this table.
             */}
            <Link to="/gates" data-queue-link class="text-xs underline underline-offset-2">
              {waitingCount()} waiting on a human →
            </Link>
          </div>
          <div class="flex flex-wrap gap-2" data-slot="filters">
            <label class="grid gap-1 text-muted-foreground text-xs">
              Find
              <input
                aria-label="Find Runs"
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
              Status
              <select
                aria-label="Run status"
                class="rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm"
                value={status()}
                onChange={(event) => {
                  setStatus(event.currentTarget.value);
                  setCursor(0);
                }}
              >
                <option value="all">All states</option>
                <option value="queued">Queued</option>
                <option value="executing">Executing</option>
                <option value="suspended">Suspended</option>
                <option value="held">Held</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
        </header>

        <Show when={unreachable()}>
          <Notice tone="retrying" title="Cannot reach the Console API. Retrying…">
            <p class="mt-1">
              What is on screen is the last answer this Console received. Nothing has been lost.
            </p>
          </Notice>
        </Show>

        <Show when={lines()} fallback={<p class="text-muted-foreground text-sm">Loading Runs…</p>}>
          <Show
            when={filteredRows().length > 0}
            fallback={
              <Notice tone="empty" title="No Runs are recorded.">
                <p class="mt-1">Start a Workflow from its registered Project.</p>
              </Notice>
            }
          >
            <RunList rows={visibleRows()} />
          </Show>
        </Show>
        <Pagination cursor={cursor()} matchedCount={filteredRows().length} onChange={setCursor} />
      </main>
    </div>
  );
};
