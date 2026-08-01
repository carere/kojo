import { AlertTriangle, ShieldCheck, Zap } from "lucide-solid";
import { type Accessor, Show } from "solid-js";
import type { DialogKind } from "../models/workflow-inspector-models";

interface WorkflowInspectorDialogProps {
  readonly dialog: Accessor<DialogKind>;
  readonly freshInput: Accessor<string>;
  readonly busyAction: Accessor<string | undefined>;
  readonly mutationsEnabled: boolean;
  readonly onFreshInput: (value: string) => void;
  readonly onClose: () => void;
  readonly onFreshStart: () => void;
  readonly onConfirmStop: () => void;
  readonly onReveal: () => void;
}

export function WorkflowInspectorDialog(props: WorkflowInspectorDialogProps) {
  return (
    <Show when={props.dialog() !== null}>
      <div
        class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
        role="presentation"
      >
        <section
          class="w-full max-w-md rounded-xl border border-white/10 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="workflow-inspector-dialog-title"
        >
          <Show when={props.dialog() === "fresh-start"}>
            <div class="flex items-center gap-2">
              <Zap class="size-4 text-emerald-300" />
              <h2 id="workflow-inspector-dialog-title" class="font-heading font-semibold text-base">
                Start a fresh Workflow Run?
              </h2>
            </div>
            <p class="mt-2 text-[10px] text-zinc-400 leading-5">
              This creates a new Workflow Run identity from the beginning. It does not resume or
              replay the selected Run. The Host will validate the observed Workflow Definition
              revision and input.
            </p>
            <label class="mt-3 block font-semibold text-[9px] text-zinc-400">
              Fresh Workflow Run input (JSON)
              <textarea
                aria-label="Fresh Workflow Run input"
                class="mt-1 h-20 w-full rounded-md border border-white/10 bg-white/5 p-2 font-mono text-[10px] text-white outline-none focus:border-emerald-300/50"
                placeholder='"input"'
                value={props.freshInput()}
                onInput={(event) => props.onFreshInput(event.currentTarget.value)}
              />
            </label>
            <div class="mt-4 flex justify-end gap-2">
              <button
                type="button"
                class="h-7 rounded-md px-3 text-[9px] text-zinc-400 hover:text-white"
                onClick={props.onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                class="h-7 rounded-md bg-emerald-300 px-3 font-bold text-[9px] text-zinc-950 disabled:opacity-50"
                disabled={!props.mutationsEnabled || props.busyAction() === "fresh-start"}
                onClick={props.onFreshStart}
              >
                {props.busyAction() === "fresh-start" ? "Starting…" : "Start fresh"}
              </button>
            </div>
          </Show>
          <Show when={props.dialog() === "stop"}>
            <div class="flex items-center gap-2">
              <AlertTriangle class="size-4 text-rose-300" />
              <h2 id="workflow-inspector-dialog-title" class="font-heading font-semibold text-base">
                Request a safe stop?
              </h2>
            </div>
            <p class="mt-2 text-[10px] text-zinc-400 leading-5">
              The Host records stop intent, blocks new forward work, and safely interrupts this
              Workflow Run and its non-final Child Workflow Runs. Required cleanup may leave it in{" "}
              <code class="text-amber-300">stopping</code>.
            </p>
            <div class="mt-4 flex justify-end gap-2">
              <button
                type="button"
                class="h-7 rounded-md px-3 text-[9px] text-zinc-400 hover:text-white"
                onClick={props.onClose}
              >
                Keep running
              </button>
              <button
                type="button"
                class="h-7 rounded-md bg-rose-400 px-3 font-bold text-[9px] text-zinc-950 disabled:opacity-50"
                disabled={!props.mutationsEnabled || props.busyAction() === "stop"}
                onClick={props.onConfirmStop}
              >
                {props.busyAction() === "stop" ? "Stopping…" : "Request safe stop"}
              </button>
            </div>
          </Show>
          <Show when={props.dialog() === "reveal"}>
            <div class="flex items-center gap-2">
              <ShieldCheck class="size-4 text-amber-300" />
              <h2 id="workflow-inspector-dialog-title" class="font-heading font-semibold text-base">
                Reveal Sensitive Execution Data?
              </h2>
            </div>
            <p class="mt-2 text-[10px] text-zinc-400 leading-5">
              Inputs, results, suspension and resume values, transcripts, and Artifact contents may
              contain secrets. Kojo does not scan arbitrary content perfectly. This warning-bearing
              request reveals only the Host response for this view.
            </p>
            <div class="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-2 text-[9px] text-amber-100/80">
              Revealing payloads does not reveal Artifact bytes or create a deletion control.
            </div>
            <div class="mt-4 flex justify-end gap-2">
              <button
                type="button"
                class="h-7 rounded-md px-3 text-[9px] text-zinc-400 hover:text-white"
                onClick={props.onClose}
              >
                Keep masked
              </button>
              <button
                type="button"
                class="h-7 rounded-md bg-amber-300 px-3 font-bold text-[9px] text-zinc-950 disabled:opacity-50"
                disabled={!props.mutationsEnabled || props.busyAction() === "reveal"}
                onClick={props.onReveal}
              >
                {props.busyAction() === "reveal" ? "Revealing…" : "Reveal this view"}
              </button>
            </div>
          </Show>
        </section>
      </div>
    </Show>
  );
}
