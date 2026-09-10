import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { useAskings } from "../../gate/hooks/useAskings.ts";
import { useProjects } from "../../project/hooks/useProjects.ts";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { Pagination } from "../../shared/components/data-grid/Pagination.tsx";
import { Notice } from "../../shared/components/Notice.tsx";
import { retrying, settled } from "../../shared/hooks/settled.ts";
import { usePaginationState } from "../../shared/hooks/usePaginationState.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { StartWorkflow } from "../../workflow/components/StartWorkflow.tsx";
import { useRuns } from "../hooks/useRuns.ts";
import { allSettled } from "../models/RunLine.ts";
import { runRows } from "../models/RunRow.ts";
import { RunList } from "./RunList.tsx";

/** Show the Daemon Run catalogue, its waiting reasons, and its empty or connection states. */
export const Runs = (): JSX.Element => {
  const now = useNow();
  const runs = useRuns();
  const projects = useProjects();
  const projectLabels = () =>
    new Map((projects.data?.projects ?? []).map((project) => [project.projectId, project.label]));
  // The askings stop polling exactly when the runs do. An asking carries no outcome of its own, so
  // the run list is the only thing that can say whether this factory has anything left to watch.
  const askings = useAskings(() => !allSettled(settled(runs) ?? []));

  const lines = () => settled(runs);
  const search = new URLSearchParams(window.location.search);
  const [text, setText] = createSignal(search.get("q") ?? "");
  const [status, setStatus] = createSignal(search.get("status") ?? "all");
  const project = search.get("project") ?? "";
  const workflow = search.get("workflow") ?? "";
  const selectedLines = () =>
    (lines() ?? []).filter(
      (line) =>
        (project === "" || line.run.projectId === project) &&
        (workflow === "" || line.run.workflow === workflow),
    );
  const filteredRows = createMemo(() => {
    const query = text().trim().toLocaleLowerCase();
    return runRows({
      runs: selectedLines(),
      askings: settled(askings) ?? [],
      now: now(),
      projects: projectLabels(),
    }).filter(
      (row) =>
        (status() === "all" || row.status === status()) &&
        (query === "" ||
          `${row.request}\n${row.runId}\n${row.workflow}\n${row.project}\n${row.activity}\n${row.status}\n${row.queueReason}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  });
  const {
    cursor,
    page: visibleRows,
    setCursor,
    reset: resetPage,
  } = usePaginationState(filteredRows, () => ({
    project,
    workflow,
    q: text(),
    status: status() === "all" ? undefined : status(),
  }));

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
    <div class="mx-auto grid min-h-screen content-start max-w-7xl gap-8 p-4 lg:grid-cols-[13rem_1fr] lg:p-8">
      <ConsoleNavigation current="Runs" />
      <main class="flex min-w-0 flex-col gap-4">
        <header class="flex flex-col gap-1">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h1 class="text-xl font-semibold">Runs</h1>
            <span class="text-sm text-muted-foreground">
              {waitingCount()} waiting for a Gate answer
            </span>
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
                  resetPage();
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
                  resetPage();
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

        <StartWorkflow />

        <Show when={unreachable()}>
          <Notice tone="retrying" title="Cannot reach the Console API. Retrying…">
            <p class="mt-1">
              What is on screen is the last answer this Console received. Nothing has been lost.
            </p>
          </Notice>
        </Show>

        <Show when={lines()} fallback={<p class="text-muted-foreground text-sm">Loading Runs…</p>}>
          <section class="overflow-hidden rounded-lg border border-border">
            <Show
              when={filteredRows().length > 0}
              fallback={
                <Notice tone="empty" title="No Runs are recorded.">
                  <p class="mt-1">Use Start a Workflow to submit a request.</p>
                </Notice>
              }
            >
              <RunList rows={visibleRows()} />
            </Show>
            <Show when={filteredRows().length > 0}>
              <Pagination
                cursor={cursor()}
                matchedCount={filteredRows().length}
                onChange={setCursor}
              />
            </Show>
          </section>
        </Show>
      </main>
    </div>
  );
};
