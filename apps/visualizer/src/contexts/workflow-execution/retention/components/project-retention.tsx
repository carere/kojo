import type { ProjectRetentionSnapshot } from "@kojo/control";
import { For, Show } from "solid-js";

export interface ProjectRetentionProps {
  readonly snapshots: ReadonlyArray<ProjectRetentionSnapshot>;
}

const bytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
};

const duration = (value: number | null) => {
  if (value === null) return "off";
  const days = value / (24 * 60 * 60 * 1_000);
  return Number.isInteger(days) ? `${days}d` : `${Math.round(value / 1_000)}s`;
};

export function ProjectRetention(props: ProjectRetentionProps) {
  return (
    <section aria-label="Execution data retention" class="space-y-3">
      <header>
        <h2 class="font-semibold text-lg">Execution data retention</h2>
        <p class="text-muted-foreground text-sm">
          Inspectable Project policy and usage. Destructive retention controls remain CLI-only.
        </p>
      </header>
      <Show
        when={props.snapshots.length > 0}
        fallback={<p class="text-muted-foreground text-sm">No retention snapshots available.</p>}
      >
        <div class="grid gap-3">
          <For each={props.snapshots}>
            {(snapshot) => (
              <article
                class="rounded-lg border p-4"
                data-project-retention={snapshot.project.identity}
              >
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 class="font-medium">{snapshot.project.identity}</h3>
                  <span class="text-muted-foreground text-xs">
                    observed {new Date(snapshot.observedAtMs).toISOString()}
                  </span>
                </div>
                <dl class="mt-3 grid gap-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt class="text-muted-foreground">Diagnostics</dt>
                    <dd>
                      {bytes(snapshot.usage.diagnosticBytes)} · age{" "}
                      {duration(snapshot.policy.diagnosticMaxAgeMs)} · size{" "}
                      {snapshot.policy.diagnosticMaxBytes === null
                        ? "off"
                        : bytes(snapshot.policy.diagnosticMaxBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Disposable content</dt>
                    <dd>
                      {bytes(snapshot.usage.disposableBytes)} · protected{" "}
                      {bytes(snapshot.usage.protectedDisposableBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Disposable policy</dt>
                    <dd>
                      age {duration(snapshot.policy.disposableMaxAgeMs)} · size{" "}
                      {snapshot.policy.disposableMaxBytes === null
                        ? "off"
                        : bytes(snapshot.policy.disposableMaxBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Host diagnostic limit</dt>
                    <dd>
                      {bytes(snapshot.hostDiagnosticMaxBytes)} · age{" "}
                      {duration(snapshot.hostDiagnosticMaxAgeMs)}
                    </dd>
                  </div>
                </dl>
                <p class="mt-3 text-muted-foreground text-xs">
                  Artifacts: {snapshot.usage.availableArtifactCount} available,{" "}
                  {snapshot.usage.missingArtifactCount} missing,{" "}
                  {snapshot.usage.expiredArtifactCount} expired.
                </p>
                <Show when={snapshot.warnings.length > 0}>
                  <ul class="mt-3 space-y-1 text-amber-700 text-sm dark:text-amber-300">
                    <For each={snapshot.warnings}>
                      {(warning) => (
                        <li>
                          {warning.message} {warning.next}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
