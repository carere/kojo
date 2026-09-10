import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Link } from "@tanstack/solid-router";
import { createSignal, For, type JSX, Show } from "solid-js";
import {
  startManualWorkflow,
  startTriggerWorkflow,
  stopWorkflow,
} from "../../daemon/services/browserAccess.ts";
import { useWorkflows } from "../hooks/useWorkflows.ts";

/** Start a Project Workflow from the Run list. Policy remains in the Factory. */
export const StartWorkflow = (): JSX.Element => {
  const workflows = useWorkflows();
  const [selected, setSelected] = createSignal("");
  const [payload, setPayload] = createSignal("{}");
  const [pending, setPending] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [runId, setRunId] = createSignal("");
  const key = (projectId: string, name: string): string => JSON.stringify([projectId, name]);
  const workflow = () =>
    workflows.data?.workflows.find((item) => key(item.projectId, item.workflowName) === selected());
  const changeActivity = async (action: "start" | "stop"): Promise<void> => {
    const current = workflow();
    if (current === undefined || pending()) return;
    setPending(true);
    setNotice("");
    setRunId("");
    try {
      if (action === "stop") {
        await stopWorkflow(current.projectId, current.workflowName);
        setNotice("Workflow stopped. Admitted Runs can still finish.");
      } else if (current.trigger.state !== "not-declared") {
        await startTriggerWorkflow(current.projectId, current.workflowName);
        setNotice("Trigger listening. A Run starts when the Trigger supplies a request.");
      } else {
        const result = await startManualWorkflow(
          current.projectId,
          current.workflowName,
          JSON.parse(payload()) as JsonValue,
        );
        setRunId(result.runId);
      }
      await workflows.refetch();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <details class="rounded-lg border border-border p-4">
      <summary class="cursor-pointer font-medium">Start a Workflow</summary>
      <div class="mt-4 grid min-w-0 gap-3">
        <Show when={workflows.error}>
          <p role="alert">{workflows.error?.message}</p>
        </Show>
        <Show when={workflows.data !== undefined && workflows.data.workflows.length === 0}>
          <p class="text-sm">
            No Workflows are available. Register a Project with{" "}
            <code>kojo project register &lt;path&gt;</code>.
          </p>
        </Show>
        <label class="grid min-w-0 gap-1 text-sm">
          Project / Workflow
          <select
            class="w-full min-w-0 rounded border border-border bg-background p-2"
            value={selected()}
            onChange={(event) => setSelected(event.currentTarget.value)}
          >
            <option value="" selected={selected() === ""}>
              Select a Workflow
            </option>
            <For each={workflows.data?.workflows ?? []}>
              {(item) => (
                <option
                  value={key(item.projectId, item.workflowName)}
                  selected={selected() === key(item.projectId, item.workflowName)}
                >
                  {item.projectLabel} / {item.workflowName}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={workflow()}>
          {(current) => (
            <>
              <Show when={current().availability !== "available"}>
                <p role="alert">
                  {current().sourceFault ?? current().availability} {current().remedy}
                </p>
              </Show>
              <Show when={current().trigger.state === "not-declared"}>
                <label class="grid min-w-0 gap-1 text-sm">
                  Request (JSON)
                  <textarea
                    class="min-h-24 w-full min-w-0 rounded border border-border bg-background p-2 font-mono"
                    value={payload()}
                    onInput={(event) => setPayload(event.currentTarget.value)}
                  />
                </label>
              </Show>
              <div class="flex flex-wrap gap-2">
                <button
                  class="rounded border px-3 py-2 text-sm"
                  type="button"
                  disabled={pending() || current().availability !== "available"}
                  onClick={() => void changeActivity("start")}
                >
                  {current().trigger.state === "not-declared" ? "Start Run" : "Start Trigger"}
                </button>
                <button
                  class="rounded border px-3 py-2 text-sm"
                  type="button"
                  disabled={pending() || current().activity !== "active"}
                  onClick={() => void changeActivity("stop")}
                >
                  Stop Workflow activity
                </button>
              </div>
            </>
          )}
        </Show>
        <Show when={notice()}>
          <p role="status">{notice()}</p>
        </Show>
        <Show when={runId()}>
          <Link
            class="break-all underline"
            to="/runs/$runId"
            params={{ runId: runId() }}
            search={{ view: "timeline" }}
          >
            Open Run {runId()}
          </Link>
        </Show>
      </div>
    </details>
  );
};
