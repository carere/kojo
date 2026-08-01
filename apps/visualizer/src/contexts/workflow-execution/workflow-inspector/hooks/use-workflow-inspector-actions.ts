import type {
  ProjectIdentity,
  ProjectWorkflowSchedulesSnapshot,
  WorkflowRunId,
  WorkflowRunListItem,
  WorkflowRunSnapshot,
  WorkflowScheduleAllowedAction,
} from "@kojo/control";
import { Effect } from "effect";
import { type Accessor, createSignal, type Setter } from "solid-js";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";
import type { DialogKind, WorkflowDefinition } from "../models/workflow-inspector-models";
import { parseJson, requestKey } from "../models/workflow-inspector-models";

interface UseWorkflowInspectorActionsProps {
  readonly identity: Accessor<ProjectIdentity | undefined>;
  readonly run: Accessor<WorkflowRunListItem | undefined>;
  readonly definition: Accessor<WorkflowDefinition | undefined>;
  readonly production: boolean;
  readonly reloadOverview: () => Promise<void>;
  readonly setDialog: Setter<DialogKind>;
  readonly setSelectedRunId: Setter<WorkflowRunId | undefined>;
  readonly setRevealedRun: Setter<WorkflowRunSnapshot | undefined>;
}

export function useWorkflowInspectorActions(props: UseWorkflowInspectorActionsProps) {
  const [freshInput, setFreshInput] = createSignal("");
  const [busyAction, setBusyAction] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  const scheduleAction = async (
    schedule: ProjectWorkflowSchedulesSnapshot["schedules"][number],
    action: WorkflowScheduleAllowedAction,
  ) => {
    const identity = props.identity();
    if (identity === undefined || !props.production || !schedule.allowedActions.includes(action))
      return;
    setBusyAction(`schedule:${schedule.scheduleKey}`);
    setError(undefined);
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          action === "enable"
            ? client.EnableWorkflowSchedule({
                identity,
                scheduleKey: schedule.scheduleKey,
                scheduleRevision: schedule.definition?.revision ?? "",
                requestKey: requestKey(),
              })
            : client.DisableWorkflowSchedule({
                identity,
                scheduleKey: schedule.scheduleKey,
                requestKey: requestKey(),
              }),
        ),
      );
      if (!result.ok) setError(result.error.message);
      else {
        setNotice(
          `${schedule.scheduleKey}: ${action === "enable" ? "future occurrences enabled" : "future occurrences disabled"}. Accepted Workflow Runs continue.`,
        );
        await props.reloadOverview();
      }
    } catch {
      setError(`Kojo Host could not ${action} ${schedule.scheduleKey}.`);
    } finally {
      setBusyAction(undefined);
    }
  };

  const resume = async (source: string) => {
    const identity = props.identity();
    const run = props.run();
    if (
      identity === undefined ||
      run === undefined ||
      !run.allowedActions.includes("resume") ||
      !props.production
    )
      return;
    const parsed = parseJson(source);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusyAction("resume");
    setError(undefined);
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.ResumeWorkflowRun({
            identity,
            runId: run.runId,
            value: parsed.value,
            requestKey: requestKey(),
          }),
        ),
      );
      if (!result.ok) setError(result.error.message);
      else {
        setNotice(`${run.runId}: Run resume accepted under the same identity.`);
        await props.reloadOverview();
      }
    } catch {
      setError("Kojo Host could not resume this Workflow Run.");
    } finally {
      setBusyAction(undefined);
    }
  };

  const completeDeferred = async (token: string, source: string) => {
    const identity = props.identity();
    const run = props.run();
    if (
      identity === undefined ||
      run === undefined ||
      !run.allowedActions.includes("deferred-complete") ||
      !props.production
    )
      return;
    if (token.trim() === "") {
      setError("A Workflow Deferred completion token is required.");
      return;
    }
    const parsed = parseJson(source);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusyAction("deferred-complete");
    setError(undefined);
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.CompleteWorkflowDeferred({
            identity,
            runId: run.runId,
            token,
            value: parsed.value,
            requestKey: requestKey(),
          }),
        ),
      );
      if (!result.ok) setError(result.error.message);
      else {
        setNotice(`${run.runId}: Workflow Deferred completed. This was not a Run resume.`);
        await props.reloadOverview();
      }
    } catch {
      setError("Kojo Host could not complete this Workflow Deferred.");
    } finally {
      setBusyAction(undefined);
    }
  };

  const requestStop = () => {
    const run = props.run();
    if (run === undefined || !run.allowedActions.includes("stop") || !props.production) return;
    props.setDialog("stop");
  };

  const confirmStop = async () => {
    const identity = props.identity();
    const run = props.run();
    if (
      identity === undefined ||
      run === undefined ||
      !run.allowedActions.includes("stop") ||
      !props.production
    )
      return;
    setBusyAction("stop");
    setError(undefined);
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.StopWorkflowRun({ identity, runId: run.runId, requestKey: requestKey() }),
        ),
      );
      if (!result.ok) setError(result.error.message);
      else {
        props.setDialog(null);
        setNotice(`${run.runId}: safe stop accepted; the Host will finish required cleanup.`);
        await props.reloadOverview();
      }
    } catch {
      setError("Kojo Host could not request a safe stop for this Workflow Run.");
    } finally {
      setBusyAction(undefined);
    }
  };

  const freshStart = async () => {
    const identity = props.identity();
    const definition = props.definition();
    if (identity === undefined || definition === undefined || !props.production) return;
    const parsed = parseJson(freshInput());
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusyAction("fresh-start");
    setError(undefined);
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.StartWorkflowRun({
            identity,
            workflowKey: definition.workflowKey,
            workflowRevision: definition.revision,
            input: parsed.value,
            requestKey: requestKey(),
          }),
        ),
      );
      if (!result.ok) setError(result.error.message);
      else {
        props.setDialog(null);
        setFreshInput("");
        setNotice(
          `${result.run.runId}: fresh Workflow Run accepted with a new identity from the beginning.`,
        );
        await props.reloadOverview();
        props.setSelectedRunId(result.run.runId);
      }
    } catch {
      setError("Kojo Host could not start a fresh Workflow Run.");
    } finally {
      setBusyAction(undefined);
    }
  };

  const reveal = async () => {
    const identity = props.identity();
    const run = props.run();
    if (identity === undefined || run === undefined || !props.production) return;
    setBusyAction("reveal");
    setError(undefined);
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.RevealWorkflowRun({ identity, runId: run.runId }),
        ),
      );
      if (!result.ok) setError(result.error.message);
      else {
        props.setRevealedRun(result.run);
        props.setDialog(null);
        setNotice(`${run.runId}: explicit sensitive-data reveal accepted for this view only.`);
      }
    } catch {
      setError("Kojo Host could not reveal this Workflow Run.");
    } finally {
      setBusyAction(undefined);
    }
  };

  return {
    busyAction,
    completeDeferred,
    confirmStop,
    error,
    freshInput,
    freshStart,
    notice,
    requestStop,
    resume,
    scheduleAction,
    setError,
    setFreshInput,
    setNotice,
    reveal,
  };
}
