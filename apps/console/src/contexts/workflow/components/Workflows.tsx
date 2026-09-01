import type { WorkflowDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { createColumnHelper, createTable, tableFeatures } from "@tanstack/solid-table";
import { createEffect, createMemo, createSignal, type JSX, Match, Switch } from "solid-js";
import { ConsoleAccessError } from "../../daemon/services/browserAccess.ts";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { DataGrid } from "../../shared/components/data-grid/DataGrid.tsx";
import { DataGridTable } from "../../shared/components/data-grid/DataGridTable.tsx";
import { useWorkflows } from "../hooks/useWorkflows.ts";
import { type WorkflowFilterState, WorkflowFilters } from "./WorkflowFilters.tsx";

const filterFromUrl = (): WorkflowFilterState => {
  const search = new URLSearchParams(window.location.search);
  const availability = search.get("workflow");
  const activity = search.get("activity");
  return {
    text: search.get("q") ?? "",
    availability:
      availability === "available" || availability === "invalid" || availability === "removed"
        ? availability
        : "all",
    activity: activity === "active" || activity === "inactive" ? activity : "all",
  };
};

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, WorkflowDocument>();
const tone = (state: string): BadgeTone => {
  if (state === "available" || state === "current" || state === "active") return "good";
  if (state === "invalid" || state === "failed") return "danger";
  if (state === "pending" || state === "refreshing") return "waiting";
  return "neutral";
};

const columns = helper.columns([
  helper.accessor("workflowName", { header: "Workflow" }),
  helper.accessor("projectState", {
    header: "Project",
    cell: (info) => <Badge tone={tone(info.getValue())}>{info.getValue()}</Badge>,
  }),
  helper.accessor("factoryState", {
    header: "Factory",
    cell: (info) => <Badge tone={tone(info.getValue())}>{info.getValue()}</Badge>,
  }),
  helper.accessor("refreshState", {
    header: "Refresh",
    cell: (info) => <Badge tone={tone(info.getValue())}>{info.getValue()}</Badge>,
  }),
  helper.accessor("activity", {
    header: "Activity",
    cell: (info) => <Badge tone={tone(info.getValue())}>{info.getValue()}</Badge>,
  }),
  helper.accessor("availability", {
    header: "Availability",
    cell: (info) => <Badge tone={tone(info.getValue())}>{info.getValue()}</Badge>,
  }),
  helper.display({
    id: "source",
    header: "Source",
    cell: (info) => (
      <span class="block max-w-72">
        <span class="block truncate font-mono text-xs">{info.row.original.source}</span>
        {info.row.original.sourceFault === undefined ? null : (
          <span class="block text-red-700 text-xs dark:text-red-300">
            {info.row.original.sourceFault}
          </span>
        )}
      </span>
    ),
  }),
  helper.display({
    id: "revision",
    header: "Revision",
    cell: (info) => (
      <span class="font-mono text-xs">
        {(
          info.row.original.candidateRevisionId ??
          info.row.original.currentRevisionId ??
          "none"
        ).slice(0, 12)}
      </span>
    ),
  }),
  helper.display({
    id: "trigger",
    header: "Trigger observation",
    cell: (info) => <span>{info.row.original.trigger.state}</span>,
  }),
]);

export const Workflows = (props: { readonly projectId: string }): JSX.Element => {
  const workflows = useWorkflows(props.projectId);
  const [filters, setFilters] = createSignal(filterFromUrl());
  const rows = createMemo(() => {
    const query = filters();
    const text = query.text.trim().toLocaleLowerCase();
    return (workflows.data?.workflows ?? []).filter((workflow) => {
      const revision = workflow.candidateRevisionId ?? workflow.currentRevisionId ?? "";
      return (
        (query.availability === "all" || workflow.availability === query.availability) &&
        (query.activity === "all" || workflow.activity === query.activity) &&
        (text === "" ||
          `${workflow.workflowName}\n${workflow.source}\n${workflow.sourceFault ?? ""}\n${revision}`
            .toLocaleLowerCase()
            .includes(text))
      );
    });
  });
  createEffect(() => {
    const query = filters();
    const url = new URL(window.location.href);
    url.search = "";
    if (query.text !== "") url.searchParams.set("q", query.text);
    if (query.availability !== "all") url.searchParams.set("workflow", query.availability);
    if (query.activity !== "all") url.searchParams.set("activity", query.activity);
    window.history.replaceState(window.history.state, "", url);
  });
  const table = createTable({
    features,
    columns,
    get data() {
      return rows();
    },
    getRowId: (row) => `${row.projectId}:${row.workflowName}`,
  });
  const filtered = () =>
    filters().text !== "" || filters().availability !== "all" || filters().activity !== "all";

  return (
    <div class="mx-auto grid min-h-screen max-w-7xl gap-8 p-4 lg:grid-cols-[13rem_1fr] lg:p-8">
      <ConsoleNavigation current="Projects" />
      <main class="min-w-0">
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <a class="text-muted-foreground text-sm underline" href="/">
              Projects
            </a>
            <h1 class="font-semibold text-3xl">Workflows</h1>
            <p class="font-mono text-muted-foreground text-xs">{props.projectId}</p>
          </div>
          <WorkflowFilters filters={filters()} onChange={setFilters} />
        </header>
        <Switch>
          <Match when={workflows.isPending}>
            <p role="status">Reading fresh Workflow state…</p>
          </Match>
          <Match when={workflows.error instanceof ConsoleAccessError}>
            <p role="alert">
              Console access is required. Run <code>kojo ui</code> again.
            </p>
          </Match>
          <Match when={workflows.error !== null}>
            <p role="alert">
              Workflow state is unavailable. Run <code>kojo daemon status</code>.
            </p>
          </Match>
          <Match when={workflows.data}>
            {(snapshot) => (
              <DataGrid
                matchedCount={rows().length}
                recordCount={snapshot().counts.total}
                selectedCount={0}
              >
                <DataGridTable
                  emptyMessage={
                    filtered()
                      ? "No Workflows match these filters."
                      : "This Project has no Workflow history."
                  }
                  table={table}
                />
              </DataGrid>
            )}
          </Match>
        </Switch>
      </main>
    </div>
  );
};
