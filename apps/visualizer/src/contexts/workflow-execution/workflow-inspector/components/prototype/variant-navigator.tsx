import {
  Activity,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Eye,
  FileArchive,
  FolderPlus,
  GitBranch,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
  Workflow,
  Zap,
} from "lucide-solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { projects, projectTone, schedules, stateTone } from "./prototype-data";
import type { WorkflowInspectorPrototypeModel } from "./prototype-types";

interface VariantNavigatorProps {
  model: WorkflowInspectorPrototypeModel;
}

const simulationSteps = [
  {
    event: "run.started",
    sequence: 18,
    summary: "Workflow Run accepted from the 14:15 occurrence",
    runState: "running",
  },
  {
    event: "activity.started",
    sequence: 19,
    summary: "Inspect repository began external work",
    runState: "running",
  },
  {
    event: "activity.completed",
    sequence: 20,
    summary: "Inspect repository recorded its durable result",
    runState: "running",
  },
  {
    event: "child.requested",
    sequence: 21,
    summary: "Review implementation started as an owned Child Workflow Run",
    runState: "running",
  },
  {
    event: "child.completed",
    sequence: 22,
    summary: "The Child Workflow Run completed",
    runState: "running",
  },
  {
    event: "run.recovered",
    sequence: 23,
    summary: "The Project Runtime recovered this run after a Host restart",
    runState: "running",
  },
  {
    event: "activity.replayed",
    sequence: 24,
    summary: "The recorded Activity result was reused; external work did not repeat",
    runState: "running",
  },
  {
    event: "run.suspended",
    sequence: 25,
    summary: "A durable developer approval wait suspended the run",
    runState: "suspended",
  },
] as const;

export function VariantNavigator(props: VariantNavigatorProps) {
  const [simulationStep, setSimulationStep] = createSignal(0);
  const [simulationPlaying, setSimulationPlaying] = createSignal(true);
  const currentSimulation = () => simulationSteps[simulationStep()];
  const rootRuns = () => props.model.runs().filter((run) => run.parentId === undefined);
  const childRuns = (parentId: string) =>
    props.model.runs().filter((run) => run.parentId === parentId);

  createEffect(() => {
    if (!simulationPlaying()) return;

    const timer = window.setInterval(() => {
      setSimulationStep((current) => {
        if (current === simulationSteps.length - 1) {
          setSimulationPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1600);

    onCleanup(() => window.clearInterval(timer));
  });

  const resetSimulation = () => {
    setSimulationPlaying(false);
    setSimulationStep(0);
  };

  const playSimulation = () => {
    if (simulationStep() === simulationSteps.length - 1) setSimulationStep(0);
    setSimulationPlaying(true);
  };

  return (
    <main class="min-h-screen bg-[#f4f3ef] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div class="grid min-h-screen grid-cols-[52px_260px_minmax(0,1fr)] pb-20">
        <aside class="flex flex-col items-center border-zinc-200 border-r bg-[#191c1b] py-3 text-white dark:border-zinc-800">
          <div class="grid size-8 place-items-center rounded-lg bg-emerald-400 font-heading font-semibold text-sm text-zinc-950">
            K
          </div>
          <nav class="mt-5 flex flex-1 flex-col gap-2" aria-label="Projects">
            <For each={projects}>
              {(project) => (
                <button
                  type="button"
                  aria-label={project.name}
                  onClick={() => props.model.selectProject(project.id)}
                  class={`relative grid size-8 place-items-center rounded-lg font-semibold text-[10px] transition ${
                    props.model.selectedProject() === project.id
                      ? "bg-white text-zinc-950 shadow-sm"
                      : "bg-white/7 text-zinc-400 hover:bg-white/12 hover:text-white"
                  }`}
                >
                  {project.name.slice(0, 2).toUpperCase()}
                  <span
                    class={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-[#191c1b] ${projectTone[project.condition]}`}
                  />
                </button>
              )}
            </For>
            <button
              type="button"
              aria-label="Add Kojo Project"
              onClick={props.model.showAddProject}
              class="grid size-8 place-items-center rounded-lg border border-white/15 border-dashed text-zinc-500 transition hover:border-white/30 hover:text-white"
            >
              <FolderPlus class="size-3.5" />
            </button>
          </nav>
          <div class="grid size-7 place-items-center rounded-full bg-emerald-400/15 font-bold text-[9px] text-emerald-300">
            KA
          </div>
        </aside>

        <aside class="border-zinc-200 border-r bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <header class="border-zinc-200 border-b px-3 py-3 dark:border-zinc-800">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-[9px] text-zinc-400 uppercase tracking-[0.16em]">Kojo Project</p>
                <h1 class="mt-0.5 font-heading font-semibold text-lg">Apollo</h1>
              </div>
              <span class="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-[9px] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                Ready
              </span>
            </div>
            <label class="mt-2 flex h-7 items-center gap-1.5 rounded-lg bg-zinc-100 px-2 text-zinc-400 dark:bg-zinc-800">
              <Search class="size-3" />
              <input
                class="min-w-0 flex-1 bg-transparent text-[10px] outline-none placeholder:text-zinc-400"
                placeholder="Find schedules or runs…"
              />
              <kbd class="rounded border border-zinc-200 bg-white px-1 py-0.5 text-[8px] dark:border-zinc-700 dark:bg-zinc-900">
                ⌘K
              </kbd>
            </label>
          </header>

          <div class="h-[calc(100vh-101px)] overflow-y-auto px-2 py-3">
            <section>
              <div class="mb-1 flex items-center justify-between px-2">
                <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                  Workflow Schedules
                </p>
                <span class="text-[9px] text-zinc-400">3</span>
              </div>
              <For each={schedules}>
                {(schedule) => (
                  <button
                    type="button"
                    class="mb-0.5 w-full rounded-lg px-2 py-2 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <div class="flex items-start gap-2">
                      <CalendarClock
                        class={`mt-0.5 size-3.5 ${schedule.condition === "needs-attention" ? "text-rose-500" : "text-emerald-600"}`}
                      />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center justify-between gap-2">
                          <span class="truncate font-semibold text-[10px]">{schedule.id}</span>
                          <span
                            class={`size-1.5 rounded-full ${props.model.isScheduleEnabled(schedule.id) ? "bg-emerald-500" : "bg-zinc-300"}`}
                          />
                        </div>
                        <p class="mt-0.5 truncate text-[9px] text-zinc-500">
                          {schedule.next ?? schedule.detail}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
              </For>
            </section>

            <section class="mt-3">
              <div class="mb-1 flex items-center justify-between px-2">
                <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                  Workflow Runs
                </p>
                <div class="flex items-center gap-2 text-[8px]">
                  <span class="text-zinc-400">
                    {rootRuns().length} roots · {props.model.runs().length} total
                  </span>
                  <span class="flex items-center gap-1 text-emerald-600">
                    <Radio class="size-2.5" /> Live
                  </span>
                </div>
              </div>
              <div>
                <For each={rootRuns()}>
                  {(run) => {
                    const children = () => childRuns(run.id);

                    return (
                      <div class="mb-0.5">
                        <button
                          type="button"
                          onClick={() => props.model.selectRun(run.id)}
                          class={`w-full rounded-lg px-2 py-2 text-left transition ${
                            props.model.selectedRun().id === run.id
                              ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950"
                              : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          }`}
                        >
                          <div class="flex items-center gap-1.5">
                            <Workflow class="size-3 shrink-0 text-zinc-400" />
                            <span class="min-w-0 flex-1 truncate font-semibold text-[10px]">
                              {run.workflow}
                            </span>
                            <span
                              class={`rounded-full px-1.5 py-0.5 text-[8px] ${props.model.selectedRun().id === run.id ? "bg-white/15 text-white dark:bg-zinc-950/10 dark:text-zinc-900" : stateTone[run.state]}`}
                            >
                              {run.state}
                            </span>
                          </div>
                          <div
                            class={`mt-1 flex items-center justify-between pl-[18px] text-[9px] ${props.model.selectedRun().id === run.id ? "text-zinc-400" : "text-zinc-500"}`}
                          >
                            <span class="font-mono">{run.id}</span>
                            <span>{run.started}</span>
                          </div>
                        </button>

                        <Show when={children().length > 0}>
                          <div class="relative ml-3 border-zinc-200 border-l pl-2 dark:border-zinc-700">
                            <For each={children()}>
                              {(child) => (
                                <div class="relative pt-0.5 before:absolute before:top-4 before:-left-2 before:h-px before:w-2 before:bg-zinc-200 dark:before:bg-zinc-700">
                                  <button
                                    type="button"
                                    onClick={() => props.model.selectRun(child.id)}
                                    class={`w-full rounded-lg px-2 py-1.5 text-left transition ${
                                      props.model.selectedRun().id === child.id
                                        ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950"
                                        : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                                    }`}
                                  >
                                    <div class="flex items-center gap-1.5">
                                      <GitBranch class="size-3 shrink-0 text-cyan-500" />
                                      <span class="min-w-0 flex-1 truncate font-semibold text-[9px]">
                                        {child.workflow}
                                      </span>
                                      <span
                                        class={`rounded-full px-1.5 py-0.5 text-[8px] ${props.model.selectedRun().id === child.id ? "bg-white/15 text-white dark:bg-zinc-950/10 dark:text-zinc-900" : stateTone[child.state]}`}
                                      >
                                        {child.state}
                                      </span>
                                    </div>
                                    <div
                                      class={`mt-1 flex items-center justify-between pl-[18px] text-[8px] ${props.model.selectedRun().id === child.id ? "text-zinc-400" : "text-zinc-500"}`}
                                    >
                                      <span class="font-mono">{child.id}</span>
                                      <span>child · {child.started}</span>
                                    </div>
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </section>
          </div>
        </aside>

        <section class="min-w-0 bg-[#f8f7f3] dark:bg-zinc-950">
          <header class="flex h-14 items-center justify-between border-zinc-200 border-b bg-white/75 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
            <div class="min-w-0">
              <div class="flex items-center gap-1 text-[9px] text-zinc-400">
                <span>Apollo</span>
                <ChevronRight class="size-2.5" />
                <span>Workflow Runs</span>
                <ChevronRight class="size-2.5" />
                <span class="font-mono">{props.model.selectedRun().id}</span>
              </div>
              <div class="mt-1 flex items-center gap-2">
                <h2 class="truncate font-heading font-semibold text-lg">
                  {props.model.selectedRun().workflow}
                </h2>
                <span
                  class={`rounded-full px-2 py-0.5 font-semibold text-[9px] ${stateTone[props.model.selectedRun().state]}`}
                >
                  {props.model.selectedRun().state}
                </span>
              </div>
            </div>
            <div class="flex items-center gap-1.5">
              <Show when={props.model.selectedRun().state === "suspended"}>
                <button
                  type="button"
                  onClick={props.model.requestResume}
                  class="flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2.5 font-semibold text-[10px] text-white hover:bg-emerald-500"
                >
                  <Play class="size-3" /> Resume same run
                </button>
              </Show>
              <Show when={props.model.selectedRun().state === "running"}>
                <button
                  type="button"
                  onClick={props.model.requestStop}
                  class="flex h-7 items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 font-semibold text-[10px] text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:bg-zinc-900"
                >
                  <Square class="size-3" /> Request stop
                </button>
              </Show>
              <button
                type="button"
                onClick={props.model.requestFreshStart}
                class="h-7 rounded-md border border-zinc-200 bg-white px-2.5 font-semibold text-[10px] hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
              >
                Start fresh…
              </button>
            </div>
          </header>

          <div class="grid h-[calc(100vh-56px)] grid-cols-[minmax(0,1fr)_264px] overflow-hidden max-[1239px]:grid-cols-1">
            <div class="min-w-0 overflow-auto px-4 py-3">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-[9px] text-zinc-400 uppercase tracking-[0.15em]">Run graph</p>
                  <p class="mt-0.5 text-[10px] text-zinc-500">
                    Durable relationships and replay evidence for this Workflow Run.
                  </p>
                </div>
                <span class="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                  <span class="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
                </span>
              </div>

              <div class="mx-auto mt-3 flex min-w-[560px] max-w-[780px] items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <div class="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                  <Radio class={`size-3.5 ${simulationPlaying() ? "animate-pulse" : ""}`} />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-[8px] text-emerald-700 uppercase tracking-[0.14em] dark:text-emerald-300">
                      Simulated live history
                    </span>
                    <span class="font-mono text-[9px] text-zinc-400">
                      #{currentSimulation().sequence}
                    </span>
                    <span class="truncate font-mono font-semibold text-[9px]">
                      {currentSimulation().event}
                    </span>
                  </div>
                  <p class="mt-0.5 truncate text-[9px] text-zinc-500">
                    {currentSimulation().summary}
                  </p>
                </div>
                <span class="shrink-0 text-[8px] text-zinc-400">
                  {simulationStep() + 1}/{simulationSteps.length}
                </span>
                <button
                  type="button"
                  aria-label={
                    simulationPlaying() ? "Pause live simulation" : "Play live simulation"
                  }
                  onClick={() =>
                    simulationPlaying() ? setSimulationPlaying(false) : playSimulation()
                  }
                  class="grid size-7 shrink-0 place-items-center rounded-md border border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <Show when={simulationPlaying()} fallback={<Play class="size-3" />}>
                    <Pause class="size-3" />
                  </Show>
                </button>
                <button
                  type="button"
                  aria-label="Reset live simulation"
                  onClick={resetSimulation}
                  class="grid size-7 shrink-0 place-items-center rounded-md border border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <RotateCcw class="size-3" />
                </button>
              </div>

              <div class="relative mx-auto mt-2 h-[520px] min-w-[560px] max-w-[780px] rounded-lg border border-zinc-200 bg-[radial-gradient(circle_at_1px_1px,rgba(113,113,122,0.14)_1px,transparent_0)] bg-[size:20px_20px] bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <Show when={simulationStep() >= 1}>
                  <div class="absolute top-[71px] left-1/2 h-16 w-px bg-zinc-300 transition-opacity dark:bg-zinc-700" />
                  <div class="absolute top-[135px] left-[17%] h-px w-[33%] bg-zinc-300 transition-opacity dark:bg-zinc-700" />
                  <div class="absolute top-[135px] left-[17%] h-10 w-px bg-zinc-300 transition-opacity dark:bg-zinc-700" />
                </Show>
                <Show when={simulationStep() >= 3}>
                  <div class="absolute top-[135px] left-1/2 h-10 w-px bg-zinc-300 transition-opacity dark:bg-zinc-700" />
                </Show>
                <Show when={simulationStep() >= 7}>
                  <div class="absolute top-[135px] left-1/2 h-px w-[33%] bg-zinc-300 transition-opacity dark:bg-zinc-700" />
                  <div class="absolute top-[135px] right-[17%] h-10 w-px bg-zinc-300 transition-opacity dark:bg-zinc-700" />
                </Show>

                <article class="absolute top-4 left-1/2 w-60 -translate-x-1/2 rounded-lg border border-sky-300 bg-sky-50 p-3 shadow-sm dark:border-sky-900 dark:bg-sky-950/30">
                  <div class="flex items-center gap-2">
                    <Workflow class="size-3.5 text-sky-600 dark:text-sky-300" />
                    <span class="min-w-0 flex-1 truncate font-semibold text-[10px]">
                      {props.model.selectedRun().workflow}
                    </span>
                    <span
                      class={`rounded-full px-1.5 py-0.5 text-[8px] ${stateTone[currentSimulation().runState]}`}
                    >
                      {currentSimulation().runState}
                    </span>
                  </div>
                  <p class="mt-1.5 font-mono text-[8px] text-zinc-500">
                    {props.model.selectedRun().id} · scheduled 14:15
                  </p>
                  <p class="mt-1 text-[9px] text-zinc-600 dark:text-zinc-400">
                    At event #{currentSimulation().sequence} · {currentSimulation().event}
                  </p>
                </article>

                <Show when={simulationStep() >= 1}>
                  <article class="fade-in zoom-in-95 absolute top-[174px] left-[3%] w-[29%] animate-in rounded-lg border border-zinc-200 bg-white p-2.5 shadow-sm duration-300 dark:border-zinc-700 dark:bg-zinc-950">
                    <div class="flex items-center gap-1.5">
                      <Activity class="size-3 text-violet-500" />
                      <span class="min-w-0 flex-1 truncate font-semibold text-[9px]">
                        Inspect repository
                      </span>
                      <Show
                        when={simulationStep() >= 2}
                        fallback={
                          <span class="size-1.5 animate-pulse rounded-full bg-violet-500" />
                        }
                      >
                        <CircleCheck class="size-3 text-emerald-500" />
                      </Show>
                    </div>
                    <p class="mt-1.5 text-[8px] text-violet-600 dark:text-violet-300">
                      {simulationStep() === 1
                        ? "External work running"
                        : simulationStep() >= 6
                          ? "Replayed durable result"
                          : "Durable result recorded"}
                    </p>
                    <p class="mt-1 truncate font-mono text-[8px] text-zinc-400">
                      activity.inspect-source
                    </p>
                  </article>
                </Show>

                <Show when={simulationStep() >= 3}>
                  <article class="fade-in zoom-in-95 absolute top-[174px] left-1/2 w-[29%] -translate-x-1/2 animate-in rounded-lg border border-zinc-200 bg-white p-2.5 shadow-sm duration-300 dark:border-zinc-700 dark:bg-zinc-950">
                    <div class="flex items-center gap-1.5">
                      <GitBranch class="size-3 text-cyan-600" />
                      <span class="min-w-0 flex-1 truncate font-semibold text-[9px]">
                        Review implementation
                      </span>
                      <Show
                        when={simulationStep() >= 4}
                        fallback={<span class="size-1.5 animate-pulse rounded-full bg-cyan-500" />}
                      >
                        <CircleCheck class="size-3 text-emerald-500" />
                      </Show>
                    </div>
                    <p class="mt-1.5 text-[8px] text-zinc-500">Child Workflow Run</p>
                    <p class="mt-1 truncate font-mono text-[8px] text-zinc-400">
                      run_7E9C.1 · {simulationStep() >= 4 ? "completed" : "running"}
                    </p>
                  </article>
                </Show>

                <Show when={simulationStep() >= 7}>
                  <article class="fade-in zoom-in-95 absolute top-[174px] right-[3%] w-[29%] animate-in rounded-lg border border-sky-300 bg-sky-50 p-2.5 shadow-sm duration-300 dark:border-sky-900 dark:bg-sky-950/30">
                    <div class="flex items-center gap-1.5">
                      <Zap class="size-3 text-sky-600 dark:text-sky-300" />
                      <span class="min-w-0 flex-1 truncate font-semibold text-[9px]">
                        Developer approval
                      </span>
                      <span class="size-1.5 animate-pulse rounded-full bg-sky-500" />
                    </div>
                    <p class="mt-1.5 text-[8px] text-sky-700 dark:text-sky-300">
                      Workflow Deferred incomplete
                    </p>
                    <p class="mt-1 font-mono text-[8px] text-zinc-400">manual resume required</p>
                  </article>
                </Show>

                <Show
                  when={simulationStep() >= 7}
                  fallback={
                    <div class="absolute right-3 bottom-3 left-3 rounded-lg border border-zinc-200 border-dashed bg-[#faf9f6] p-3 text-center text-[9px] text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950">
                      Lifecycle controls appear here when the run reaches an actionable state.
                    </div>
                  }
                >
                  <section class="fade-in absolute right-3 bottom-3 left-3 animate-in rounded-lg border border-zinc-200 bg-[#faf9f6] p-3 duration-300 dark:border-zinc-700 dark:bg-zinc-950">
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <p class="text-[8px] text-zinc-400 uppercase tracking-[0.14em]">
                          Decision point
                        </p>
                        <h3 class="mt-0.5 font-semibold text-[11px]">
                          Continue this durable run or create a new execution?
                        </h3>
                      </div>
                      <ShieldCheck class="size-3.5 text-emerald-600" />
                    </div>
                    <div class="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={props.model.requestResume}
                        class="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-left hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/30"
                      >
                        <p class="flex items-center gap-1 font-semibold text-[9px] text-emerald-800 dark:text-emerald-300">
                          <Play class="size-2.5" /> Resume {props.model.selectedRun().id}
                        </p>
                        <p class="mt-1 text-[8px] text-zinc-500">
                          Same identity; reuse durable Activity results.
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={props.model.requestFreshStart}
                        class="rounded-md border border-zinc-200 bg-white p-2 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <p class="flex items-center gap-1 font-semibold text-[9px]">
                          <Zap class="size-2.5" /> Start a fresh run
                        </p>
                        <p class="mt-1 text-[8px] text-zinc-500">
                          New identity; execute from the beginning.
                        </p>
                      </button>
                    </div>
                  </section>
                </Show>
              </div>
            </div>

            <aside class="overflow-y-auto border-zinc-200 border-l bg-white px-3 py-3 max-[1239px]:hidden dark:border-zinc-800 dark:bg-zinc-900">
              <section>
                <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                  Run context
                </p>
                <dl class="mt-2 grid grid-cols-2 gap-x-2 gap-y-2 text-[9px]">
                  <div>
                    <dt class="text-zinc-400">Trigger</dt>
                    <dd class="mt-0.5 flex items-center gap-1 font-medium">
                      <Clock3 class="size-2.5" /> {props.model.selectedRun().trigger}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-zinc-400">Revision</dt>
                    <dd class="mt-0.5 font-mono">eval-v24</dd>
                  </div>
                  <div>
                    <dt class="text-zinc-400">Graph</dt>
                    <dd class="mt-0.5 flex items-center gap-1 font-medium">
                      <GitBranch class="size-2.5" /> 1 child
                    </dd>
                  </div>
                  <div>
                    <dt class="text-zinc-400">Activities</dt>
                    <dd class="mt-0.5 font-medium">4 total</dd>
                  </div>
                </dl>
              </section>

              <section class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800">
                <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                  How to read the graph
                </p>
                <div class="mt-2 space-y-2 text-[9px]">
                  <div class="flex gap-2">
                    <Workflow class="mt-0.5 size-3 shrink-0 text-sky-600" />
                    <p>
                      <strong>Workflow Run</strong> — the durable root execution.
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <Activity class="mt-0.5 size-3 shrink-0 text-violet-500" />
                    <p>
                      <strong>Activity</strong> — external work with a recorded result.
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <GitBranch class="mt-0.5 size-3 shrink-0 text-cyan-600" />
                    <p>
                      <strong>Child Run</strong> — an owned run with its own trace.
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <Zap class="mt-0.5 size-3 shrink-0 text-sky-600" />
                    <p>
                      <strong>Deferred</strong> — an incomplete durable wait.
                    </p>
                  </div>
                </div>
                <p class="mt-2 text-[8px] text-zinc-400 leading-relaxed">
                  Lines show ownership, not time. The numbered event feed provides chronology.
                </p>
              </section>

              <section class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800">
                <div class="flex items-center justify-between">
                  <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                    Sensitive data
                  </p>
                  <ShieldCheck class="size-3 text-emerald-500" />
                </div>
                <div class="mt-2 rounded-lg bg-zinc-100 p-2 font-mono text-[9px] text-zinc-500 dark:bg-zinc-800">
                  input.apiToken&nbsp; ••••••••
                  <br />
                  input.repository&nbsp; ••••••••
                </div>
                <button
                  type="button"
                  onClick={props.model.requestReveal}
                  class="mt-1.5 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-zinc-200 font-semibold text-[9px] hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <Eye class="size-2.5" /> Reveal for this view…
                </button>
              </section>

              <section class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800">
                <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                  Execution Artifacts
                </p>
                <button
                  type="button"
                  onClick={() => props.model.requestDownload("review.patch")}
                  class="mt-2 flex w-full items-center gap-2 rounded-lg border border-zinc-200 p-2 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  <FileArchive class="size-3.5 text-zinc-400" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-semibold text-[9px]">review.patch</span>
                    <span class="text-[8px] text-zinc-400">42 KB · available</span>
                  </span>
                </button>
                <div class="mt-1.5 flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                  <CircleAlert class="size-3 shrink-0" />
                  <div>
                    <p class="font-semibold text-[9px]">transcript.json expired</p>
                    <p class="text-[8px] opacity-70">Trace remains complete.</p>
                  </div>
                </div>
              </section>

              <section class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800">
                <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                  Retention policy
                </p>
                <p class="mt-1.5 text-[9px] text-zinc-500">
                  Artifacts: 30 days / 5 GiB
                  <br />
                  Diagnostics: 14 days / 100 MiB
                </p>
                <p class="mt-1 text-[8px] text-zinc-400">Read-only here · manage with the CLI</p>
              </section>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}
