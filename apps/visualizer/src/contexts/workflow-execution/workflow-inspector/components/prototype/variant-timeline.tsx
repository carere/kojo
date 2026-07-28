import {
  CalendarClock,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Eye,
  FolderPlus,
  MoreHorizontal,
  Play,
  Radio,
  Search,
  SlidersHorizontal,
  Square,
  Workflow,
} from "lucide-solid";
import { For, Show } from "solid-js";
import { occurrences, projects, schedules, stateTone } from "./prototype-data";
import type { WorkflowInspectorPrototypeModel } from "./prototype-types";

interface VariantTimelineProps {
  model: WorkflowInspectorPrototypeModel;
}

export function VariantTimeline(props: VariantTimelineProps) {
  const featuredSchedule = schedules[0];

  return (
    <main class="min-h-screen bg-[#f6f1e7] pb-24 text-[#282a27] dark:bg-[#171814] dark:text-[#f5f3ec]">
      <header class="border-[#282a27]/10 border-b bg-[#fbf8f0] px-7 py-4 dark:border-white/10 dark:bg-[#1d1f1a]">
        <div class="flex items-center justify-between gap-6">
          <div class="flex items-center gap-8">
            <div class="flex items-center gap-2.5">
              <div class="grid size-8 place-items-center rounded-full bg-[#d7ff5c] font-bold font-heading text-[#1c2018]">
                K
              </div>
              <span class="font-heading font-semibold text-lg">Kojo</span>
            </div>
            <nav
              class="flex items-center gap-1 rounded-full border border-[#282a27]/10 bg-white/60 p-1 dark:border-white/10 dark:bg-white/5"
              aria-label="Project switcher"
            >
              <For each={projects}>
                {(project) => (
                  <button
                    type="button"
                    onClick={() => props.model.selectProject(project.id)}
                    class={`rounded-full px-3 py-1.5 font-semibold text-[11px] transition ${props.model.selectedProject() === project.id ? "bg-[#282a27] text-white dark:bg-[#d7ff5c] dark:text-[#1c2018]" : "text-[#686b64] hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5"}`}
                  >
                    {project.name}
                  </button>
                )}
              </For>
              <button
                type="button"
                onClick={props.model.showAddProject}
                class="grid size-7 place-items-center rounded-full text-[#777a72] hover:bg-black/5 dark:hover:bg-white/5"
                aria-label="Add Kojo Project"
              >
                <FolderPlus class="size-3.5" />
              </button>
            </nav>
          </div>
          <div class="flex items-center gap-2">
            <label class="flex h-8 w-52 items-center gap-2 rounded-full border border-[#282a27]/10 bg-white px-3 text-[#8d8f87] dark:border-white/10 dark:bg-white/5">
              <Search class="size-3.5" />
              <input
                class="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
                placeholder="Find anything"
              />
            </label>
            <span class="flex items-center gap-1.5 rounded-full bg-[#d7ff5c]/60 px-3 py-1.5 font-semibold text-[#355007] text-[10px] dark:bg-[#d7ff5c]/15 dark:text-[#d7ff5c]">
              <Radio class="size-3" /> Host live
            </span>
          </div>
        </div>
      </header>

      <section class="mx-auto max-w-[1500px] px-7 py-6">
        <div class="flex items-end justify-between gap-5">
          <div>
            <div class="flex items-center gap-2 font-semibold text-[#8c8d84] text-[10px] uppercase tracking-[0.18em]">
              <span>Apollo</span>
              <span>/</span>
              <span>Workflow schedule</span>
            </div>
            <h1 class="mt-2 font-heading font-semibold text-3xl tracking-tight">
              {featuredSchedule.id}
            </h1>
            <div class="mt-2 flex items-center gap-3 text-[#73756e] text-[11px]">
              <span>{featuredSchedule.workflow}</span>
              <span>·</span>
              <code>{featuredSchedule.expression}</code>
              <span>·</span>
              <span>{featuredSchedule.timeZone}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <div class="mr-3 text-right">
              <p class="text-[#8c8d84] text-[9px] uppercase tracking-[0.16em]">Next occurrence</p>
              <p class="mt-1 font-semibold text-sm">
                14:45 <span class="font-normal text-[#787a73]">· in 8 min</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => props.model.toggleSchedule(featuredSchedule.id)}
              class={`relative h-8 w-14 rounded-full p-1 transition ${props.model.isScheduleEnabled(featuredSchedule.id) ? "bg-[#282a27] dark:bg-[#d7ff5c]" : "bg-zinc-300 dark:bg-zinc-700"}`}
              aria-label="Toggle future occurrences"
            >
              <span
                class={`block size-6 rounded-full bg-white shadow transition ${props.model.isScheduleEnabled(featuredSchedule.id) ? "translate-x-6 dark:bg-[#282a27]" : "translate-x-0"}`}
              />
            </button>
            <span class="w-14 font-semibold text-[10px]">
              {props.model.isScheduleEnabled(featuredSchedule.id) ? "Enabled" : "Disabled"}
            </span>
            <button
              type="button"
              class="grid size-8 place-items-center rounded-full border border-[#282a27]/10 bg-white dark:border-white/10 dark:bg-white/5"
            >
              <MoreHorizontal class="size-4" />
            </button>
          </div>
        </div>

        <div class="mt-7 rounded-[28px] border border-[#282a27]/10 bg-[#fbf8f0] p-5 shadow-[0_20px_60px_rgba(48,47,40,0.06)] dark:border-white/10 dark:bg-[#1d1f1a]">
          <div class="flex items-center justify-between border-[#282a27]/10 border-b pb-4 dark:border-white/10">
            <div class="flex items-center gap-2">
              <CalendarClock class="size-4 text-[#668a21] dark:text-[#d7ff5c]" />
              <span class="font-semibold text-xs">Occurrence timeline</span>
              <span class="rounded-full bg-black/5 px-2 py-0.5 text-[#7b7d75] text-[9px] dark:bg-white/5">
                Today · local time
              </span>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full border border-[#282a27]/10 px-3 text-[10px] dark:border-white/10"
              >
                <SlidersHorizontal class="size-3" /> Outcomes
              </button>
              <button
                type="button"
                class="flex h-7 items-center gap-1 rounded-full border border-[#282a27]/10 px-3 text-[10px] dark:border-white/10"
              >
                Today <ChevronDown class="size-3" />
              </button>
            </div>
          </div>

          <div class="relative mt-7 grid grid-cols-4 gap-6 px-5 before:absolute before:top-[23px] before:right-[12.5%] before:left-[12.5%] before:h-px before:bg-[#282a27]/15 dark:before:bg-white/15">
            <For each={occurrences}>
              {(occurrence) => (
                <article class="relative text-center">
                  <p class="font-heading font-semibold text-lg">{occurrence.time}</p>
                  <div
                    class={`relative z-10 mx-auto mt-2 grid size-7 place-items-center rounded-full border-4 border-[#fbf8f0] dark:border-[#1d1f1a] ${occurrence.state === "planned" ? "bg-[#d7ff5c] text-[#26300c]" : occurrence.state === "skipped" ? "bg-amber-300 text-amber-950" : "bg-[#282a27] text-white dark:bg-zinc-100 dark:text-zinc-950"}`}
                  >
                    {occurrence.state === "started" ? (
                      <CircleCheck class="size-3" />
                    ) : occurrence.state === "skipped" ? (
                      <CircleAlert class="size-3" />
                    ) : (
                      <Clock3 class="size-3" />
                    )}
                  </div>
                  <p class="mt-2 font-semibold text-[#8a8c83] text-[9px] uppercase tracking-[0.12em]">
                    {occurrence.state}
                  </p>
                  <Show
                    when={occurrence.run}
                    fallback={
                      <div class="mt-4 min-h-24 rounded-2xl border border-[#282a27]/15 border-dashed bg-white/30 p-3 text-left dark:border-white/15 dark:bg-white/3">
                        <p class="text-[#777a72] text-[10px]">{occurrence.note}</p>
                        <Show when={occurrence.state === "planned"}>
                          <p class="mt-2 text-[#999b93] text-[9px]">
                            A Workflow Run appears only after this occurrence is accepted.
                          </p>
                        </Show>
                      </div>
                    }
                  >
                    <button
                      type="button"
                      onClick={() => occurrence.run && props.model.selectRun(occurrence.run)}
                      class="mt-4 w-full rounded-2xl border border-[#282a27]/10 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/10 dark:bg-white/5"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-mono font-semibold text-[10px]">{occurrence.run}</span>
                        <span
                          class={`rounded-full px-2 py-0.5 text-[9px] ${stateTone[(occurrence.runState ?? "running") as keyof typeof stateTone]}`}
                        >
                          {occurrence.runState}
                        </span>
                      </div>
                      <p class="mt-2 text-[#696b65] text-[10px] dark:text-zinc-400">
                        {occurrence.note}
                      </p>
                      <p class="mt-2 flex items-center gap-1 font-semibold text-[#668a21] text-[9px] dark:text-[#d7ff5c]">
                        <Workflow class="size-3" /> Open linked Workflow Run
                      </p>
                    </button>
                  </Show>
                </article>
              )}
            </For>
          </div>
        </div>

        <div class="mt-6 grid grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)] gap-6">
          <section class="rounded-[28px] border border-[#282a27]/10 bg-[#fbf8f0] p-5 dark:border-white/10 dark:bg-[#1d1f1a]">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-[#8c8d84] text-[10px] uppercase tracking-[0.16em]">
                  Selected Workflow Run
                </p>
                <div class="mt-1 flex items-center gap-2">
                  <h2 class="font-heading font-semibold text-xl">
                    {props.model.selectedRun().workflow}
                  </h2>
                  <span
                    class={`rounded-full px-2.5 py-1 text-[9px] ${stateTone[props.model.selectedRun().state]}`}
                  >
                    {props.model.selectedRun().state}
                  </span>
                </div>
              </div>
              <code class="text-[#888a82] text-[10px]">{props.model.selectedRun().id}</code>
            </div>
            <div class="mt-5 grid grid-cols-[180px_minmax(0,1fr)] gap-5">
              <div class="space-y-2">
                <button
                  type="button"
                  class="w-full rounded-xl bg-[#282a27] px-3 py-2.5 text-left font-semibold text-[10px] text-white dark:bg-[#d7ff5c] dark:text-[#1c2018]"
                >
                  Run summary
                </button>
                <button
                  type="button"
                  class="w-full rounded-xl px-3 py-2.5 text-left text-[#72746d] text-[10px] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Execution Trace
                </button>
                <button
                  type="button"
                  class="w-full rounded-xl px-3 py-2.5 text-left text-[#72746d] text-[10px] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Child runs & Activities
                </button>
                <button
                  type="button"
                  class="w-full rounded-xl px-3 py-2.5 text-left text-[#72746d] text-[10px] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Data & Artifacts
                </button>
              </div>
              <div>
                <div class="rounded-2xl bg-[#f0ece1] p-4 dark:bg-white/5">
                  <p class="text-[#8a8c83] text-[9px] uppercase tracking-[0.15em]">
                    Current situation
                  </p>
                  <p class="mt-2 font-semibold text-sm">{props.model.selectedRun().detail}</p>
                  <p class="mt-2 text-[#6f716a] text-[10px] leading-5 dark:text-zinc-400">
                    Recovered at 14:36, replayed three completed Activities, then suspended for a
                    developer decision. “Recovered” is trace evidence, not another run state.
                  </p>
                </div>
                <div class="mt-3 flex flex-wrap gap-2">
                  <Show when={props.model.selectedRun().state === "suspended"}>
                    <button
                      type="button"
                      onClick={props.model.requestResume}
                      class="flex h-8 items-center gap-1.5 rounded-full bg-[#282a27] px-4 font-semibold text-[10px] text-white dark:bg-[#d7ff5c] dark:text-[#1c2018]"
                    >
                      <Play class="size-3" /> Resume this run
                    </button>
                  </Show>
                  <Show when={props.model.selectedRun().state === "running"}>
                    <button
                      type="button"
                      onClick={props.model.requestStop}
                      class="flex h-8 items-center gap-1.5 rounded-full bg-rose-100 px-4 font-semibold text-[10px] text-rose-700 dark:bg-rose-400/10 dark:text-rose-300"
                    >
                      <Square class="size-3" /> Request stop
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={props.model.requestFreshStart}
                    class="h-8 rounded-full border border-[#282a27]/15 px-4 font-semibold text-[10px] dark:border-white/15"
                  >
                    Start a fresh run…
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside class="rounded-[28px] border border-[#282a27]/10 bg-[#282a27] p-5 text-white dark:border-white/10 dark:bg-[#292b25]">
            <div class="flex items-center justify-between">
              <p class="text-[10px] text-white/45 uppercase tracking-[0.16em]">Inspection safety</p>
              <Eye class="size-4 text-[#d7ff5c]" />
            </div>
            <h2 class="mt-3 font-heading font-semibold text-xl">Masked by default</h2>
            <p class="mt-2 text-[10px] text-white/55 leading-5">
              Inputs, results, resume values, transcripts, and Artifact contents remain hidden until
              a one-view reveal.
            </p>
            <div class="mt-4 rounded-2xl bg-black/20 p-3 font-mono text-[10px] text-white/45">
              repository&nbsp;&nbsp;••••••••
              <br />
              apiToken&nbsp;&nbsp;&nbsp;••••••••
            </div>
            <button
              type="button"
              onClick={props.model.requestReveal}
              class="mt-3 w-full rounded-full bg-[#d7ff5c] py-2 font-bold text-[#1c2018] text-[10px]"
            >
              Review warning & reveal…
            </button>
            <div class="mt-5 border-white/10 border-t pt-4">
              <p class="font-semibold text-[10px]">Execution Data Retention Policy</p>
              <p class="mt-1 text-[9px] text-white/45 leading-4">
                Artifacts 30 days / 5 GiB · read-only in the visualizer. Destructive controls remain
                in the CLI.
              </p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
