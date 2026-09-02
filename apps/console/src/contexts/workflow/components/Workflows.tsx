import type { WorkflowDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { createColumnHelper, createTable, tableFeatures } from "@tanstack/solid-table";
import { createEffect, createMemo, createSignal, type JSX, Match, Switch } from "solid-js";
import {
  ConsoleAccessError,
  forceStopWorkflow,
  startManualWorkflow,
  startTriggerWorkflow,
  stopWorkflow,
} from "../../daemon/services/browserAccess.ts";
import { ProjectLocation } from "../../project/components/ProjectLocation.tsx";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { DataGrid } from "../../shared/components/data-grid/DataGrid.tsx";
import { DataGridTable } from "../../shared/components/data-grid/DataGridTable.tsx";
import { Pagination, resourcePage } from "../../shared/components/data-grid/Pagination.tsx";
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

const WorkflowActions = (props: {
  readonly workflow: WorkflowDocument;
  readonly notice: () => string | undefined;
  readonly onNotice: (notice: string | undefined) => void;
}): JSX.Element => {
  const [payload, setPayload] = createSignal("{}");
  const [pending, setPending] = createSignal(false);
  const [forceAcknowledged, setForceAcknowledged] = createSignal(false);
  const trigger = () => props.workflow.trigger.state !== "not-declared";
  const start = async (): Promise<void> => {
    setPending(true);
    props.onNotice(undefined);
    try {
      if (trigger()) {
        await startTriggerWorkflow(props.workflow.projectId, props.workflow.workflowName);
        props.onNotice("Trigger listening. No immediate Run was created.");
      } else {
        const parsed = JSON.parse(payload()) as JsonValue;
        const result = await startManualWorkflow(
          props.workflow.projectId,
          props.workflow.workflowName,
          parsed,
        );
        props.onNotice(`Run ${result.runId} admitted.`);
      }
    } catch (cause) {
      props.onNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const stop = async (): Promise<void> => {
    setPending(true);
    props.onNotice(undefined);
    try {
      await stopWorkflow(props.workflow.projectId, props.workflow.workflowName);
      props.onNotice("Inactive. Admitted Runs remain eligible.");
    } catch (cause) {
      props.onNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const stopWithForce = async (): Promise<void> => {
    if (!forceAcknowledged()) return;
    setPending(true);
    props.onNotice(undefined);
    try {
      const result = await forceStopWorkflow(props.workflow.projectId, props.workflow.workflowName);
      props.onNotice(
        `Forced Stop accepted target set ${result.targetSetId ?? "unknown"}: ${result.targetedRunIds?.length ?? 0} Runs. Cancellation intent is separate from confirmed stop.`,
      );
      setForceAcknowledged(false);
    } catch (cause) {
      props.onNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div class="flex min-w-64 flex-col gap-2">
      {trigger() ? null : (
        <textarea
          aria-label={`JSON payload for ${props.workflow.workflowName}`}
          class="min-h-16 rounded border bg-background p-2 font-mono text-xs"
          value={payload()}
          onInput={(event) => setPayload(event.currentTarget.value)}
        />
      )}
      <div class="flex gap-2">
        <button
          type="button"
          disabled={pending() || props.workflow.availability !== "available"}
          class="rounded border px-2 py-1 text-xs"
          onClick={() => void start()}
        >
          {trigger() ? "Start Trigger" : "Start Run"}
        </button>
        <button
          type="button"
          disabled={pending() || props.workflow.activity === "inactive"}
          class="rounded border px-2 py-1 text-xs"
          onClick={() => void stop()}
        >
          Stop
        </button>
        <button
          type="button"
          disabled={pending() || !forceAcknowledged() || props.workflow.currentRuns.length === 0}
          class="rounded border border-red-700 px-2 py-1 text-xs text-red-700 dark:text-red-300"
          onClick={() => void stopWithForce()}
        >
          Stop with force
        </button>
        <a
          class="px-2 py-1 text-xs underline"
          href={`/runs?project=${encodeURIComponent(props.workflow.projectId)}&workflow=${encodeURIComponent(props.workflow.workflowName)}`}
        >
          Current Runs ({props.workflow.currentRuns.length})
        </a>
      </div>
      <label class="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={forceAcknowledged()}
          onChange={(event) => setForceAcknowledged(event.currentTarget.checked)}
        />
        <span>
          I understand that forced Stop records cancellation for the current nonterminal target set.
          It does not undo effects or prove Resource cleanup.
        </span>
      </label>
      {props.notice() === undefined ? null : <p role="status">{props.notice()}</p>}
    </div>
  );
};

const workflowColumns = (
  notice: (workflow: WorkflowDocument) => string | undefined,
  onNotice: (workflow: WorkflowDocument, value: string | undefined) => void,
) =>
  helper.columns([
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
          <span class="block">
            Revision:{" "}
            {(
              info.row.original.candidateRevisionId ??
              info.row.original.currentRevisionId ??
              "none"
            ).slice(0, 12)}
          </span>
          <span class="block">
            Graph: {(info.row.original.currentPackageGraphId ?? "none").slice(0, 12)}
          </span>
        </span>
      ),
    }),
    helper.display({
      id: "trigger",
      header: "Trigger observation",
      cell: (info) => <span>{info.row.original.trigger.state}</span>,
    }),
    helper.display({
      id: "actions",
      header: "Actions and current Runs",
      cell: (info) => (
        <WorkflowActions
          workflow={info.row.original}
          notice={() => notice(info.row.original)}
          onNotice={(value) => onNotice(info.row.original, value)}
        />
      ),
    }),
  ]);

export const Workflows = (props: { readonly projectId: string }): JSX.Element => {
  const workflows = useWorkflows(props.projectId);
  const [notices, setNotices] = createSignal<Readonly<Record<string, string | undefined>>>({});
  const noticeKey = (workflow: WorkflowDocument): string =>
    `${workflow.projectId}:${workflow.workflowName}`;
  const [filters, setFilters] = createSignal(filterFromUrl());
  const [cursor, setCursor] = createSignal(
    Math.max(0, Number(new URLSearchParams(window.location.search).get("cursor") ?? 0) || 0),
  );
  const rows = createMemo(() => {
    const query = filters();
    const text = query.text.trim().toLocaleLowerCase();
    return (workflows.data?.workflows ?? []).filter((workflow) => {
      const revision = workflow.candidateRevisionId ?? workflow.currentRevisionId ?? "";
      return (
        (query.availability === "all" || workflow.availability === query.availability) &&
        (query.activity === "all" || workflow.activity === query.activity) &&
        (text === "" ||
          `${workflow.workflowName}\n${workflow.source}\n${workflow.sourceFault ?? ""}\n${revision}\n${workflow.currentPackageGraphId ?? ""}`
            .toLocaleLowerCase()
            .includes(text))
      );
    });
  });
  const visibleRows = createMemo(() => resourcePage(rows(), cursor()));
  createEffect(() => {
    const query = filters();
    const url = new URL(window.location.href);
    url.search = "";
    if (query.text !== "") url.searchParams.set("q", query.text);
    if (query.availability !== "all") url.searchParams.set("workflow", query.availability);
    if (query.activity !== "all") url.searchParams.set("activity", query.activity);
    if (cursor() > 0) url.searchParams.set("cursor", String(cursor()));
    window.history.replaceState(window.history.state, "", url);
  });
  const table = createTable({
    features,
    columns: workflowColumns(
      (workflow) => notices()[noticeKey(workflow)],
      (workflow, notice) =>
        setNotices((current) => ({ ...current, [noticeKey(workflow)]: notice })),
    ),
    get data() {
      return visibleRows();
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
          <WorkflowFilters
            filters={filters()}
            onChange={(next) => {
              setFilters(next);
              setCursor(0);
            }}
          />
        </header>
        <ProjectLocation projectId={props.projectId} />
        <Switch>
          <Match when={workflows.isPending}>
            <p role="status">Reading fresh Workflow state…</p>
          </Match>
          <Match
            when={workflows.data === undefined && workflows.error instanceof ConsoleAccessError}
          >
            <p role="alert">
              Console access is required. Run <code>kojo ui</code> again.
            </p>
          </Match>
          <Match when={workflows.data === undefined && workflows.error !== null}>
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
                <Pagination cursor={cursor()} matchedCount={rows().length} onChange={setCursor} />
              </DataGrid>
            )}
          </Match>
        </Switch>
      </main>
    </div>
  );
};
