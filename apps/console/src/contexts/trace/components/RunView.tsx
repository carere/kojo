import { SoluxProvider } from "@carere/solux";
import { Link, Outlet, useNavigate } from "@tanstack/solid-router";
import { createSignal, type JSX, Show } from "solid-js";
import { cancelRun, retryUncertainAction } from "../../daemon/services/browserAccess.ts";
import { GateCard } from "../../gate/components/GateCard.tsx";
import { useAskings } from "../../gate/hooks/useAskings.ts";
import { type Asking, latestAskingOf } from "../../gate/models/Asking.ts";
import { awaitingApply } from "../../gate/models/answering.ts";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { Notice } from "../../shared/components/Notice.tsx";
import { refusal, retrying, settled } from "../../shared/hooks/settled.ts";
import { axisDuration } from "../../shared/lib/duration.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useRun } from "../hooks/useRun.ts";
import { discriminatorOf, nameOf } from "../models/ids.ts";
import type { RunDoc } from "../models/RunDoc.ts";
import { isTerminal, type RunStatus } from "../models/RunLine.ts";
import type { RunViewMode } from "../models/view.ts";
import { type PhaseSpan, spansOf } from "../models/waterfall.ts";
import { waterfallStore } from "../services/waterfallStore.ts";
import { Invocations } from "./Invocations.tsx";
import { PhaseTable } from "./PhaseTable.tsx";
import { PublishedArtifacts } from "./PublishedArtifacts.tsx";
import { RunOutcome } from "./RunOutcome.tsx";
import { Waterfall } from "./Waterfall.tsx";

/** Show the Run header, Waterfall or table, and nested detail panel. Provide one interaction store to the Waterfall and panel; keep the view choice in the URL. */

const statusTones: Record<string, BadgeTone> = {
  executing: "running",
  suspended: "waiting",
  held: "danger",
  succeeded: "good",
  failed: "danger",
  cancelled: "danger",
};

/** How long the run has been going, or how long it took. Both come from the injected clock. */
const elapsedOf = (doc: RunDoc, now: number): string => {
  const finished =
    doc.run.outcome === "succeeded" ||
    doc.run.outcome === "failed" ||
    doc.run.outcome === "cancelled";
  const until = finished ? (doc.run.finishedAt ?? now) : now;
  return axisDuration(until - doc.run.run.startedAt);
};

/**
 * One provenance fact in the run header: its name, then its value, on one line.
 *
 * The panel's `Field` stacks the label above the value, which is right in a panel and wrong here —
 * the header sits above the timeline on every run and doubling its height is a real cost. Same
 * vocabulary, laid out for a header.
 */
const Stamp = (props: {
  readonly name: string;
  readonly label: string;
  readonly children?: JSX.Element;
  readonly absent?: string;
  readonly when?: boolean;
}): JSX.Element => (
  // Header facts use a separate attribute from panel fields.
  <span data-stamp={props.name} class="flex min-w-0 items-baseline gap-1.5">
    <span class="text-muted-foreground text-[10px] tracking-[0.08em] uppercase">{props.label}</span>
    <Show
      when={props.when ?? true}
      fallback={<span class="text-muted-foreground/70 text-xs italic">{props.absent ?? "—"}</span>}
    >
      <span class="min-w-0 break-all text-foreground/80 font-mono text-xs">{props.children}</span>
    </Show>
  </span>
);

export const RunView = (props: {
  readonly runId: string;
  readonly mode: RunViewMode;
}): JSX.Element => {
  const now = useNow();
  const run = useRun(() => props.runId);
  const store = waterfallStore();
  const navigate = useNavigate();
  const [cancelAcknowledged, setCancelAcknowledged] = createSignal(false);
  const [cancelNotice, setCancelNotice] = createSignal<string>();
  const [cancelPending, setCancelPending] = createSignal(false);
  const [retryActionId, setRetryActionId] = createSignal("");
  const [retryReason, setRetryReason] = createSignal("");
  const [duplicationAcknowledged, setDuplicationAcknowledged] = createSignal(false);
  const [retryPending, setRetryPending] = createSignal(false);
  const [retryNotice, setRetryNotice] = createSignal<string>();

  const doc = () => settled(run);
  const status = (): RunStatus => doc()?.daemon?.state ?? doc()?.run.outcome ?? "executing";
  /** The server answered, and what it answered was *there is no such run*. */
  const missing = () => refusal(run);
  const requestCancellation = async (): Promise<void> => {
    if (!cancelAcknowledged()) return;
    setCancelPending(true);
    try {
      const result = await cancelRun(props.runId);
      setCancelNotice(
        result.cancellation === "confirmed"
          ? "Run cancellation is confirmed. Execution stopped."
          : "Cancellation intent is durable. Execution stop is not confirmed.",
      );
      setCancelAcknowledged(false);
      await run.refetch();
    } catch (cause) {
      setCancelNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCancelPending(false);
    }
  };
  const requestUncertainRetry = async (actionId: string): Promise<void> => {
    if (retryActionId() !== actionId || retryReason().trim() === "" || !duplicationAcknowledged())
      return;
    setRetryPending(true);
    try {
      await retryUncertainAction({
        runId: props.runId,
        actionId,
        reason: retryReason().trim(),
        possibleDuplicationAcknowledged: true,
      });
      setRetryNotice(`Retry authorization is durable for exact Action ${actionId}.`);
      setDuplicationAcknowledged(false);
      await run.refetch();
    } catch (cause) {
      setRetryNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetryPending(false);
    }
  };

  /**
   * The askings, polled while this run can still move.
   *
   * A gate that is **still waiting** has no trace record — the trace writes one when the asking
   * settles — so the run document cannot say what a suspended run is stopped on. The askings are the
   * other half, and the two are read together: the request comes from here, and whether the run has
   * picked the answer up comes from the document.
   */
  const gates = useAskings(() => !isTerminal(status()));
  /**
   * The asking the card is about: the newest of this run's, answered or not.
   *
   * **Not the newest *unanswered* one**, and the difference is adr/gate/0001 in one line. An asking
   * that has just been answered is exactly when somebody most needs the card on screen, because that
   * is when the Console has to say whether anything applied it. A card that vanished on a successful
   * `POST` would disappear at the instant it became the only honest thing on the page.
   */
  const openGate = (): Asking | undefined => latestAskingOf(settled(gates) ?? [], props.runId);

  /**
   * A click on a span is a navigation, and clicking the open one again closes the panel.
   *
   * The store is what says which is open — it is written by the panel that the route mounted — so a
   * span never has to know whether the URL it is about to build is the one already loaded.
   */
  const pickPhase = (span: PhaseSpan): void => {
    if (store.state.selected === span.phaseId) {
      void navigate({
        to: "/runs/$runId",
        params: { runId: props.runId },
        search: { view: props.mode },
      });
      return;
    }
    void navigate({
      to: "/runs/$runId/phases/$name/$attempt",
      params: { runId: props.runId, name: span.name, attempt: String(span.attempt) },
      search: { view: props.mode },
    });
  };

  /** The same, for the panel's other subject: the band behind a row is a whole record. */
  const pickScope = (sandboxId: string): void => {
    if (store.state.scope === sandboxId) {
      void navigate({
        to: "/runs/$runId",
        params: { runId: props.runId },
        search: { view: props.mode },
      });
      return;
    }
    void navigate({
      to: "/runs/$runId/sandboxes/$name/$acquisition",
      params: {
        runId: props.runId,
        name: nameOf(sandboxId) ?? sandboxId,
        acquisition: discriminatorOf(sandboxId),
      },
      search: { view: props.mode },
    });
  };

  return (
    <main class="mx-auto flex w-full max-w-[100rem] min-w-0 break-words flex-col gap-4 px-6 py-8">
      <nav class="text-muted-foreground text-xs">
        <Link to="/" class="hover:underline">
          ← every run
        </Link>
      </nav>

      {/*
       * Retrying, and not for a run that does not exist. `404 no-such-run` is the server answering
       * in three milliseconds; blaming the API for it would send somebody looking for an outage that
       * is not there while the actual fault — a character wrong in a pasted id — went unsaid.
       */}
      <Show when={retrying(run)}>
        <Notice tone="retrying" title="Cannot reach the Console API. Retrying…">
          <p class="mt-1">What is on screen is the last answer this Console received.</p>
        </Notice>
      </Show>

      <Show when={missing()}>
        {(problem) => (
          <Notice tone="empty" title={`There is no run ${props.runId} in this factory.`}>
            <p class="mt-1">
              The Console reached the API and it answered plainly: {problem().message}. Nothing is
              wrong with the server, and nothing is being retried.
            </p>
            <p class="mt-1">
              <Link to="/" class="underline underline-offset-2">
                Every run this factory has
              </Link>
            </p>
          </Notice>
        )}
      </Show>

      <Show
        when={doc()}
        fallback={
          <Show when={missing() === undefined}>
            <p class="text-muted-foreground text-sm">Loading the run…</p>
          </Show>
        }
      >
        {(document) => (
          <>
            <header class="flex flex-col gap-2" data-run-header={document().run.run.runId}>
              <div class="flex flex-wrap items-center gap-3">
                <h1 class="min-w-0 break-all font-mono text-lg font-semibold">
                  {document().run.run.runId}
                </h1>
                <Badge tone={statusTones[status()] ?? "neutral"}>{status()}</Badge>
                <span class="text-muted-foreground text-sm">{document().run.run.workflow}</span>
                <span class="text-muted-foreground text-sm" data-elapsed>
                  {elapsedOf(document(), now())}
                </span>
              </div>
              <details class="rounded border border-border p-3">
                <summary class="cursor-pointer text-sm">Technical details</summary>
                <div class="flex flex-wrap items-baseline gap-x-5 gap-y-1" data-run-stamp>
                  <Show when={document().daemon}>
                    {(daemon) => (
                      <>
                        <Stamp name="project" label="Project">
                          {daemon().projectId}
                        </Stamp>
                        <Stamp name="revision" label="Pinned revision">
                          {daemon().revisionId}
                        </Stamp>
                        <Stamp name="graph" label="Pinned graph">
                          {daemon().packageGraphId}
                        </Stamp>
                        <Stamp name="execution" label="Execution">
                          {daemon().queueReason ?? daemon().state}
                        </Stamp>
                      </>
                    )}
                  </Show>
                  <Stamp name="engine" label="engine">
                    {document().run.run.engineVersion}
                  </Stamp>
                  <Stamp name="commit" label="commit">
                    {document().run.run.engineCommit}
                  </Stamp>
                  <Stamp name="host" label="host">
                    {document().run.run.host}
                  </Stamp>
                  <Stamp name="config" label="Factory revision">
                    {document().run.run.configDigest}
                  </Stamp>
                  <Stamp name="idempotency-key" label="idempotency key">
                    {document().run.run.idempotencyKey}
                  </Stamp>
                  <Stamp
                    name="branch"
                    label="branch"
                    absent="no sandbox was acquired"
                    when={document().sandboxes[0] !== undefined}
                  >
                    {document().sandboxes[0]?.branch}
                  </Stamp>
                </div>
              </details>
            </header>

            <Show when={document().daemon?.executionFault}>
              {(fault) => (
                <Notice tone="empty" title={`Pinned content fault: ${fault().code}`}>
                  <p class="mt-1">{fault().detail}</p>
                  <p class="mt-1 font-mono text-xs">Remedy: {fault().remedy}</p>
                </Notice>
              )}
            </Show>

            <Show when={document().daemon?.cancellation}>
              {(cancellation) => (
                <Notice
                  tone={cancellation().state === "confirmed" ? "empty" : "retrying"}
                  title={
                    cancellation().state === "confirmed"
                      ? "Run Cancelled — execution stopped"
                      : "Cancellation requested — execution stop is not confirmed"
                  }
                >
                  <p class="mt-1">
                    Source: {cancellation().source}. Requested: {cancellation().requestedAt}.
                  </p>
                </Notice>
              )}
            </Show>

            <Show when={document().daemon?.recovery}>
              {(recovery) => (
                <Notice tone="retrying" title="Interrupted sibling recovery">
                  <p class="mt-1">{recovery().detail}</p>
                </Notice>
              )}
            </Show>

            <Show when={document().daemon?.cleanup}>
              {(cleanup) => (
                <Notice
                  tone={cleanup().state === "fault" ? "empty" : "retrying"}
                  title={`Resource cleanup: ${cleanup().state}`}
                >
                  <Show when={cleanup().detail}>{(detail) => <p class="mt-1">{detail()}</p>}</Show>
                </Notice>
              )}
            </Show>

            <Show when={document().daemon?.uncertainty}>
              {(uncertainty) => (
                <Notice
                  tone="retrying"
                  title={`External action uncertainty: ${uncertainty().state}`}
                >
                  <p class="mt-1">
                    Action <code class="break-all">{uncertainty().actionId}</code> for Phase{" "}
                    {uncertainty().phasePath}#{uncertainty().attempt} has no confirmed result.
                  </p>
                  <p class="mt-1 text-xs">
                    Missing output, timeout, replacement, a new Claim, and Trace absence do not
                    prove that this action did not occur. Recovery policy:{" "}
                    {uncertainty().recoveryPolicy}.
                  </p>
                  <Show when={uncertainty().evidence}>
                    {(evidence) => (
                      <p class="mt-1 text-xs">
                        Evidence: {evidence().kind} — {evidence().detail}
                      </p>
                    )}
                  </Show>
                  <Show when={uncertainty().state === "unresolved" && !isTerminal(status())}>
                    <section class="mt-3 grid max-w-2xl gap-2" aria-label="Retry uncertain action">
                      <label class="grid gap-1 text-sm">
                        Exact action ID
                        <input
                          class="rounded border bg-background px-2 py-1 font-mono text-xs"
                          value={retryActionId()}
                          onInput={(event) => setRetryActionId(event.currentTarget.value)}
                        />
                      </label>
                      <label class="grid gap-1 text-sm">
                        Reason
                        <textarea
                          class="rounded border bg-background px-2 py-1 text-sm"
                          value={retryReason()}
                          onInput={(event) => setRetryReason(event.currentTarget.value)}
                        />
                      </label>
                      <label class="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={duplicationAcknowledged()}
                          onChange={(event) =>
                            setDuplicationAcknowledged(event.currentTarget.checked)
                          }
                        />
                        <span>
                          I acknowledge that this retry can duplicate the external action.
                        </span>
                      </label>
                      <button
                        type="button"
                        class="w-fit rounded border border-red-700 px-3 py-1 text-red-700 text-sm dark:text-red-300"
                        disabled={
                          retryPending() ||
                          retryActionId() !== uncertainty().actionId ||
                          retryReason().trim() === "" ||
                          !duplicationAcknowledged()
                        }
                        onClick={() => void requestUncertainRetry(uncertainty().actionId)}
                      >
                        Retry exact action
                      </button>
                    </section>
                  </Show>
                  <Show when={retryNotice()}>
                    {(notice) => (
                      <p role="status" class="mt-2">
                        {notice()}
                      </p>
                    )}
                  </Show>
                </Notice>
              )}
            </Show>

            <Show when={!isTerminal(status())}>
              <section class="rounded border p-3" aria-label="Cancel Run">
                <label class="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={cancelAcknowledged()}
                    onChange={(event) => setCancelAcknowledged(event.currentTarget.checked)}
                  />
                  <span>
                    I understand that cancellation does not undo completed effects or prove Resource
                    cleanup.
                  </span>
                </label>
                <button
                  type="button"
                  class="mt-2 rounded border border-red-700 px-3 py-1 text-red-700 text-sm dark:text-red-300"
                  disabled={cancelPending() || !cancelAcknowledged()}
                  onClick={() => void requestCancellation()}
                >
                  Cancel Run
                </button>
                <Show when={cancelNotice()}>
                  {(notice) => (
                    <p role="status" class="mt-2 text-sm">
                      {notice()}
                    </p>
                  )}
                </Show>
              </section>
            </Show>

            {/* Show the Gates below the Run header. */}
            {/*
             * Why the run died, above the gate card and directly under the header. It renders on a
             * failed or breached run and on nothing else, so a healthy run's page is unchanged.
             */}
            <RunOutcome doc={document()} runId={props.runId} mode={props.mode} />

            <Show when={openGate()}>
              {(waiting) => (
                <Show when={!isTerminal(status()) || awaitingApply(waiting(), document().gates)}>
                  <GateCard asking={waiting()} settled={document().gates} runId={props.runId} />
                </Show>
              )}
            </Show>

            <div class="flex items-center gap-2 text-xs">
              {/*
               * Links rather than buttons, because the mode is a URL. A person pastes what they are
               * looking at; a toggle held in component state would paste as somebody else's default.
               */}
              <Link
                to="/runs/$runId"
                params={{ runId: props.runId }}
                search={{ view: "timeline" as const }}
                data-view="timeline"
                data-current={props.mode === "timeline" ? "true" : "false"}
                class={
                  props.mode === "timeline"
                    ? "border-foreground rounded-md border px-2 py-1"
                    : "border-border hover:bg-muted rounded-md border px-2 py-1"
                }
              >
                Timeline
              </Link>
              <Link
                to="/runs/$runId"
                params={{ runId: props.runId }}
                search={{ view: "table" as const }}
                data-view="table"
                data-current={props.mode === "table" ? "true" : "false"}
                class={
                  props.mode === "table"
                    ? "border-foreground rounded-md border px-2 py-1"
                    : "border-border hover:bg-muted rounded-md border px-2 py-1"
                }
              >
                Table
              </Link>
            </div>

            <SoluxProvider store={store}>
              <div class="flex flex-col gap-4">
                {/* Keep the Waterfall visible above the detail panel in one page flow. */}
                <div class="bg-background flex w-full min-w-0 flex-col gap-2 lg:sticky lg:top-0 lg:z-10 lg:max-h-[60vh] lg:overflow-x-hidden lg:overflow-y-auto lg:pt-2">
                  <Show
                    when={spansOf(document(), now()).length > 0}
                    fallback={
                      <Notice tone="empty" title="No phases yet.">
                        <p class="mt-1">
                          This run has started and has not entered a phase. Nothing has gone wrong.
                        </p>
                      </Notice>
                    }
                  >
                    <Show
                      when={props.mode === "timeline"}
                      fallback={<PhaseTable spans={spansOf(document(), now())} />}
                    >
                      <Waterfall doc={document()} onPickPhase={pickPhase} onPickScope={pickScope} />
                    </Show>
                  </Show>
                </div>

                <Invocations
                  invocations={document().invocations ?? []}
                  totals={document().invocationTotals}
                />
                <PublishedArtifacts runId={props.runId} artifacts={document().artifacts ?? []} />

                {/*
                 * The dock. It renders nothing at all when no detail route is matched, which is what
                 * keeps the run view exactly as wide as it was before anybody clicked.
                 */}
                <Outlet />
              </div>
            </SoluxProvider>
          </>
        )}
      </Show>
    </main>
  );
};
