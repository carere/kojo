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
import { useOccurrences } from "../hooks/useOccurrences.ts";
import { useRun } from "../hooks/useRun.ts";
import { discriminatorOf, nameOf, phaseIdOf } from "../models/ids.ts";
import type { PhaseLine, PhaseState, RunDoc, VerificationLine } from "../models/RunDoc.ts";
import { keepView } from "../models/view.ts";
import { deselected, selected, type WaterfallState } from "../services/waterfallStore.ts";
import { ArtifactPane } from "./ArtifactPane.tsx";
import { DetailPanel } from "./DetailPanel.tsx";
import { OccurrenceList } from "./OccurrenceList.tsx";

/**
 * Everything known about one phase — console.md §6, in the order somebody investigating reads it.
 *
 * **The record is already in hand.** The run document carries every phase, and this panel is a second
 * reader of the query the run view already made — same key, same cache, no second request. So opening
 * a phase costs nothing, and nothing in the panel can fail in a way that takes the waterfall with it.
 *
 * Five things come off the record and three do not:
 *
 * | Off the record | Fetched on demand |
 * |---|---|
 * | identity, the agent, the verdict, the effect on the repo, where it ran | the prompt, the session, the diff |
 *
 * The three on the right are not in the trace at all, by design — two are too large for a wide row
 * and the third is git's to supply — so each is its own request and each degrades on its own.
 *
 * **Occurrences are the sixth thing, and they live here and nowhere else.** They stream while the
 * phase is in flight and are a finished list once it is not.
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

  const stream = useOccurrences({
    runId: () => props.runId,
    phaseId,
    live: () => inFlight() !== undefined,
  });

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
          <Show when={record()?.errorTag}>{(tag) => <Badge tone="danger">{tag()}</Badge>}</Show>
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
        <Pane name="identity" title="Identity">
          <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <Field name="run" label="run">
              {props.runId}
            </Field>
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
        <Pane name="agent" title="The agent">
          <Show
            when={record()?.agent}
            fallback={
              <p data-agent="none" class="text-muted-foreground text-xs italic">
                {kind() === "agent"
                  ? "No agent call was recorded for this phase."
                  : `A ${kind() ?? "code"} phase asks nobody. There is no agent, no model and no session.`}
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
                {/*
                 * Cold or resumed, off the row rather than guessed from the session id. After the
                 * fact the two are different questions: the id says *which* conversation, this says
                 * whether the turn paid for a cold start.
                 */}
                <Field name="resumed" label="start">
                  {agent().resumed ? "resumed" : "cold"}
                </Field>
                <Field name="tokens-in" label="tokens in">
                  {agent().tokensIn.toLocaleString("en-GB")}
                </Field>
                <Field name="tokens-out" label="tokens out">
                  {agent().tokensOut.toLocaleString("en-GB")}
                </Field>
                {/*
                 * How much room the *next* turn has, which is not what the turn cost. A correction
                 * loop that keeps re-entering one session fails by running out of window, and this
                 * is the only column that sees it coming. Absent is *not reported*, never zero.
                 */}
                <Field
                  name="context"
                  label="context after the turn"
                  when={agent().contextTokens !== undefined}
                  absent="not reported"
                >
                  {agent().contextTokens?.toLocaleString("en-GB")} tokens
                </Field>
              </div>
            )}
          </Show>
        </Pane>

        <Pane name="verdict" title="The verdict">
          <Show
            when={record()?.verification}
            fallback={
              <p data-verdict="none" class="text-muted-foreground text-xs italic">
                {inFlight() === undefined
                  ? "This phase graded nothing. A code phase has no envelope to decode."
                  : "The verdict is written when the phase exits."}
              </p>
            }
          >
            {(verification) => (
              <div class="flex flex-col gap-2">
                <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  <Field name="envelope" label="envelope">
                    {verification().envelope}
                  </Field>
                  {/*
                   * Whether it decoded, said outright. Decoding the envelope *is* a verification, and
                   * an empty `failed` list on a phase that never got that far would otherwise read as
                   * *every check held*.
                   */}
                  <Field name="decoded" label="decoded">
                    {record()?.errorTag === "EnvelopeParseError" ? "no" : "yes"}
                  </Field>
                  <Field name="corrections" label="corrections">
                    {verification().corrections}
                  </Field>
                  <Field name="correctable" label="correctable">
                    {verification().correctable ? "yes" : "no — the invoker cannot resume"}
                  </Field>
                  <Field
                    name="error-tag"
                    label="terminal error"
                    when={record()?.errorTag !== undefined}
                    absent="none"
                  >
                    {record()?.errorTag}
                  </Field>
                </div>
                {/*
                 * Every check that ran, and every check that did not hold — as one list, because a
                 * check that failed is by definition one that ran. Drawing only `ran` would let a
                 * record whose two lists disagree hide the failure, which is the one thing on this
                 * pane that must never be possible.
                 */}
                <Field
                  name="checks-ran"
                  label="checks"
                  when={checksOf(verification()).length > 0}
                  absent="this phase ran no check"
                >
                  <For each={checksOf(verification())}>
                    {(check) => (
                      <span
                        data-check={check}
                        data-check-held={verification().failed.includes(check) ? "false" : "true"}
                        class="mr-1 inline-block"
                      >
                        {verification().failed.includes(check) ? "✗" : "✓"} {check}
                      </span>
                    )}
                  </For>
                </Field>
              </div>
            )}
          </Show>
        </Pane>

        <Pane name="repo" title="The effect on the repository">
          <Show
            when={record()?.repo}
            fallback={
              <p data-repo="none" class="text-muted-foreground text-xs italic">
                This phase changed nothing it was permitted to change.
              </p>
            }
          >
            {(repo) => (
              <div class="flex flex-col gap-2">
                {/*
                 * The pair, side by side, because the pair is the question: *did the answer describe
                 * the work?* A diff cannot answer it — it only ever shows what actually happened.
                 */}
                <Field
                  name="claimed"
                  label="claimed"
                  when={repo().claimed.length > 0}
                  absent="nothing"
                >
                  {repo().claimed.join(", ")}
                </Field>
                <Field
                  name="changed"
                  label="changed"
                  when={repo().changed.length > 0}
                  absent="nothing"
                >
                  {repo().changed.join(", ")}
                </Field>
                <Show when={!sameFiles(repo().claimed, repo().changed)}>
                  <p data-repo="disagrees" class="text-xs text-amber-700 dark:text-amber-300">
                    What the answer claimed and what the working tree held are not the same list.
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
           * A breach is not a check violation, and it does not belong beside the permitted changes.
           * A failed check is an answer that was refused; a breach is a change the agent had no
           * permission to make, and the outcome is the only place a human learns whether the
           * repository is still holding something no rollback could take back.
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
                      {breach.outcome._tag}
                    </Badge>
                    <span class="min-w-0 truncate font-mono">{breach.path}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Pane>

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

        <OccurrenceList occurrences={stream.occurrences()} live={inFlight() !== undefined} />

        <ArtifactPane
          runId={props.runId}
          phaseId={phaseId()}
          kind="prompt"
          title="The rendered prompt"
          about="System and user, as the agent received it."
          available={record() !== undefined}
        />
        <ArtifactPane
          runId={props.runId}
          phaseId={phaseId()}
          kind="session"
          title="The captured session"
          about="The transcript. Without it, a correction count is a number nobody can audit."
          available={record() !== undefined}
        />
        <ArtifactPane
          runId={props.runId}
          phaseId={phaseId()}
          kind="diff"
          title="The diff"
          about="Read from git on the run's branch. The record lists which files changed; git supplies the content."
          available={record() !== undefined}
        />
      </Show>
    </DetailPanel>
  );
};

/** Every check this phase graded against: the ones it ran, plus any failure not among them. */
const checksOf = (verification: VerificationLine): ReadonlyArray<string> => [
  ...verification.ran,
  ...verification.failed.filter((check) => !verification.ran.includes(check)),
];

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
