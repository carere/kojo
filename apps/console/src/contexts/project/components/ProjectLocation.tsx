import type { ProjectLocationAction } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { changeProjectLocation } from "../../daemon/services/browserAccess.ts";
import { Badge } from "../../shared/components/Badge.tsx";
import { useProjects } from "../hooks/useProjects.ts";

export const ProjectLocation = (props: { readonly projectId: string }): JSX.Element => {
  const projects = useProjects();
  const project = createMemo(() =>
    projects.data?.projects.find((candidate) => candidate.projectId === props.projectId),
  );
  const [action, setAction] = createSignal<ProjectLocationAction | undefined>();
  const [location, setLocation] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [notice, setNotice] = createSignal<string>();

  const select = (next: ProjectLocationAction): void => {
    setAction(next);
    setLocation(project()?.location ?? "");
    setConfirmed(false);
    setNotice(undefined);
  };
  const apply = async (): Promise<void> => {
    const selected = action();
    if (selected === undefined || !confirmed()) return;
    setPending(true);
    setNotice(`Draining Project ${props.projectId}. New dispatch is held.`);
    try {
      const result = await changeProjectLocation(
        props.projectId,
        selected,
        selected === "archive" ? undefined : location(),
      );
      setNotice(
        `${result.action} committed: ${result.project.projectState}. ${result.consequences.join(" ")}`,
      );
      setAction(undefined);
      setConfirmed(false);
      await projects.refetch();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Show when={project()}>
      {(current) => (
        <section class="mb-6 rounded-lg border p-4" aria-label="Project location">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="font-semibold text-lg">Project location</h2>
              <p class="font-mono text-xs">{current().location}</p>
              <p class="mt-1 text-muted-foreground text-sm">
                {current().locationActive ? "Active location" : "Retained last location"} ·{" "}
                {current().locationConfirmed ? "confirmed" : "confirmation required"}
              </p>
            </div>
            <Badge tone={current().projectState === "available" ? "good" : "danger"}>
              {current().locationChange.state === "draining"
                ? `${current().locationChange.action} draining`
                : current().projectState}
            </Badge>
          </div>
          <p class="mt-3 text-sm">
            Retained history: {current().locationHistory.length} location record(s). Runs and pinned
            Workflow Revisions stay with Project {current().projectId}.
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            {current().projectState === "archived" ? (
              <button
                class="rounded border px-3 py-1 text-sm"
                type="button"
                onClick={() => select("restore")}
              >
                Restore
              </button>
            ) : (
              <>
                <button
                  class="rounded border px-3 py-1 text-sm"
                  type="button"
                  onClick={() => select("relocate")}
                >
                  Relocate or confirm
                </button>
                <button
                  class="rounded border px-3 py-1 text-sm"
                  type="button"
                  onClick={() => select("archive")}
                >
                  Archive
                </button>
              </>
            )}
          </div>
          <Show when={action()}>
            {(selected) => (
              <div class="mt-4 rounded-md bg-muted p-3">
                <Show when={selected() !== "archive"}>
                  <label class="block text-sm">
                    Exact Git working-tree root
                    <input
                      class="mt-1 block w-full rounded border bg-background p-2 font-mono text-xs"
                      aria-label="Exact Git working-tree root"
                      value={location()}
                      onInput={(event) => setLocation(event.currentTarget.value)}
                    />
                  </label>
                </Show>
                <label class="mt-3 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed()}
                    onChange={(event) => setConfirmed(event.currentTarget.checked)}
                  />
                  <span>
                    I confirm that new dispatch will stop and drain, all Workflows will become
                    inactive, and retained Runs and pinned revisions will not change.
                    {selected() === "archive"
                      ? " The active location will be released for a new Project."
                      : " A Factory Refresh will be required at the confirmed location."}
                  </span>
                </label>
                <button
                  class="mt-3 rounded border px-3 py-1 text-sm"
                  type="button"
                  disabled={
                    !confirmed() || pending() || (selected() !== "archive" && location() === "")
                  }
                  onClick={() => void apply()}
                >
                  {pending() ? "Draining…" : `Confirm ${selected()}`}
                </button>
              </div>
            )}
          </Show>
          <Show when={notice()}>
            {(message) => (
              <p class="mt-3 text-sm" role="status">
                {message()}
              </p>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
};
