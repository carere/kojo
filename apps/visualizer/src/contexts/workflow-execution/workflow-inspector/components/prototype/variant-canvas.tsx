import {
  Activity,
  Boxes,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Database,
  Download,
  Eye,
  FileArchive,
  FolderPlus,
  GitBranch,
  Play,
  Radio,
  Search,
  ShieldAlert,
  Square,
  Workflow,
  Zap,
} from "lucide-solid";
import { For, Show } from "solid-js";
import { projects, schedules, stateTone, traceEvents } from "./prototype-data";
import type { WorkflowInspectorPrototypeModel } from "./prototype-types";

interface VariantCanvasProps {
  model: WorkflowInspectorPrototypeModel;
}

export function VariantCanvas(props: VariantCanvasProps) {
  return (
    <main class="min-h-screen bg-[#0c1016] pb-24 text-slate-100">
      <header class="flex h-14 items-center justify-between border-white/8 border-b bg-[#0f141c] px-5">
        <div class="flex items-center gap-5">
          <div class="flex items-center gap-2">
            <div class="grid size-7 place-items-center rounded-lg bg-cyan-300 font-bold font-heading text-slate-950">
              K
            </div>
            <span class="font-heading font-semibold">Kojo</span>
          </div>
          <span class="h-5 w-px bg-white/10" />
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg px-2 py-1.5 font-semibold text-xs hover:bg-white/5"
          >
            <span class="size-2 rounded-full bg-emerald-400" /> Apollo{" "}
            <ChevronRight class="size-3 rotate-90 text-slate-500" />
          </button>
        </div>
        <div class="flex items-center gap-2">
          <label class="flex h-8 w-64 items-center gap-2 rounded-lg border border-white/8 bg-white/4 px-3 text-slate-500">
            <Search class="size-3.5" />
            <input
              class="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
              placeholder="Jump to a run, schedule, event…"
            />
            <kbd class="text-[9px]">⌘K</kbd>
          </label>
          <button
            type="button"
            onClick={props.model.showAddProject}
            class="flex h-8 items-center gap-1.5 rounded-lg border border-white/8 px-3 font-semibold text-[10px] hover:bg-white/5"
          >
            <FolderPlus class="size-3.5" /> Add project
          </button>
        </div>
      </header>

      <div class="grid h-[calc(100vh-56px)] min-h-[720px] grid-cols-[240px_minmax(620px,1fr)_340px] overflow-hidden">
        <aside class="overflow-y-auto border-white/8 border-r bg-[#0f141c] p-3">
          <p class="px-2 py-2 font-semibold text-[9px] text-slate-600 uppercase tracking-[0.18em]">
            Project graph
          </p>
          <For each={projects}>
            {(project) => (
              <button
                type="button"
                onClick={() => props.model.selectProject(project.id)}
                class={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${props.model.selectedProject() === project.id ? "bg-cyan-300/10 text-cyan-200" : "text-slate-400 hover:bg-white/4"}`}
              >
                <Boxes class="size-3.5" />
                <span class="min-w-0 flex-1 truncate font-semibold text-[11px]">
                  {project.name}
                </span>
                <span
                  class={`size-1.5 rounded-full ${project.condition === "ready" ? "bg-emerald-400" : project.condition === "limited" ? "bg-amber-400" : "bg-rose-400"}`}
                />
              </button>
            )}
          </For>

          <div class="my-3 h-px bg-white/8" />
          <p class="px-2 py-2 font-semibold text-[9px] text-slate-600 uppercase tracking-[0.18em]">
            Workflow Definitions
          </p>
          <div class="rounded-lg bg-white/4 p-1">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md bg-white/7 px-2.5 py-2 text-left text-cyan-100"
            >
              <Workflow class="size-3.5" />
              <span class="min-w-0 flex-1 truncate font-semibold text-[11px]">
                Evaluate release
              </span>
              <ChevronRight class="size-3 text-slate-500" />
            </button>
            <div class="ml-4 border-white/8 border-l py-1 pl-2">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-slate-400 hover:bg-white/5"
              >
                <CalendarClock class="size-3" /> nightly-evaluate
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-slate-400 hover:bg-white/5"
              >
                <CalendarClock class="size-3" /> release-audit
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-slate-400 hover:bg-white/5"
              >
                <Activity class="size-3" /> Workflow Runs{" "}
                <span class="ml-auto rounded-full bg-white/7 px-1.5 text-[9px]">8</span>
              </button>
            </div>
          </div>
          <button
            type="button"
            class="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-slate-400 hover:bg-white/4"
          >
            <Workflow class="size-3.5" />
            <span class="font-semibold text-[11px]">Review dependencies</span>
          </button>

          <div class="my-3 h-px bg-white/8" />
          <p class="px-2 py-2 font-semibold text-[9px] text-slate-600 uppercase tracking-[0.18em]">
            Schedules
          </p>
          <For each={schedules}>
            {(schedule) => (
              <div class="mb-1 rounded-lg px-2.5 py-2 hover:bg-white/4">
                <div class="flex items-center gap-2">
                  <span
                    class={`size-1.5 rounded-full ${props.model.isScheduleEnabled(schedule.id) ? "bg-emerald-400" : "bg-slate-600"}`}
                  />
                  <span class="min-w-0 flex-1 truncate font-semibold text-[10px] text-slate-300">
                    {schedule.id}
                  </span>
                  <button
                    type="button"
                    onClick={() => props.model.toggleSchedule(schedule.id)}
                    class="text-[9px] text-slate-500 hover:text-white"
                  >
                    {props.model.isScheduleEnabled(schedule.id) ? "disable" : "enable"}
                  </button>
                </div>
                <p class="mt-1 pl-3.5 text-[9px] text-slate-600">
                  {schedule.next ?? schedule.condition}
                </p>
              </div>
            )}
          </For>
        </aside>

        <section class="relative min-w-0 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,0.11)_1px,transparent_0)] bg-[size:22px_22px] p-6">
          <div class="flex items-start justify-between">
            <div>
              <div class="flex items-center gap-2 text-[9px] text-slate-600 uppercase tracking-[0.16em]">
                <span>Apollo</span>
                <ChevronRight class="size-3" />
                <span>Evaluate release</span>
                <ChevronRight class="size-3" />
                <span class="font-mono">{props.model.selectedRun().id}</span>
              </div>
              <div class="mt-2 flex items-center gap-2">
                <h1 class="font-heading font-semibold text-2xl">Run graph</h1>
                <span
                  class={`rounded-full px-2.5 py-1 text-[9px] ${stateTone[props.model.selectedRun().state]}`}
                >
                  {props.model.selectedRun().state}
                </span>
              </div>
              <p class="mt-1 text-[10px] text-slate-500">
                Durable relationships, replay evidence, and live boundaries in one canvas.
              </p>
            </div>
            <div class="flex items-center gap-2">
              <span class="flex items-center gap-1.5 rounded-lg border border-emerald-400/15 bg-emerald-400/8 px-2.5 py-1.5 text-[9px] text-emerald-300">
                <Radio class="size-3" /> Live events
              </span>
              <Show when={props.model.selectedRun().state === "suspended"}>
                <button
                  type="button"
                  onClick={props.model.requestResume}
                  class="flex h-8 items-center gap-1.5 rounded-lg bg-cyan-300 px-3 font-bold text-[10px] text-slate-950"
                >
                  <Play class="size-3" /> Resume same run
                </button>
              </Show>
              <Show when={props.model.selectedRun().state === "running"}>
                <button
                  type="button"
                  onClick={props.model.requestStop}
                  class="flex h-8 items-center gap-1.5 rounded-lg bg-rose-400/10 px-3 font-bold text-[10px] text-rose-300"
                >
                  <Square class="size-3" /> Request stop
                </button>
              </Show>
            </div>
          </div>

          <div class="relative mx-auto mt-12 h-[470px] max-w-[800px]">
            <div class="absolute top-12 left-1/2 h-px w-40 -translate-x-1/2 bg-cyan-300/35" />
            <div class="absolute top-12 left-1/2 h-24 w-px bg-cyan-300/35" />
            <div class="absolute top-[147px] left-[25%] h-px w-1/2 bg-white/15" />
            <div class="absolute top-[147px] left-[25%] h-12 w-px bg-white/15" />
            <div class="absolute top-[147px] right-[25%] h-12 w-px bg-white/15" />
            <div class="absolute top-0 left-1/2 w-72 -translate-x-1/2 rounded-2xl border border-cyan-300/30 bg-[#101b25] p-4 shadow-[0_0_40px_rgba(103,232,249,0.08)]">
              <div class="flex items-center justify-between">
                <span class="flex items-center gap-2 font-semibold text-[11px]">
                  <Workflow class="size-4 text-cyan-300" /> Evaluate release
                </span>
                <span class="rounded-full bg-sky-400/10 px-2 py-0.5 text-[9px] text-sky-300">
                  suspended
                </span>
              </div>
              <p class="mt-2 font-mono text-[9px] text-slate-500">run_7E9C · scheduled 14:15</p>
              <p class="mt-2 text-[9px] text-slate-400">
                Recovered → replayed → waiting for approval
              </p>
            </div>

            <div class="absolute top-[196px] left-[8%] w-56 rounded-2xl border border-white/10 bg-[#111720] p-3.5">
              <div class="flex items-center gap-2">
                <Activity class="size-3.5 text-violet-300" />
                <span class="font-semibold text-[10px]">Inspect repository</span>
                <CircleCheck class="ml-auto size-3.5 text-emerald-400" />
              </div>
              <p class="mt-2 text-[9px] text-violet-300">Replayed durable result</p>
              <p class="mt-1 font-mono text-[8px] text-slate-600">activity.inspect-source</p>
            </div>
            <div class="absolute top-[196px] left-1/2 w-56 -translate-x-1/2 rounded-2xl border border-white/10 bg-[#111720] p-3.5">
              <div class="flex items-center gap-2">
                <GitBranch class="size-3.5 text-cyan-300" />
                <span class="font-semibold text-[10px]">Review implementation</span>
                <CircleCheck class="ml-auto size-3.5 text-emerald-400" />
              </div>
              <p class="mt-2 text-[9px] text-slate-400">Child Workflow Run</p>
              <p class="mt-1 font-mono text-[8px] text-slate-600">run_7E9C.1 · completed</p>
            </div>
            <div class="absolute top-[196px] right-[8%] w-56 rounded-2xl border border-sky-300/25 bg-[#111b26] p-3.5 shadow-[0_0_32px_rgba(125,211,252,0.06)]">
              <div class="flex items-center gap-2">
                <Zap class="size-3.5 text-sky-300" />
                <span class="font-semibold text-[10px]">Developer approval</span>
                <span class="ml-auto size-1.5 animate-pulse rounded-full bg-sky-300" />
              </div>
              <p class="mt-2 text-[9px] text-sky-300">Workflow Deferred incomplete</p>
              <p class="mt-1 font-mono text-[8px] text-slate-600">manual resume required</p>
            </div>

            <div class="absolute bottom-7 left-1/2 w-[560px] -translate-x-1/2 rounded-2xl border border-white/8 bg-[#0e141c]/95 p-4 backdrop-blur">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-[9px] text-slate-600 uppercase tracking-[0.15em]">
                    Decision point
                  </p>
                  <h2 class="mt-1 font-semibold text-xs">
                    Continue durable work or create a new execution?
                  </h2>
                </div>
                <ShieldAlert class="size-4 text-amber-300" />
              </div>
              <div class="mt-3 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={props.model.requestResume}
                  class="rounded-xl border border-cyan-300/25 bg-cyan-300/8 p-3 text-left hover:bg-cyan-300/12"
                >
                  <p class="flex items-center gap-1.5 font-semibold text-[10px] text-cyan-200">
                    <Play class="size-3" /> Resume run_7E9C
                  </p>
                  <p class="mt-1 text-[9px] text-slate-500 leading-4">
                    Same identity. Reuses completed Activities and continues from suspension.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={props.model.requestFreshStart}
                  class="rounded-xl border border-white/10 p-3 text-left hover:bg-white/4"
                >
                  <p class="flex items-center gap-1.5 font-semibold text-[10px]">
                    <Zap class="size-3" /> Start a fresh run
                  </p>
                  <p class="mt-1 text-[9px] text-slate-500 leading-4">
                    New identity. Starts the Workflow Definition from the beginning.
                  </p>
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside class="overflow-y-auto border-white/8 border-l bg-[#0f141c]">
          <div class="border-white/8 border-b p-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-[9px] text-slate-600 uppercase tracking-[0.16em]">
                Inspector
              </p>
              <code class="text-[9px] text-slate-600">seq 21</code>
            </div>
            <div class="mt-3 grid grid-cols-3 rounded-lg bg-white/4 p-1 text-[9px]">
              <button type="button" class="rounded-md bg-white/8 py-1.5 font-semibold text-white">
                Events
              </button>
              <button type="button" class="py-1.5 text-slate-500">
                Data
              </button>
              <button type="button" class="py-1.5 text-slate-500">
                Artifacts
              </button>
            </div>
          </div>
          <div class="p-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-[10px]">Execution Trace</p>
              <span class="flex items-center gap-1 text-[9px] text-emerald-300">
                <span class="size-1.5 animate-pulse rounded-full bg-emerald-400" /> following
              </span>
            </div>
            <div class="mt-4 space-y-4">
              <For each={traceEvents}>
                {(event) => (
                  <article class="grid grid-cols-[30px_1fr] gap-2">
                    <div class="relative">
                      <span class="grid size-6 place-items-center rounded-full border border-white/10 bg-white/5 font-mono text-[8px] text-slate-500">
                        {event.sequence}
                      </span>
                      <span class="absolute top-6 bottom-[-18px] left-3 w-px bg-white/8" />
                    </div>
                    <div>
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-mono text-[9px] text-cyan-200">{event.kind}</span>
                        <time class="font-mono text-[8px] text-slate-700">{event.time}</time>
                      </div>
                      <p class="mt-1 font-medium text-[10px] text-slate-300">{event.title}</p>
                      <p class="mt-1 text-[9px] text-slate-600 leading-4">{event.detail}</p>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </div>

          <section class="mx-4 mt-2 rounded-xl border border-white/8 bg-white/3 p-3">
            <div class="flex items-center justify-between">
              <p class="flex items-center gap-1.5 font-semibold text-[10px]">
                <Eye class="size-3 text-amber-300" /> Sensitive data
              </p>
              <span class="text-[8px] text-slate-600 uppercase tracking-[0.12em]">masked</span>
            </div>
            <p class="mt-2 font-mono text-[9px] text-slate-600">input.repository = ••••••••</p>
            <button
              type="button"
              onClick={props.model.requestReveal}
              class="mt-2 w-full rounded-lg border border-amber-300/15 py-1.5 font-semibold text-[9px] text-amber-200 hover:bg-amber-300/5"
            >
              Warn before reveal
            </button>
          </section>

          <section class="mx-4 mt-3 rounded-xl border border-white/8 bg-white/3 p-3">
            <p class="flex items-center gap-1.5 font-semibold text-[10px]">
              <FileArchive class="size-3 text-cyan-300" /> Execution Artifacts
            </p>
            <button
              type="button"
              onClick={() => props.model.requestDownload("review.patch")}
              class="mt-2 flex w-full items-center gap-2 rounded-lg bg-white/4 p-2 text-left hover:bg-white/7"
            >
              <Download class="size-3 text-slate-500" />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-semibold text-[9px]">review.patch</span>
                <span class="text-[8px] text-slate-600">attachment · 42 KB</span>
              </span>
            </button>
            <div class="mt-2 flex items-start gap-2 rounded-lg bg-amber-300/5 p-2 text-amber-200">
              <CircleAlert class="mt-0.5 size-3 shrink-0" />
              <div>
                <p class="font-semibold text-[9px]">transcript.json expired</p>
                <p class="mt-0.5 text-[8px] text-slate-600">Metadata and trace reference remain.</p>
              </div>
            </div>
          </section>

          <section class="mx-4 mt-3 mb-6 rounded-xl border border-white/8 bg-white/3 p-3">
            <p class="flex items-center gap-1.5 font-semibold text-[10px]">
              <Database class="size-3 text-violet-300" /> Retention policy
            </p>
            <p class="mt-2 text-[9px] text-slate-500 leading-4">
              Artifacts: 30 days / 5 GiB
              <br />
              Diagnostics: 14 days / 100 MiB
            </p>
            <p class="mt-2 text-[8px] text-slate-700">
              Inspection only. No destructive controls here.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
