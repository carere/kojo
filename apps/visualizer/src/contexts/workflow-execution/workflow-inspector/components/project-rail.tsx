import type { ProjectCondition, ProjectIdentity, ProjectSnapshot } from "@kojo/control";
import { FolderPlus } from "lucide-solid";
import { For, Show } from "solid-js";
import {
  conditionDot,
  type ProjectRailProps,
  projectName,
} from "../models/workflow-inspector-models";

export function ProjectRail(props: ProjectRailProps) {
  return (
    <aside class="workflow-inspector-rail" aria-label="Project rail">
      <div class="grid size-8 place-items-center rounded-lg bg-emerald-400 font-heading font-semibold text-sm text-zinc-950">
        K
      </div>
      <nav class="mt-5 flex flex-1 flex-col items-center gap-2" aria-label="Kojo Projects">
        <Show
          when={props.projects.length > 0}
          fallback={<p class="sr-only">No registered Projects in this Host.</p>}
        >
          <For each={props.projects}>
            {(project) => {
              const condition = () => props.conditionFor(project.identity);
              return (
                <button
                  type="button"
                  aria-label={projectName(project.path)}
                  aria-current={props.selectedIdentity === project.identity ? "page" : undefined}
                  data-project-identity={project.identity}
                  onClick={() => props.onSelect(project.identity)}
                  class={`relative grid size-8 place-items-center rounded-lg font-semibold text-[10px] transition ${
                    props.selectedIdentity === project.identity
                      ? "bg-white text-zinc-950 shadow-sm"
                      : "bg-white/7 text-zinc-400 hover:bg-white/12 hover:text-white"
                  }`}
                >
                  {projectName(project.path).slice(0, 2).toUpperCase()}
                  <span class="sr-only">{project.identity}</span>
                  <span
                    class={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-[#191c1b] ${conditionDot[condition()]}`}
                  />
                  <span class="sr-only">Project condition: {condition()}</span>
                </button>
              );
            }}
          </For>
        </Show>
        <button
          type="button"
          aria-label="Register Kojo Project"
          class="grid size-8 place-items-center rounded-lg border border-white/15 border-dashed text-zinc-500 transition hover:border-white/30 hover:text-white"
          title="Project registration is available from the CLI"
        >
          <FolderPlus class="size-3.5" />
        </button>
      </nav>
      <div class="grid size-7 place-items-center rounded-full bg-emerald-400/15 font-bold text-[9px] text-emerald-300">
        KA
      </div>
    </aside>
  );
}

export type { ProjectCondition, ProjectIdentity, ProjectSnapshot };
