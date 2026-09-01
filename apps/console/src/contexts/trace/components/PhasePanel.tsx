import { useSolux } from "@carere/solux";
import { Link } from "@tanstack/solid-router";
import { createEffect, For, type JSX, onCleanup, Show } from "solid-js";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { Notice } from "../../shared/components/Notice.tsx";
import { Field, Pane } from "../../shared/components/Pane.tsx";
import { settled } from "../../shared/hooks/settled.ts";
import { axisDuration } from "../../shared/lib/duration.ts";
import { instant } from "../../shared/lib/instant.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useRun } from "../hooks/useRun.ts";
import { discriminatorOf, nameOf, phaseIdOf } from "../models/ids.ts";
import type { PhaseLine, PhaseState, RunDoc } from "../models/RunDoc.ts";
import { keepView } from "../models/view.ts";
import { deselected, selected, type WaterfallState } from "../services/waterfallStore.ts";
import { DetailPanel } from "./DetailPanel.tsx";

/**
 * Everything known about one phase — console.md §6, in the order somebody investigating reads it.
 *
 * **The record is already in hand.** The run document carries every phase, and this panel is a second
 * reader of the query the run view already made — same key, same cache, no second request. So opening
 * a phase costs nothing, and nothing in the panel can fail in a way that takes the waterfall with it.
 *
 * Captured Artifacts are fetched through the authenticated Run Artifact API and are shown at Run
 * level. This panel does not call repository-local trace endpoints.
 */

const stateTones: Record<PhaseState, BadgeTone> = {
  running: "running",
  interrupted: "waiting",
  succeeded: "good",
  failed: "danger",
};

/** The scope's name, or the word for having needed none. `host` is a fact, not an absence. */
const scopeLabel = (sandboxId: string | undefined): string =>
  sandboxId === undefined ? "the host" : (nameOf(sandboxId) ?? sandboxId);

export const PhasePanel = (props: {
  readonly runId: string;
  readonly name: string;
  readonly attempt: string;
}): JSX.Element => {
  const now = useNow();
  const run = useRun(() => props.runId);
  const store = useSolux<WaterfallState>();

  const phaseId = () => phaseIdOf(props.runId, props.name, props.attempt);
  const doc = (): RunDoc | undefined => settled(run);
  const record = (): PhaseLine | undefined =>
    doc()?.phases.find((phase) => phase.phaseId === phaseId());
  /** The phase the run is inside right now, when it is this one. It has no record and no outcome. */
  const inFlight = () => {
    const flying = doc()?.run.inFlight;
    return flying?.phaseId === phaseId() ? flying : undefined;
  };
  const known = () => record() !== undefined || inFlight() !== undefined;

  /**
   * The URL is the subject; the store follows it.
   *
   * console.md §8 gives selection to Solux — it is what synchronises the axis, the rows and this
   * panel — but the *route* is what a person pastes, so a deep link has to select the span it names.
   * One direction, decided here: the panel says what is open and the waterfall draws the ring. The
   * click that opened it navigated; it did not dispatch.
   */
  createEffect(() => {
    const open = phaseId();
    if (store.state.selected !== open) store.dispatch(selected(open));
  });
  // Only when the store still holds *this* phase. Moving from one panel to another disposes this
  // component and mounts the next, and the two orders that produces must not race: a cleanup that
  // fired after the next panel had claimed the selection would clear what is on screen.
  onCleanup(() => {
    if (store.state.selected === phaseId()) store.dispatch(deselected());
  });

  const kind = () => record()?.kind ?? inFlight()?.kind;
  const state = (): PhaseState =>
    inFlight() !== undefined ? "running" : (record()?.outcome ?? "running");
  const startedAt = () => record()?.startedAt ?? inFlight()?.startedAt ?? 0;
  const endedAt = () => record()?.endedAt ?? now();
  const sandboxId = () => record()?.sandboxId ?? inFlight()?.sandboxId;

  const failedChecks = (): ReadonlyArray<string> => record()?.verification?.failed ?? [];
  const hasErrors = (): boolean => record()?.errorTag !== undefined || failedChecks().length > 0;
  const hasRepositoryChanges = (): boolean =>
    record()?.repo !== undefined || (record()?.breaches ?? []).length > 0;

  return (
    <DetailPanel
      subject="phase"
      title={props.name}
      subtitle={phaseId()}
      runId={props.runId}
      states={
        <Show when={known()}>
          <Badge tone={stateTones[state()]}>{state()}</Badge>
          <Show when={kind()}>{(one) => <Badge tone="neutral">{one()}</Badge>}</Show>
        </Show>
      }
    >
      <Show
        when={known()}
        fallback={
          <Show
            when={doc()}
            fallback={<p class="text-muted-foreground text-sm">Loading the run…</p>}
          >
            {/*
             * A phase id one character wrong, in a URL somebody pasted. The run is on screen behind
             * this panel and the waterfall is intact; the only thing that is missing is the phase, so
             * that is the only thing this says.
             */}
            <Notice tone="empty" title={`This run has no phase ${phaseId()}.`}>
              <p class="mt-1">
                Every phase this run recorded is on the waterfall behind this panel. Close it, and
                click the one you meant.
              </p>
            </Notice>
          </Show>
        }
      >
        <Pane name="identity" title="Summary">
          <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <Field name="attempt" label="attempt">
              {record()?.attempt ?? inFlight()?.attempt}
            </Field>
            <Field name="started" label="started">
              {instant(startedAt())}
            </Field>
            <Field name="ended" label="ended" when={record() !== undefined} absent="still running">
              {instant(endedAt())}
            </Field>
            <Field name="duration" label="duration">
              {axisDuration(endedAt() - startedAt())}
            </Field>
            <Field
              name="description"
              label="description"
              when={record()?.description !== undefined}
              absent="written on exit"
            >
              {record()?.description}
            </Field>
          </div>
        </Pane>

        {/*
         * Who was asked, and what the turn cost. Absent on a code phase, which asked nobody — and
         * that is a fact about the phase rather than a gap in the record.
         */}
        <Show when={kind() === "agent"}>
          <Pane name="agent" title="Agent">
            <Show
              when={record()?.agent}
              fallback={
                <p data-agent="none" class="text-muted-foreground text-xs italic">
                  Agent details are written when the call completes.
                </p>
              }
            >
              {(agent) => (
                <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  <Field name="agent-name" label="agent">
                    {agent().agent}
                  </Field>
                  <Field name="model" label="model">
                    {agent().model}
                  </Field>
                  <Field name="session" label="session">
                    {agent().session}
                  </Field>
                  <Field name="resumed" label="session start">
                    {agent().resumed ? "resumed" : "cold"}
                  </Field>
                  <Field name="tokens-in" label="tokens in">
                    {agent().tokensIn.toLocaleString("en-GB")}
                  </Field>
                  <Field name="tokens-out" label="tokens out">
                    {agent().tokensOut.toLocaleString("en-GB")}
                  </Field>
                  <Show when={agent().contextTokens !== undefined}>
                    <Field name="context" label="context used after the turn">
                      {agent().contextTokens?.toLocaleString("en-GB")} tokens
                    </Field>
                  </Show>
                  <Show when={(record()?.verification?.corrections ?? 0) > 0}>
                    <Field name="corrections" label="correction turns">
                      {record()?.verification?.corrections}
                    </Field>
                  </Show>
                </div>
              )}
            </Show>
          </Pane>
        </Show>

        <Show when={hasErrors()}>
          <Pane name="errors" title="Errors">
            <div class="flex flex-col gap-3">
              <Show when={record()?.errorTag}>
                {(tag) => (
                  <p data-error={tag()} class="text-sm">
                    {errorMessage(tag())}
                  </p>
                )}
              </Show>
              <Show when={failedChecks().length > 0}>
                <Field name="failed-checks" label="failed checks">
                  <For each={failedChecks()}>
                    {(check) => (
                      <span data-check={check} data-check-held="false" class="mr-1 inline-block">
                        ✗ {check}
                      </span>
                    )}
                  </For>
                </Field>
              </Show>
            </div>
          </Pane>
        </Show>

        <Show when={hasRepositoryChanges()}>
          <Pane name="repo" title="Repository changes">
            <Show when={record()?.repo}>
              {(repo) => (
                <div class="flex flex-col gap-2">
                  <Field
                    name="claimed"
                    label="reported files"
                    when={repo().claimed.length > 0}
                    absent="nothing"
                  >
                    {repo().claimed.join(", ")}
                  </Field>
                  <Field
                    name="changed"
                    label="changed files"
                    when={repo().changed.length > 0}
                    absent="nothing"
                  >
                    {repo().changed.join(", ")}
                  </Field>
                  <Show when={!sameFiles(repo().claimed, repo().changed)}>
                    <p data-repo="disagrees" class="text-xs text-amber-700 dark:text-amber-300">
                      The reported files do not match the files that changed.
                    </p>
                  </Show>
                  <Field
                    name="commits"
                    label="commits"
                    when={repo().commits.length > 0}
                    absent="none"
                  >
                    {repo().commits.join(", ")}
                  </Field>
                </div>
              )}
            </Show>

            {/*
             * A breach is not a failed check. It is a repository change outside the permission
             * policy, and the outcome says whether Kojo restored the path or work was lost.
             */}
            <Show when={(record()?.breaches ?? []).length > 0}>
              <div data-breaches class="flex flex-col gap-1">
                <For each={record()?.breaches ?? []}>
                  {(breach) => (
                    <div
                      data-breach={breach.path}
                      data-breach-outcome={breach.outcome._tag}
                      class="flex items-center gap-2 text-xs"
                    >
                      <Badge tone={breach.outcome._tag === "Restored" ? "waiting" : "danger"}>
                        {breach.outcome._tag === "Restored" ? "restored" : "work lost"}
                      </Badge>
                      <span class="min-w-0 truncate font-mono">{breach.path}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Pane>
        </Show>

        <Pane name="where" title="Where it ran">
          <Show
            when={sandboxId()}
            fallback={
              <p data-where="host" class="text-xs">
                On the host. This phase needed no container.
              </p>
            }
          >
            {(inside) => (
              // The sandbox band is a whole record, so *where it ran* is a way into the panel's other
              // subject rather than a word.
              <Link
                to="/runs/$runId/sandboxes/$name/$acquisition"
                params={{
                  runId: props.runId,
                  name: nameOf(inside()) ?? inside(),
                  acquisition: discriminatorOf(inside()),
                }}
                search={keepView}
                data-where="sandbox"
                data-sandbox={inside()}
                class="self-start text-xs underline underline-offset-2"
              >
                inside the {scopeLabel(inside())} sandbox →
              </Link>
            )}
          </Show>
        </Pane>
      </Show>
    </DetailPanel>
  );
};

/** A short explanation for a trace tag. Unknown tags stay visible instead of disappearing. */
const errorMessage = (tag: string): string => {
  switch (tag) {
    case "AgentInvocationError":
      return "Kojo could not complete the agent call.";
    case "CheckViolation":
      return "One or more checks failed.";
    case "EnvelopeParseError":
      return "The agent answer did not match the required format.";
    case "PermissionBreach":
      return "The phase changed files outside its permission policy.";
    default:
      return `The phase failed with ${tag}.`;
  }
};

/**
 * Two path lists, compared as sets. Order is not a fact either column is making a claim about.
 *
 * Joined on NUL because it is the one byte a path cannot hold, so no two distinct lists can join to
 * the same string. Written as the escape and never as the literal byte: a source file carrying a raw
 * NUL reads as *binary* to `grep`, and the whole file then goes silently missing from every search
 * the next reader makes.
 */
const sameFiles = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length &&
  [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
