import type {
  ProjectIdentity,
  ProjectWorkflowSchedulesSnapshot,
  WorkflowRunId,
  WorkflowRunListItem,
  WorkflowRunQueryResult,
  WorkflowRunSnapshot,
  WorkflowRunStartResult,
  WorkflowScheduleAllowedAction,
} from "@kojo/control";
import { Effect } from "effect";
import { type Accessor, createEffect, createSignal, on, onCleanup, type Setter } from "solid-js";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";
import type { DialogKind, WorkflowDefinition } from "../models/workflow-inspector-models";
import { parseJson, requestKey } from "../models/workflow-inspector-models";

const interruptWhenAborted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const onAbort = () => resume(Effect.interrupt);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const abortError = () => {
  const error = new Error("Workflow Inspector action interrupted.");
  error.name = "AbortError";
  return error;
};

const runWithCancellableTimeout = async <Value, Requirements>(
  request: Effect.Effect<Value, unknown, Requirements>,
  timeoutMs: number,
  lifecycleSignal: AbortSignal,
) => {
  if (lifecycleSignal.aborted) throw abortError();
  const controller = new AbortController();
  const onLifecycleAbort = () => controller.abort(lifecycleSignal.reason);
  lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await visualizerApiRuntime.runPromise(
      Effect.raceFirst(
        request as Effect.Effect<Value, unknown, VisualizerApiClient>,
        interruptWhenAborted(controller.signal),
      ),
    );
  } finally {
    clearTimeout(timeout);
    lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
    controller.abort();
  }
};

const cancellableDelay = (delayMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const runWithCancellableRetries = async <Value, Requirements>(
  request: Effect.Effect<Value, unknown, Requirements>,
  lifecycleSignal: AbortSignal,
) => {
  const retryDelaysMs = [100, 250] as const;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runWithCancellableTimeout(request, 5_000, lifecycleSignal);
    } catch (error) {
      if (lifecycleSignal.aborted) throw error;
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) throw error;
      await cancellableDelay(delay, lifecycleSignal);
    }
  }
};

/** Builds one idempotent Host mutation request before any transport retry. */
export const withStableRequestKey = <Value>(build: (key: ReturnType<typeof requestKey>) => Value) =>
  build(requestKey());

interface ReloadExpectation {
  readonly identity: ProjectIdentity;
  readonly runId?: WorkflowRunId;
}

interface UseWorkflowInspectorActionsProps {
  readonly identity: Accessor<ProjectIdentity | undefined>;
  readonly run: Accessor<WorkflowRunListItem | undefined>;
  readonly definition: Accessor<WorkflowDefinition | undefined>;
  readonly production: boolean;
  readonly authoritative?: Accessor<boolean>;
  readonly reloadOverview: (expected?: ReloadExpectation) => Promise<void>;
  readonly acceptRun?: (identity: ProjectIdentity, run: WorkflowRunSnapshot) => void;
  readonly setDialog: Setter<DialogKind>;
  readonly setSelectedRunId: Setter<WorkflowRunId | undefined>;
  readonly setRevealedRun: Setter<WorkflowRunSnapshot | undefined>;
  readonly revealWorkflowRun?: (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    signal: AbortSignal,
  ) => Promise<WorkflowRunQueryResult>;
  readonly startWorkflowRun?: (
    request: {
      readonly identity: ProjectIdentity;
      readonly workflowKey: string;
      readonly workflowRevision: string;
      readonly input: unknown;
      readonly requestKey: ReturnType<typeof requestKey>;
    },
    signal: AbortSignal,
  ) => Promise<WorkflowRunStartResult>;
}

interface ActionContext {
  readonly generation: number;
  readonly identity: ProjectIdentity;
  readonly runId: WorkflowRunId | undefined;
  readonly signal: AbortSignal;
  readonly label: string;
}

export function useWorkflowInspectorActions(props: UseWorkflowInspectorActionsProps) {
  const [freshInput, setFreshInput] = createSignal("");
  const [busyAction, setBusyAction] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  let actionGeneration = 0;
  let lifecycleController = new AbortController();
  let activeAction: ActionContext | undefined;

  const isAuthoritative = () => props.authoritative?.() ?? true;
  const selectionKey = () => `${props.identity() ?? ""}:${props.run()?.runId ?? ""}`;

  createEffect(
    on(
      selectionKey,
      () => {
        actionGeneration += 1;
        lifecycleController.abort();
        lifecycleController = new AbortController();
        activeAction = undefined;
        setBusyAction(undefined);
        setNotice(undefined);
        setError(undefined);
        props.setRevealedRun(undefined);
        props.setDialog(null);
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    lifecycleController.abort();
    activeAction = undefined;
  });

  const beginAction = (
    label: string,
    identity: ProjectIdentity,
    runId: WorkflowRunId | undefined,
  ): ActionContext | undefined => {
    if (
      !props.production ||
      !isAuthoritative() ||
      activeAction !== undefined ||
      lifecycleController.signal.aborted
    )
      return undefined;
    const context: ActionContext = {
      generation: actionGeneration,
      identity,
      runId,
      signal: lifecycleController.signal,
      label,
    };
    activeAction = context;
    setBusyAction(label);
    setError(undefined);
    return context;
  };

  const isCurrent = (context: ActionContext) =>
    activeAction === context &&
    context.generation === actionGeneration &&
    !context.signal.aborted &&
    props.identity() === context.identity &&
    props.run()?.runId === context.runId;

  const finishAction = (context: ActionContext) => {
    if (activeAction !== context) return;
    activeAction = undefined;
    setBusyAction(undefined);
  };

  const refreshAfterAcceptance = async (expected: ReloadExpectation) => {
    // The mutation receipt is already Host-authoritative. A converging
    // composite overview must not turn that accepted action into a failure;
    // the coordinator keeps the receipt visible and surfaces any refresh
    // transport problem as stale state.
    await props.reloadOverview(expected).catch(() => undefined);
  };

  const scheduleAction = async (
    schedule: ProjectWorkflowSchedulesSnapshot["schedules"][number],
    action: WorkflowScheduleAllowedAction,
  ) => {
    const identity = props.identity();
    if (
      identity === undefined ||
      !schedule.allowedActions.includes(action) ||
      !props.production ||
      !isAuthoritative()
    )
      return;
    const context = beginAction(`schedule:${schedule.scheduleKey}`, identity, props.run()?.runId);
    if (context === undefined) return;
    try {
      const result = await runWithCancellableRetries(
        withStableRequestKey((mutationRequestKey) =>
          Effect.flatMap(VisualizerApiClient, (client) =>
            action === "enable"
              ? client.EnableWorkflowSchedule({
                  identity,
                  scheduleKey: schedule.scheduleKey,
                  scheduleRevision: schedule.definition?.revision ?? "",
                  requestKey: mutationRequestKey,
                })
              : client.DisableWorkflowSchedule({
                  identity,
                  scheduleKey: schedule.scheduleKey,
                  requestKey: mutationRequestKey,
                }),
          ),
        ),
        context.signal,
      );
      if (!isCurrent(context)) return;
      if (!result.ok) setError(result.error.message);
      else {
        setNotice(
          `${schedule.scheduleKey}: ${action === "enable" ? "future occurrences enabled" : "future occurrences disabled"}. Accepted Workflow Runs continue.`,
        );
        await refreshAfterAcceptance({ identity });
        if (!isCurrent(context)) return;
      }
    } catch {
      if (isCurrent(context)) setError(`Kojo Host could not ${action} ${schedule.scheduleKey}.`);
    } finally {
      finishAction(context);
    }
  };

  const resume = async (source: string) => {
    const identity = props.identity();
    const run = props.run();
    if (
      identity === undefined ||
      run === undefined ||
      !run.allowedActions.includes("resume") ||
      !props.production ||
      !isAuthoritative()
    )
      return;
    const parsed = parseJson(source);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const context = beginAction("resume", identity, run.runId);
    if (context === undefined) return;
    try {
      const result = await runWithCancellableRetries(
        withStableRequestKey((mutationRequestKey) =>
          Effect.flatMap(VisualizerApiClient, (client) =>
            client.ResumeWorkflowRun({
              identity,
              runId: run.runId,
              value: parsed.value,
              requestKey: mutationRequestKey,
            }),
          ),
        ),
        context.signal,
      );
      if (!isCurrent(context)) return;
      if (!result.ok) setError(result.error.message);
      else {
        setNotice(`${run.runId}: Run resume accepted under the same identity.`);
        props.acceptRun?.(identity, result.run);
        await refreshAfterAcceptance({ identity, runId: run.runId });
        if (!isCurrent(context)) return;
      }
    } catch {
      if (isCurrent(context)) setError("Kojo Host could not resume this Workflow Run.");
    } finally {
      finishAction(context);
    }
  };

  const completeDeferred = async (token: string, source: string) => {
    const identity = props.identity();
    const run = props.run();
    if (
      identity === undefined ||
      run === undefined ||
      !run.allowedActions.includes("deferred-complete") ||
      !props.production ||
      !isAuthoritative()
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
    const context = beginAction("deferred-complete", identity, run.runId);
    if (context === undefined) return;
    try {
      const result = await runWithCancellableRetries(
        withStableRequestKey((mutationRequestKey) =>
          Effect.flatMap(VisualizerApiClient, (client) =>
            client.CompleteWorkflowDeferred({
              identity,
              runId: run.runId,
              token,
              value: parsed.value,
              requestKey: mutationRequestKey,
            }),
          ),
        ),
        context.signal,
      );
      if (!isCurrent(context)) return;
      if (!result.ok) setError(result.error.message);
      else {
        setNotice(`${run.runId}: Workflow Deferred completed. This was not a Run resume.`);
        props.acceptRun?.(identity, result.run);
        await refreshAfterAcceptance({ identity, runId: run.runId });
        if (!isCurrent(context)) return;
      }
    } catch {
      if (isCurrent(context)) setError("Kojo Host could not complete this Workflow Deferred.");
    } finally {
      finishAction(context);
    }
  };

  const requestStop = () => {
    const run = props.run();
    if (
      run === undefined ||
      !run.allowedActions.includes("stop") ||
      !props.production ||
      !isAuthoritative() ||
      activeAction !== undefined
    )
      return;
    props.setDialog("stop");
  };

  const confirmStop = async () => {
    const identity = props.identity();
    const run = props.run();
    if (
      identity === undefined ||
      run === undefined ||
      !run.allowedActions.includes("stop") ||
      !props.production ||
      !isAuthoritative()
    )
      return;
    const context = beginAction("stop", identity, run.runId);
    if (context === undefined) return;
    try {
      const result = await runWithCancellableRetries(
        withStableRequestKey((mutationRequestKey) =>
          Effect.flatMap(VisualizerApiClient, (client) =>
            client.StopWorkflowRun({ identity, runId: run.runId, requestKey: mutationRequestKey }),
          ),
        ),
        context.signal,
      );
      if (!isCurrent(context)) return;
      if (!result.ok) setError(result.error.message);
      else {
        props.setDialog(null);
        setNotice(`${run.runId}: safe stop accepted; the Host will finish required cleanup.`);
        props.acceptRun?.(identity, result.run);
        await refreshAfterAcceptance({ identity, runId: run.runId });
        if (!isCurrent(context)) return;
      }
    } catch {
      if (isCurrent(context))
        setError("Kojo Host could not request a safe stop for this Workflow Run.");
    } finally {
      finishAction(context);
    }
  };

  const freshStart = async () => {
    const identity = props.identity();
    const definition = props.definition();
    if (
      identity === undefined ||
      definition === undefined ||
      !props.production ||
      !isAuthoritative()
    )
      return;
    const parsed = parseJson(freshInput());
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const context = beginAction("fresh-start", identity, props.run()?.runId);
    if (context === undefined) return;
    const startWorkflowRun = props.startWorkflowRun;
    try {
      const request = withStableRequestKey((mutationRequestKey) => {
        const request = {
          identity,
          workflowKey: definition.workflowKey,
          workflowRevision: definition.revision,
          input: parsed.value,
          requestKey: mutationRequestKey,
        } as const;
        return startWorkflowRun === undefined
          ? Effect.flatMap(VisualizerApiClient, (client) => client.StartWorkflowRun(request))
          : Effect.promise(() => startWorkflowRun(request, context.signal));
      });
      let result = await runWithCancellableRetries(request, context.signal);
      if (!result.ok && result.error.code === "project-runtime-not-ready") {
        // A valid accepted Definition can be visible before the Host has
        // finished making its executable runtime available. Re-read the
        // authoritative overview before one same-key mutation retry; this is
        // a recovery boundary, not an unbounded action retry loop.
        await props.reloadOverview({ identity }).catch(() => undefined);
        if (!isCurrent(context)) return;
        result = await runWithCancellableRetries(request, context.signal);
      }
      if (!isCurrent(context)) return;
      if (!result.ok) setError(result.error.message);
      else {
        props.acceptRun?.(identity, result.run);
        await refreshAfterAcceptance({ identity, runId: result.run.runId });
        if (!isCurrent(context)) return;
        props.setDialog(null);
        setFreshInput("");
        setNotice(
          `${result.run.runId}: fresh Workflow Run accepted with a new identity from the beginning.`,
        );
        props.setSelectedRunId(result.run.runId);
      }
    } catch {
      if (isCurrent(context)) setError("Kojo Host could not start a fresh Workflow Run.");
    } finally {
      finishAction(context);
    }
  };

  const reveal = async () => {
    const identity = props.identity();
    const run = props.run();
    if (identity === undefined || run === undefined || !props.production || !isAuthoritative())
      return;
    const context = beginAction("reveal", identity, run.runId);
    if (context === undefined) return;
    try {
      const revealWorkflowRun = props.revealWorkflowRun;
      const request =
        revealWorkflowRun === undefined
          ? Effect.flatMap(VisualizerApiClient, (client) =>
              client.RevealWorkflowRun({ identity, runId: run.runId }),
            )
          : Effect.promise(() => revealWorkflowRun(identity, run.runId, context.signal));
      const result: WorkflowRunQueryResult =
        revealWorkflowRun === undefined
          ? await runWithCancellableRetries(request, context.signal)
          : await visualizerApiRuntime.runPromise(request);
      if (!isCurrent(context)) return;
      if (!result.ok) setError(result.error.message);
      else {
        props.setRevealedRun(result.run);
        props.setDialog(null);
        setNotice(`${run.runId}: explicit sensitive-data reveal accepted for this view only.`);
      }
    } catch {
      if (isCurrent(context)) setError("Kojo Host could not reveal this Workflow Run.");
    } finally {
      finishAction(context);
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
