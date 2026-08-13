import { SoluxProvider } from "@carere/solux";
import { Link, Outlet, useNavigate } from "@tanstack/solid-router";
import { type JSX, Show } from "solid-js";
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
import { PhaseTable } from "./PhaseTable.tsx";
import { Waterfall } from "./Waterfall.tsx";

/**
 * One run, in full depth — console.md §4.
 *
 * Three parts in descending order of how fast they answer a question: the header says *what now*, the
 * waterfall says *what happened*, and the detail panel says everything else. If you deleted the
 * waterfall the page would still be useful; if you deleted the header it would not.
 *
 * **The panel is a nested route rendered beside the waterfall, never over it.** `<Outlet />` is the
 * dock: a phase or an acquisition is a URL, so it survives being pasted, and the position somebody
 * clicked from stays on screen while they read it.
 *
 * **The timeline-or-table choice is in the URL**, per console.md §8: the URL is what a person pastes
 * to a colleague, and *"look at it as a table"* has to survive being pasted. Everything else the
 * waterfall knows about itself — zoom, hover, what the panel is open on — is Solux state, created
 * here and scoped to this view. The store is provided above the outlet as well as above the
 * waterfall, because synchronising those two is the whole of what console.md §8 gives it to do.
 */

const statusTones: Record<string, BadgeTone> = {
  executing: "running",
  suspended: "waiting",
  succeeded: "good",
  failed: "danger",
};

/** How long the run has been going, or how long it took. Both come from the injected clock. */
const elapsedOf = (doc: RunDoc, now: number): string => {
  const finished = doc.run.outcome === "succeeded" || doc.run.outcome === "failed";
  const until = finished ? (doc.run.finishedAt ?? now) : now;
  return axisDuration(until - doc.run.run.startedAt);
};

export const RunView = (props: {
  readonly runId: string;
  readonly mode: RunViewMode;
}): JSX.Element => {
  const now = useNow();
  const run = useRun(() => props.runId);
  const store = waterfallStore();
  const navigate = useNavigate();

  const doc = () => settled(run);
  const status = (): RunStatus => doc()?.run.outcome ?? "executing";
  /** The server answered, and what it answered was *there is no such run*. */
  const missing = () => refusal(run);

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
    <main class="mx-auto flex w-full max-w-[100rem] flex-col gap-4 px-6 py-8">
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
                <h1 class="font-mono text-lg font-semibold">{document().run.run.runId}</h1>
                <Badge tone={statusTones[status()] ?? "neutral"}>{status()}</Badge>
                <span class="text-muted-foreground text-sm">{document().run.run.workflow}</span>
                <span class="text-muted-foreground text-sm" data-elapsed>
                  {elapsedOf(document(), now())}
                </span>
              </div>
              <p class="text-muted-foreground font-mono text-xs">
                {document().run.run.engineVersion} · {document().run.run.engineCommit} ·{" "}
                {document().run.run.host} · {document().run.run.configDigest}
              </p>
            </header>

            {/*
             * The gate card, directly beneath the header — console.md §4 — because it is the one
             * thing on this page a person can act on.
             *
             * **It outlives the suspension it belongs to, on purpose.** A card that showed only
             * while `outcome === "suspended"` would disappear the instant a runner applied the
             * answer, which is the instant *applied — the run resumed* becomes the only sentence
             * worth reading. And a run that reached a terminal outcome with a verdict nobody applied
             * keeps its card too: an answer nobody applied is still an answer nobody applied, and
             * hiding it is the exact failure adr/gate/0001 was written against.
             */}
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
              <div class="flex flex-col items-start gap-4 lg:flex-row">
                <div class="flex w-full min-w-0 flex-1 flex-col gap-2">
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
