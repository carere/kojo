import { Link } from "@tanstack/solid-router";
import { type JSX, Show } from "solid-js";
import { useAskings } from "../../gate/hooks/useAskings.ts";
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
    <main class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8">
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
          when={rows().length > 0}
          fallback={
            <Notice tone="empty" title="No Runs are recorded.">
              <p class="mt-1">Start a Workflow from its registered Project.</p>
            </Notice>
          }
        >
          <RunList rows={rows()} />
        </Show>
      </Show>
    </main>
  );
};
