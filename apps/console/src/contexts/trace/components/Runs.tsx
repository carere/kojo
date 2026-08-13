import { Link } from "@tanstack/solid-router";
import { type JSX, Show } from "solid-js";
import { useAskings } from "../../gate/hooks/useAskings.ts";
import { Notice } from "../../shared/components/Notice.tsx";
import { retrying, settled } from "../../shared/hooks/settled.ts";
import { useHealth } from "../../shared/hooks/useHealth.ts";
import { noFactoryNotice, noRunsNotice } from "../../shared/models/Health.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useRuns } from "../hooks/useRuns.ts";
import { allSettled } from "../models/RunLine.ts";
import { runRows } from "../models/RunRow.ts";
import { RunList } from "./RunList.tsx";

/**
 * The Console's front page: every run of one factory, and what each of them waits on.
 *
 * Four states, and console.md §10 makes three of them part of the feature rather than polish:
 *
 * - **No factory here.** Not an error page. `kojo ui` serves happily in a repository nobody has run
 *   `kojo init` in, health says so, and the Console repeats the sentence the server sent.
 * - **No runs yet.** The factory exists and nothing has run in it — which is a different thing from
 *   an empty answer caused by a broken read, and it says so.
 * - **The API is unreachable.** The table stays exactly as it was and a banner says the Console is
 *   still trying. Never a blank view, and never an error page over data that is still on screen.
 *
 * The fourth is the ordinary one. The rows are rebuilt whenever the runs, the askings or the clock
 * move, so a gate crossing its deadline turns red without anything being refetched.
 */
export const Runs = (): JSX.Element => {
  const now = useNow();
  const health = useHealth();
  const runs = useRuns();
  // The askings stop polling exactly when the runs do. An asking carries no outcome of its own, so
  // the run list is the only thing that can say whether this factory has anything left to watch.
  const askings = useAskings(() => !allSettled(settled(runs) ?? []));

  const lines = () => settled(runs);
  const rows = () => runRows({ runs: lines() ?? [], askings: settled(askings) ?? [], now: now() });

  const absent = () => settled(health)?.factory === "absent";
  const unreachable = () => retrying(runs) || retrying(askings) || retrying(health);
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
        <Show when={settled(health)}>
          {(document) => (
            <p class="text-muted-foreground font-mono text-xs">{document().database}</p>
          )}
        </Show>
      </header>

      <Show when={unreachable()}>
        <Notice tone="retrying" title="Cannot reach the Console API. Retrying…">
          <p class="mt-1">
            What is on screen is the last answer this Console received. Nothing has been lost.
          </p>
        </Notice>
      </Show>

      <Show
        when={!absent()}
        fallback={
          <Notice tone="empty" title={settled(health)?.notice ?? noFactoryNotice}>
            <p class="mt-1">
              The Console is serving, and every list is empty because there is nothing to read yet.
            </p>
          </Notice>
        }
      >
        <Show when={lines()} fallback={<p class="text-muted-foreground text-sm">Loading runs…</p>}>
          <Show
            when={rows().length > 0}
            fallback={
              <Notice tone="empty" title={noRunsNotice}>
                <p class="mt-1">This factory is ready; nothing has been asked of it yet.</p>
              </Notice>
            }
          >
            <RunList rows={rows()} />
          </Show>
        </Show>
      </Show>
    </main>
  );
};
