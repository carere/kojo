import { CircleAlert, History } from "lucide-solid";
import { For, Show } from "solid-js";
import {
  formatOptionalBytes,
  formatRetentionDuration,
  type RetentionSnapshot,
} from "../models/workflow-inspector-models";

export function RetentionSummary(props: { readonly snapshot: RetentionSnapshot | undefined }) {
  return (
    <section
      class="mt-4 border-zinc-200 border-t pt-3 dark:border-zinc-800"
      aria-label="Execution data retention"
    >
      <div class="flex items-center justify-between">
        <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
          Retention policy
        </p>
        <History class="size-3 text-zinc-400" />
      </div>
      <Show
        when={props.snapshot}
        fallback={<p class="mt-2 text-[9px] text-zinc-500">Retention snapshot unavailable.</p>}
      >
        {(snapshot) => (
          <>
            <dl class="mt-2 grid grid-cols-2 gap-2 text-[9px]">
              <div>
                <dt class="text-zinc-400">Artifacts</dt>
                <dd class="mt-0.5">
                  {formatRetentionDuration(snapshot().policy.disposableMaxAgeMs)} ·{" "}
                  {formatOptionalBytes(snapshot().policy.disposableMaxBytes)}
                </dd>
              </div>
              <div>
                <dt class="text-zinc-400">Diagnostics</dt>
                <dd class="mt-0.5">
                  {formatRetentionDuration(snapshot().policy.diagnosticMaxAgeMs)} ·{" "}
                  {formatOptionalBytes(snapshot().policy.diagnosticMaxBytes)}
                </dd>
              </div>
              <div>
                <dt class="text-zinc-400">Available</dt>
                <dd class="mt-0.5">{snapshot().usage.availableArtifactCount}</dd>
              </div>
              <div>
                <dt class="text-zinc-400">Missing / expired</dt>
                <dd class="mt-0.5">
                  {snapshot().usage.missingArtifactCount} / {snapshot().usage.expiredArtifactCount}
                </dd>
              </div>
            </dl>
            <Show when={snapshot().warnings.length > 0}>
              <ul class="mt-2 space-y-1 text-[8px] text-amber-700 dark:text-amber-300">
                <For each={snapshot().warnings}>
                  {(warning) => (
                    <li class="flex gap-1">
                      <CircleAlert class="mt-0.5 size-2.5 shrink-0" />
                      {warning.message}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <p class="mt-2 text-[8px] text-zinc-500">
              Read-only here. Execution Data Deletion remains an explicit CLI operation.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
