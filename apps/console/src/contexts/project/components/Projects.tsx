import type { ProjectDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Link } from "@tanstack/solid-router";
import {
  createColumnHelper,
  createTable,
  type RowSelectionState,
  rowSelectionFeature,
  tableFeatures,
} from "@tanstack/solid-table";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Match,
  type Setter,
  Switch,
} from "solid-js";
import { ConsoleAccessError } from "../../daemon/services/browserAccess.ts";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { DataGrid } from "../../shared/components/data-grid/DataGrid.tsx";
import { DataGridTable } from "../../shared/components/data-grid/DataGridTable.tsx";
import { Filters, type ProjectFilters } from "../../shared/components/filters/Filters.tsx";
import { useProjects } from "../hooks/useProjects.ts";

const filterFromUrl = (): ProjectFilters => {
  const search = new URLSearchParams(window.location.search);
  const project = search.get("project");
  const factory = search.get("factory");
  return {
    text: search.get("q") ?? "",
    project:
      project === "available" || project === "unavailable" || project === "archived"
        ? project
        : "all",
    factory:
      factory === "available" || factory === "missing" || factory === "invalid" ? factory : "all",
  };
};

const selectionFromUrl = (): RowSelectionState => {
  const selected = new URLSearchParams(window.location.search).getAll("selected");
  return Object.fromEntries(selected.map((projectId) => [projectId, true] as const));
};

const features = tableFeatures({ rowSelectionFeature });
const helper = createColumnHelper<typeof features, ProjectDocument>();
const tone = (state: string): BadgeTone => {
  if (state === "available") return "good";
  if (state === "invalid" || state === "unavailable") return "danger";
  if (state === "missing") return "waiting";
  return "neutral";
};

const projectColumns = (
  selection: Accessor<RowSelectionState>,
  setSelection: Setter<RowSelectionState>,
) =>
  helper.columns([
    helper.display({
      id: "selection",
      header: "Select",
      cell: (info) => (
        <input
          aria-label={`Select ${info.row.original.label}`}
          checked={selection()[info.row.id] === true}
          onChange={(event) =>
            setSelection((current) => {
              if (event.currentTarget.checked) return { ...current, [info.row.id]: true };
              const next = { ...current };
              delete next[info.row.id];
              return next;
            })
          }
          type="checkbox"
        />
      ),
    }),
    helper.accessor("label", {
      header: "Project",
      cell: (info) => (
        <span>
          <Link
            class="block font-semibold underline"
            onClick={(event) => {
              event.preventDefault();
              window.location.assign(event.currentTarget.href);
            }}
            params={{ projectId: info.row.original.projectId }}
            to="/projects/$projectId"
          >
            {info.row.original.label}
          </Link>
          <span class="font-mono text-muted-foreground text-xs">{info.row.original.projectId}</span>
        </span>
      ),
    }),
    helper.accessor("projectState", {
      header: "Project state",
      cell: (info) => <Badge tone={tone(info.row.original.projectState)}>{info.getValue()}</Badge>,
    }),
    helper.accessor("factoryState", {
      header: "Factory",
      cell: (info) => <Badge tone={tone(info.row.original.factoryState)}>{info.getValue()}</Badge>,
    }),
    helper.accessor("location", {
      header: "Location",
      cell: (info) => <span class="font-mono text-xs">{info.getValue()}</span>,
    }),
  ]);

export const Projects = (): JSX.Element => {
  const projects = useProjects();
  const [filters, setFilters] = createSignal(filterFromUrl());
  const [selection, setSelection] = createSignal<RowSelectionState>(selectionFromUrl());
  const columns = projectColumns(selection, setSelection);
  const rows = createMemo(() => {
    const query = filters();
    const text = query.text.trim().toLocaleLowerCase();
    return (projects.data?.projects ?? []).filter(
      (project) =>
        (query.project === "all" || project.projectState === query.project) &&
        (query.factory === "all" || project.factoryState === query.factory) &&
        (text === "" ||
          `${project.label}\n${project.projectId}\n${project.location}`
            .toLocaleLowerCase()
            .includes(text)),
    );
  });

  createEffect(() => {
    const query = filters();
    const selected = selection();
    const url = new URL(window.location.href);
    url.search = "";
    if (query.text !== "") url.searchParams.set("q", query.text);
    if (query.project !== "all") url.searchParams.set("project", query.project);
    if (query.factory !== "all") url.searchParams.set("factory", query.factory);
    for (const projectId of Object.keys(selected).sort()) {
      url.searchParams.append("selected", projectId);
    }
    window.history.replaceState(window.history.state, "", url);
  });

  const table = createTable({
    features,
    columns,
    get data() {
      return rows();
    },
    getRowId: (project) => project.projectId,
    enableRowSelection: true,
    state: {
      get rowSelection() {
        return selection();
      },
    },
  });

  const filtered = () =>
    filters().text !== "" || filters().project !== "all" || filters().factory !== "all";

  return (
    <div class="mx-auto grid min-h-screen max-w-7xl gap-8 p-4 lg:grid-cols-[13rem_1fr] lg:p-8">
      <ConsoleNavigation current="Projects" />
      <main class="min-w-0">
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-muted-foreground text-sm">Project catalogue</p>
            <h1 class="font-semibold text-3xl">Projects</h1>
          </div>
          <Filters filters={filters()} onChange={setFilters} />
        </header>
        <Switch>
          <Match when={projects.isPending}>
            <p role="status">Reading fresh Project state…</p>
          </Match>
          <Match when={projects.data === undefined && projects.error instanceof ConsoleAccessError}>
            <section class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-5">
              <h2 class="font-semibold text-lg">Console access is required</h2>
              <p class="mt-2">
                Run <code>kojo ui</code> again.
              </p>
            </section>
          </Match>
          <Match when={projects.data === undefined && projects.error !== null}>
            <p role="alert">
              Project state is unavailable. Run <code>kojo daemon status</code>.
            </p>
          </Match>
          <Match when={projects.data}>
            {(snapshot) => (
              <>
                <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <p class="rounded-md bg-muted p-3 text-sm">
                    <strong>{snapshot().counts.total}</strong> total
                  </p>
                  <p class="rounded-md bg-muted p-3 text-sm">
                    <strong>{snapshot().counts.available}</strong> available
                  </p>
                  <p class="rounded-md bg-muted p-3 text-sm">
                    <strong>{snapshot().counts.missingFactories}</strong> missing Factory
                  </p>
                  <p class="rounded-md bg-muted p-3 text-sm">
                    <strong>{snapshot().counts.invalidFactories}</strong> invalid Factory
                  </p>
                </div>
                <DataGrid
                  matchedCount={rows().length}
                  recordCount={snapshot().counts.total}
                  selectedCount={Object.keys(selection()).length}
                >
                  <DataGridTable
                    emptyMessage={
                      filtered()
                        ? "No Projects match these filters."
                        : "No Projects are registered. Use `kojo project register`."
                    }
                    table={table}
                  />
                </DataGrid>
              </>
            )}
          </Match>
        </Switch>
      </main>
    </div>
  );
};
