import {
  Archive,
  Eye,
  EyeOff,
  FileArchive,
  GitBranch,
  Play,
  ShieldCheck,
  Square,
  Zap,
} from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import {
  formatDateTime,
  type InspectorPanelProps,
  runTone,
} from "../models/workflow-inspector-models";
import { RetentionSummary } from "./retention-summary";

export function InspectorPanel(props: InspectorPanelProps) {
  const [resumeValue, setResumeValue] = createSignal("");
  const [deferredToken, setDeferredToken] = createSignal("");
  const [deferredValue, setDeferredValue] = createSignal("");
  const artifactHref = (artifactId: string) => {
    const run = props.run;
    if (run === undefined) return "#";
    const search = new URLSearchParams({
      artifact: artifactId,
      project: props.project.identity,
      run: run.runId,
    });
    return `/api/artifacts?${search}`;
  };

  return (
    <aside class="workflow-inspector-inspector-panel" aria-label="Run inspection panel">
      <header class="border-zinc-200 border-b px-3 py-3 dark:border-zinc-800">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.15em]">
              Run inspection
            </p>
            <h2 class="mt-1 font-heading font-semibold text-base">Host-authorized details</h2>
          </div>
          <ShieldCheck class="size-4 text-emerald-500" />
        </div>
      </header>
      <div class="overflow-y-auto px-3 py-3">
        <Show
          when={props.run}
          fallback={
            <>
              <p class="text-[10px] text-zinc-500">
                Select a Workflow Run to inspect its relationships, evidence, and allowed controls.
              </p>
              <Show when={props.canStart && props.canMutate && props.definition}>
                <section
                  class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800"
                  aria-label="Workflow Definition controls"
                >
                  <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                    Definition control
                  </p>
                  <p class="mt-1 text-[9px] text-zinc-500">
                    {props.definition?.workflowKey} revision {props.definition?.revision} is
                    accepted by the Host.
                  </p>
                  <button
                    type="button"
                    class="mt-2 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 font-semibold text-[9px] hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                    onClick={props.onFreshStart}
                  >
                    <Zap class="size-2.5" /> Start a fresh Workflow Run
                  </button>
                </section>
              </Show>
            </>
          }
        >
          {(run) => (
            <>
              <section>
                <div class="flex items-center gap-2">
                  <h3 class="min-w-0 flex-1 truncate font-semibold text-sm">{run().workflowKey}</h3>
                  <span class={`rounded-full px-2 py-0.5 text-[8px] ${runTone[run().state]}`}>
                    {run().state}
                  </span>
                </div>
                <p class="mt-1 break-all font-mono text-[9px] text-zinc-500">{run().runId}</p>
                <dl class="mt-3 grid grid-cols-2 gap-2 text-[9px]">
                  <div>
                    <dt class="text-zinc-400">Accepted</dt>
                    <dd class="mt-0.5">{formatDateTime(run().acceptedAtMs)}</dd>
                  </div>
                  <div>
                    <dt class="text-zinc-400">Updated</dt>
                    <dd class="mt-0.5">{formatDateTime(run().updatedAtMs)}</dd>
                  </div>
                  <div>
                    <dt class="text-zinc-400">Revision</dt>
                    <dd class="mt-0.5 font-mono">{run().workflowRevision}</dd>
                  </div>
                  <div>
                    <dt class="text-zinc-400">Activities</dt>
                    <dd class="mt-0.5">{run().activitySummary.invocationAttempts} attempts</dd>
                  </div>
                </dl>
                <Show when={run().parentRunId !== null && run().parentRunId !== undefined}>
                  <p class="mt-2 flex items-center gap-1 text-[9px] text-cyan-700 dark:text-cyan-300">
                    <GitBranch class="size-3" /> Child of {run().parentRunId}
                  </p>
                </Show>
              </section>

              <section
                class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800"
                aria-label="Allowed Workflow Run controls"
              >
                <div class="flex items-center justify-between">
                  <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                    Allowed controls
                  </p>
                  <span class="text-[8px] text-zinc-400">Host-authoritative</span>
                </div>
                <div class="mt-2 space-y-2">
                  <Show when={props.canMutate && run().allowedActions.includes("resume")}>
                    <div class="rounded-lg border border-emerald-200 bg-emerald-50 p-2 dark:border-emerald-900 dark:bg-emerald-950/30">
                      <p class="flex items-center gap-1 font-semibold text-[9px] text-emerald-800 dark:text-emerald-300">
                        <Play class="size-2.5" /> Resume this same Workflow Run
                      </p>
                      <p class="mt-1 text-[8px] text-zinc-500">
                        Same identity; completed Activities remain reusable.
                      </p>
                      <input
                        aria-label={`Resume value for ${run().runId}`}
                        class="mt-2 h-7 w-full rounded-md border border-emerald-200 bg-white px-2 font-mono text-[9px] dark:border-emerald-900 dark:bg-zinc-950"
                        placeholder="Optional JSON value"
                        value={resumeValue()}
                        onInput={(event) => setResumeValue(event.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="mt-2 h-7 w-full rounded-md bg-emerald-600 px-2 font-semibold text-[9px] text-white hover:bg-emerald-500 disabled:opacity-50"
                        disabled={props.busyAction === "resume"}
                        onClick={() => props.onResume(resumeValue())}
                      >
                        {props.busyAction === "resume" ? "Submitting…" : "Resume Workflow Run"}
                      </button>
                    </div>
                  </Show>
                  <Show
                    when={props.canMutate && run().allowedActions.includes("deferred-complete")}
                  >
                    <div class="rounded-lg border border-sky-200 bg-sky-50 p-2 dark:border-sky-900 dark:bg-sky-950/30">
                      <p class="flex items-center gap-1 font-semibold text-[9px] text-sky-800 dark:text-sky-300">
                        <span aria-hidden="true">✓</span> Complete Workflow Deferred
                      </p>
                      <p class="mt-1 text-[8px] text-zinc-500">
                        This is distinct from resuming the Workflow Run.
                      </p>
                      <input
                        aria-label={`Deferred token for ${run().runId}`}
                        class="mt-2 h-7 w-full rounded-md border border-sky-200 bg-white px-2 font-mono text-[9px] dark:border-sky-900 dark:bg-zinc-950"
                        placeholder="Workflow Deferred completion token"
                        value={deferredToken()}
                        onInput={(event) => setDeferredToken(event.currentTarget.value)}
                      />
                      <input
                        aria-label={`Deferred value for ${run().runId}`}
                        class="mt-2 h-7 w-full rounded-md border border-sky-200 bg-white px-2 font-mono text-[9px] dark:border-sky-900 dark:bg-zinc-950"
                        placeholder="Optional JSON value"
                        value={deferredValue()}
                        onInput={(event) => setDeferredValue(event.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="mt-2 h-7 w-full rounded-md bg-sky-700 px-2 font-semibold text-[9px] text-white hover:bg-sky-600 disabled:opacity-50"
                        disabled={props.busyAction === "deferred-complete"}
                        onClick={() => props.onCompleteDeferred(deferredToken(), deferredValue())}
                      >
                        {props.busyAction === "deferred-complete"
                          ? "Submitting…"
                          : "Complete Deferred"}
                      </button>
                    </div>
                  </Show>
                  <Show when={props.canMutate && run().allowedActions.includes("stop")}>
                    <button
                      type="button"
                      class="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-rose-200 bg-white px-2 font-semibold text-[9px] text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:bg-zinc-900 dark:text-rose-300"
                      onClick={props.onStop}
                    >
                      <Square class="size-2.5" /> Request safe stop
                    </button>
                  </Show>
                  <Show when={props.canStart && props.canMutate && props.definition}>
                    <button
                      type="button"
                      class="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 font-semibold text-[9px] hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                      onClick={props.onFreshStart}
                    >
                      <Zap class="size-2.5" /> Start a fresh Workflow Run
                    </button>
                  </Show>
                  <Show
                    when={
                      run().allowedActions.length === 0 &&
                      !(props.canStart && props.canMutate && props.definition)
                    }
                  >
                    <p class="rounded-md bg-zinc-100 p-2 text-[9px] text-zinc-500 dark:bg-zinc-800">
                      No lifecycle action is currently allowed by the Host.
                    </p>
                  </Show>
                </div>
              </section>

              <section
                class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800"
                aria-label="Sensitive execution data"
              >
                <div class="flex items-center justify-between">
                  <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                    Sensitive data
                  </p>
                  <EyeOff class="size-3 text-amber-500" />
                </div>
                <div class="mt-2 rounded-lg bg-zinc-100 p-2 font-mono text-[9px] text-zinc-500 dark:bg-zinc-800">
                  Workflow input&nbsp;&nbsp;••••••••
                  <br />
                  Activity results&nbsp;••••••••
                  <br />
                  Artifact contents&nbsp;••••••••
                </div>
                <p class="mt-2 text-[8px] text-zinc-500">
                  Masked by default. Reveal requests a warning and asks the Host for one explicit
                  view.
                </p>
                <Show when={props.canReveal && props.canMutate && props.revealedRun === undefined}>
                  <button
                    type="button"
                    class="mt-2 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-amber-300 bg-amber-50 font-semibold text-[9px] text-amber-900 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                    onClick={props.onReveal}
                  >
                    <Eye class="size-2.5" /> Review warning & reveal
                  </button>
                </Show>
                <Show when={props.revealedRun}>
                  {(revealed) => (
                    <div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
                      <p class="font-semibold text-[9px] text-amber-900 dark:text-amber-300">
                        Explicit reveal active
                      </p>
                      <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[8px] text-amber-950 dark:text-amber-100">
                        {JSON.stringify(revealed().startSnapshot, null, 2)}
                      </pre>
                    </div>
                  )}
                </Show>
              </section>

              <section
                class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800"
                aria-label="Execution Artifacts"
              >
                <div class="flex items-center justify-between">
                  <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                    Execution Artifacts
                  </p>
                  <FileArchive class="size-3 text-zinc-400" />
                </div>
                <Show
                  when={props.artifactIds.length > 0}
                  fallback={
                    <p class="mt-2 text-[9px] text-zinc-500">
                      No Artifact identities recorded in this Run snapshot.
                    </p>
                  }
                >
                  <ul class="mt-2 space-y-1">
                    <For each={props.artifactIds}>
                      {(artifactId) => (
                        <li>
                          <a
                            class="flex items-center gap-2 rounded-lg border border-zinc-200 p-2 text-[9px] hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            download=""
                            href={artifactHref(artifactId)}
                            aria-label={`Download Artifact ${artifactId}`}
                          >
                            <Archive class="size-3 text-zinc-400" />
                            <span class="min-w-0 flex-1 truncate font-mono">{artifactId}</span>
                            <span class="text-zinc-400">Download</span>
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <p class="mt-2 text-[8px] text-zinc-500">
                  Unavailable or pruned content remains visible as Execution Trace evidence; bytes
                  are never rendered here.
                </p>
              </section>

              <RetentionSummary snapshot={props.retention} />
            </>
          )}
        </Show>
      </div>
    </aside>
  );
}
