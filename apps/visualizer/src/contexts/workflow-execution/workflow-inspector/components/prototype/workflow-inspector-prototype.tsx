import { CircleAlert, EyeOff, FolderPlus, ShieldAlert, X } from "lucide-solid";
import { createMemo, createSignal, Show } from "solid-js";
import { initialRuns, type PrototypeRun, schedules } from "./prototype-data";
import { PrototypeSwitcher, type PrototypeVariant } from "./prototype-switcher";
import type { WorkflowInspectorPrototypeModel } from "./prototype-types";
import { VariantCanvas } from "./variant-canvas";
import { VariantNavigator } from "./variant-navigator";
import { VariantTimeline } from "./variant-timeline";

// Three variants of the workflow inspector, switchable via ?variant=, on the existing / route.

type DialogKind = "add-project" | "fresh-start" | "reveal" | "stop" | null;

interface WorkflowInspectorPrototypeProps {
  variant: PrototypeVariant;
  showSwitcher: boolean;
  onVariantChange: (variant: PrototypeVariant) => void;
}

export function WorkflowInspectorPrototype(props: WorkflowInspectorPrototypeProps) {
  const [selectedProject, setSelectedProject] = createSignal("apollo");
  const [selectedRunId, setSelectedRunId] = createSignal("run_7E9C");
  const [runs, setRuns] = createSignal<ReadonlyArray<PrototypeRun>>(initialRuns);
  const [scheduleStates, setScheduleStates] = createSignal<Record<string, boolean>>(
    Object.fromEntries(schedules.map((schedule) => [schedule.id, schedule.enabled])),
  );
  const [dialog, setDialog] = createSignal<DialogKind>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [revealed, setRevealed] = createSignal(false);

  const selectedRun = createMemo(
    () => runs().find((run) => run.id === selectedRunId()) ?? runs()[0],
  );

  const updateSelectedRun = (update: (run: PrototypeRun) => PrototypeRun) => {
    setRuns((current) => current.map((run) => (run.id === selectedRunId() ? update(run) : run)));
  };

  const model: WorkflowInspectorPrototypeModel = {
    selectedProject,
    selectProject: (projectId) => {
      setSelectedProject(projectId);
      setNotice(`Switched to ${projectId}. Each Project keeps its own authoritative snapshots.`);
    },
    selectedRun,
    selectRun: (runId) => setSelectedRunId(runId),
    runs,
    isScheduleEnabled: (scheduleId) => scheduleStates()[scheduleId] ?? false,
    toggleSchedule: (scheduleId) => {
      const wasEnabled = scheduleStates()[scheduleId] ?? false;
      setScheduleStates((current) => ({ ...current, [scheduleId]: !wasEnabled }));
      setNotice(
        wasEnabled
          ? `${scheduleId}: future occurrences disabled. Already-created Workflow Runs continue.`
          : `${scheduleId}: enable requested against the observed schedule revision.`,
      );
    },
    requestResume: () => {
      if (selectedRun().state !== "suspended") {
        setNotice(`${selectedRun().id} cannot resume from ${selectedRun().state}.`);
        return;
      }
      updateSelectedRun((run) => ({
        ...run,
        state: "running",
        detail: "Resume accepted · replaying the same durable execution",
      }));
      setNotice(
        `${selectedRun().id} resumed under the same identity; completed Activities remain reusable.`,
      );
    },
    requestFreshStart: () => setDialog("fresh-start"),
    requestStop: () => setDialog("stop"),
    requestReveal: () => setDialog("reveal"),
    requestDownload: (name) =>
      setNotice(`${name} is downloading as an attachment after Project, Run, and Artifact checks.`),
    showAddProject: () => setDialog("add-project"),
  };

  const confirmFreshStart = () => {
    const freshRun: PrototypeRun = {
      id: "run_7F44",
      workflow: selectedRun().workflow,
      state: "running",
      trigger: "manual",
      started: "now",
      detail: "Fresh manual start · new durable execution",
    };
    setRuns((current) => [freshRun, ...current]);
    setSelectedRunId(freshRun.id);
    setDialog(null);
    setNotice(
      `${freshRun.id} started from the beginning with a new identity and the observed definition revision.`,
    );
  };

  const confirmStop = () => {
    updateSelectedRun((run) => ({
      ...run,
      state: "stopping",
      detail: "Stop intent accepted · safe cleanup in progress",
    }));
    setDialog(null);
    setNotice(
      `${selectedRun().id} is stopping. New forward work is blocked while required cleanup finishes.`,
    );
  };

  const confirmReveal = () => {
    setRevealed(true);
    setDialog(null);
    setNotice(
      "Sensitive data revealed only for this in-memory view; arbitrary content may still contain secrets.",
    );
  };

  return (
    <>
      <Show when={props.variant === "A"}>
        <VariantNavigator model={model} />
      </Show>
      <Show when={props.variant === "B"}>
        <VariantTimeline model={model} />
      </Show>
      <Show when={props.variant === "C"}>
        <VariantCanvas model={model} />
      </Show>

      <Show when={notice()}>
        <div class="fixed top-3 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-lg border border-emerald-300/30 bg-emerald-950 px-3 py-2 text-emerald-50 shadow-2xl">
          <CircleAlert class="mt-0.5 size-4 shrink-0 text-emerald-300" />
          <p class="text-[11px] leading-5">{notice()}</p>
          <button
            type="button"
            aria-label="Dismiss notice"
            class="ml-2 text-emerald-300/60 hover:text-emerald-100"
            onClick={() => setNotice(null)}
          >
            <X class="size-3.5" />
          </button>
        </div>
      </Show>

      <Show when={revealed()}>
        <aside class="fixed right-4 bottom-20 z-40 w-80 rounded-lg border border-amber-300/30 bg-[#241d0d] p-3 text-amber-50 shadow-2xl">
          <div class="flex items-center justify-between">
            <p class="flex items-center gap-2 font-semibold text-[10px]">
              <ShieldAlert class="size-4 text-amber-300" /> Sensitive values revealed
            </p>
            <button
              type="button"
              aria-label="Mask sensitive values"
              onClick={() => setRevealed(false)}
              class="text-amber-300/60 hover:text-amber-100"
            >
              <X class="size-3.5" />
            </button>
          </div>
          <div class="mt-3 rounded-lg bg-black/20 p-3 font-mono text-[10px] text-amber-100/80 leading-5">
            repository = carere/kojo
            <br />
            apiToken = sk-prototype-value
          </div>
          <button
            type="button"
            onClick={() => setRevealed(false)}
            class="mt-2 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-amber-300/20 font-semibold text-[9px]"
          >
            <EyeOff class="size-3" /> Mask again
          </button>
        </aside>
      </Show>

      <Show when={dialog()}>
        <div
          class="fixed inset-0 z-[60] grid place-items-center bg-black/65 p-4 backdrop-blur-sm"
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            class="w-full max-w-md rounded-lg border border-white/10 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
          >
            <Show when={dialog() === "add-project"}>
              <div class="flex items-center gap-2">
                <FolderPlus class="size-5 text-emerald-300" />
                <h2 class="font-heading font-semibold text-lg">Add a Kojo Project</h2>
              </div>
              <p class="mt-2 text-[11px] text-zinc-400 leading-5">
                Choose an already-initialized Git working tree. The Host validates its canonical
                path, Project Identity, and layout before adding it.
              </p>
              <label class="mt-4 block font-semibold text-[10px] text-zinc-400">
                Project path
                <input
                  class="mt-2 h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 font-mono text-[11px] text-white outline-none focus:border-emerald-300/40"
                  value="~/work/helios"
                />
              </label>
              <div class="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  class="h-7 rounded-md px-2.5 font-semibold text-[9px] text-zinc-400"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDialog(null);
                    setNotice(
                      "Helios submitted to the Host for validation and Project Index registration.",
                    );
                  }}
                  class="h-7 rounded-md bg-emerald-300 px-3 font-bold text-[9px] text-zinc-950"
                >
                  Validate & add
                </button>
              </div>
            </Show>

            <Show when={dialog() === "fresh-start"}>
              <h2 class="font-heading font-semibold text-lg">Start from the beginning?</h2>
              <p class="mt-2 text-[11px] text-zinc-400 leading-5">
                This does not resume <code class="text-zinc-200">{selectedRun().id}</code>. It
                creates a new Workflow Run with a new durable identity and uses the currently
                observed definition revision.
              </p>
              <div class="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setDialog(null);
                    model.requestResume();
                  }}
                  class="rounded-lg border border-cyan-300/20 bg-cyan-300/5 p-2.5 text-left"
                >
                  <p class="font-semibold text-[10px] text-cyan-200">Resume existing</p>
                  <p class="mt-1 text-[9px] text-zinc-500 leading-4">
                    Keep identity and reuse durable Activity results.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={confirmFreshStart}
                  class="rounded-lg border border-emerald-300/20 bg-emerald-300/5 p-2.5 text-left"
                >
                  <p class="font-semibold text-[10px] text-emerald-200">Start fresh</p>
                  <p class="mt-1 text-[9px] text-zinc-500 leading-4">
                    New identity and execution from the beginning.
                  </p>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setDialog(null)}
                class="mt-4 w-full py-1 text-[10px] text-zinc-500"
              >
                Cancel
              </button>
            </Show>

            <Show when={dialog() === "stop"}>
              <h2 class="font-heading font-semibold text-lg">Request a safe stop?</h2>
              <p class="mt-2 text-[11px] text-zinc-400 leading-5">
                Kojo records stop intent, blocks new forward work, and safely interrupts this run
                and its non-final children. Required cleanup may keep it in{" "}
                <code class="text-amber-300">stopping</code>.
              </p>
              <div class="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  class="h-7 rounded-md px-2.5 font-semibold text-[9px] text-zinc-400"
                >
                  Keep running
                </button>
                <button
                  type="button"
                  onClick={confirmStop}
                  class="h-7 rounded-md bg-rose-400 px-3 font-bold text-[9px] text-zinc-950"
                >
                  Request stop
                </button>
              </div>
            </Show>

            <Show when={dialog() === "reveal"}>
              <div class="flex items-center gap-2">
                <ShieldAlert class="size-5 text-amber-300" />
                <h2 class="font-heading font-semibold text-lg">Reveal Sensitive Execution Data?</h2>
              </div>
              <p class="mt-3 text-[11px] text-zinc-400 leading-5">
                Known secret sources and fields marked by the Workflow schema are masked. Kojo does
                not scan arbitrary content perfectly, so revealed values may contain other secrets.
              </p>
              <div class="mt-4 rounded-lg border border-amber-300/15 bg-amber-300/5 p-3 text-[10px] text-amber-100/70 leading-5">
                This reveal applies only to this request and produces a payload-free Diagnostic
                Event.
              </div>
              <div class="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  class="h-7 rounded-md px-2.5 font-semibold text-[9px] text-zinc-400"
                >
                  Keep masked
                </button>
                <button
                  type="button"
                  onClick={confirmReveal}
                  class="h-7 rounded-md bg-amber-300 px-3 font-bold text-[9px] text-zinc-950"
                >
                  Reveal this view
                </button>
              </div>
            </Show>
          </section>
        </div>
      </Show>

      <Show when={import.meta.env.DEV || props.showSwitcher}>
        <PrototypeSwitcher current={props.variant} onChange={props.onVariantChange} />
      </Show>
    </>
  );
}
