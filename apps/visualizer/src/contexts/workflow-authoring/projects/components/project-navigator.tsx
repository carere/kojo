import type { ProjectSnapshot } from "@kojo/control";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import {
  NAVIGATOR_PREFERENCES_KEY,
  type NavigatorPreferences,
  orderProjects,
  reconcileNavigatorPreferences,
} from "../services/navigator-preferences";

export interface ProjectNavigatorProps {
  readonly projects: ReadonlyArray<ProjectSnapshot>;
}

const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function ProjectNavigator(props: ProjectNavigatorProps) {
  const [preferences, setPreferences] = createSignal<NavigatorPreferences>({
    version: 1,
    order: [],
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const reconciled = reconcileNavigatorPreferences(
      props.projects,
      window.localStorage.getItem(NAVIGATOR_PREFERENCES_KEY),
    );
    setPreferences(reconciled);
    window.localStorage.setItem(NAVIGATOR_PREFERENCES_KEY, JSON.stringify(reconciled));
  });

  const projects = createMemo(() => orderProjects(props.projects, preferences()));

  const select = (identity: string) => {
    const next = { ...preferences(), selectedProjectIdentity: identity };
    setPreferences(next);
    window.localStorage.setItem(NAVIGATOR_PREFERENCES_KEY, JSON.stringify(next));
  };

  return (
    <nav aria-label="Kojo Projects" class="w-full space-y-3 rounded-lg border p-4">
      <div>
        <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">Navigator</p>
        <h2 class="font-semibold text-lg">Kojo Projects</h2>
      </div>
      <Show
        when={projects().length > 0}
        fallback={<p class="text-muted-foreground text-sm">No Kojo Projects yet.</p>}
      >
        <ul class="space-y-2">
          <For each={projects()}>
            {(project) => (
              <li>
                <button
                  aria-current={
                    preferences().selectedProjectIdentity === project.identity ? "page" : undefined
                  }
                  class="w-full rounded-md border px-3 py-2 text-left hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-muted"
                  data-project-identity={project.identity}
                  onClick={() => select(project.identity)}
                  type="button"
                >
                  <span class="block font-medium text-sm">{projectName(project.path)}</span>
                  <span class="block truncate font-mono text-muted-foreground text-xs">
                    {project.identity}
                  </span>
                  <span class="block truncate text-muted-foreground text-xs">{project.path}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </nav>
  );
}
