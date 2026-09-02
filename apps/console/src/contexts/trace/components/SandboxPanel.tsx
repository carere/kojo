import { useSolux } from "@carere/solux";
import { Link } from "@tanstack/solid-router";
import { createEffect, For, type JSX, onCleanup, Show } from "solid-js";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { ResourceList } from "../../shared/components/data-grid/ResourceList.tsx";
import { Notice } from "../../shared/components/Notice.tsx";
import { Field, Pane } from "../../shared/components/Pane.tsx";
import { settled } from "../../shared/hooks/settled.ts";
import { axisDuration } from "../../shared/lib/duration.ts";
import { instant } from "../../shared/lib/instant.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useRun } from "../hooks/useRun.ts";
import { acquiredAtOf, nameOf, sandboxIdOf } from "../models/ids.ts";
import type { PhaseLine, RunDoc, SandboxLine } from "../models/RunDoc.ts";
import { keepView } from "../models/view.ts";
import { deselected, scoped, type WaterfallState } from "../services/waterfallStore.ts";
import { DetailPanel } from "./DetailPanel.tsx";

/**
 * One **acquisition** of one sandbox — the panel's second subject.
 *
 * console.md §6 is emphatic that the band on the waterfall is not scenery. It is a whole record, and
 * the reason it deserves a panel of its own is the run this Console was designed around: a hotfix
 * that suspends at a gate tears its container down and builds it again on resume, so the same scope
 * of the same run produces two acquisitions. **The second one is what a mid-lane gate cost.** That is
 * a number nobody would go looking for, and it is stated here as the gap between the first release
 * and this acquisition.
 *
 * An acquisition the trace has no record of is drawn too, and says why: a sandbox row is written when
 * the sandbox is **released**, so a container in use right now is named by its phases and by nothing
 * else. Refusing to render it would make the panel disagree with the waterfall, which already draws
 * that row.
 */

const outcomeTones: Record<string, BadgeTone> = {
  released: "good",
  interrupted: "waiting",
  failed: "danger",
};

export const SandboxPanel = (props: {
  readonly runId: string;
  readonly name: string;
  readonly acquisition: string;
}): JSX.Element => {
  const now = useNow();
  const run = useRun(() => props.runId);
  const store = useSolux<WaterfallState>();

  const sandboxId = () => sandboxIdOf(props.runId, props.name, props.acquisition);
  const doc = (): RunDoc | undefined => settled(run);
  const record = (): SandboxLine | undefined =>
    doc()?.sandboxes.find((sandbox) => sandbox.sandboxId === sandboxId());

  /** Every phase that ran inside this acquisition — the column that makes the row a fact. */
  const inside = (): ReadonlyArray<PhaseLine> =>
    (doc()?.phases ?? []).filter((phase) => phase.sandboxId === sandboxId());
  /** The phase the run is inside right now, when it is inside *this* acquisition. */
  const flying = () => {
    const one = doc()?.run.inFlight;
    return one?.sandboxId === sandboxId() ? one : undefined;
  };
  const known = () => record() !== undefined || inside().length > 0 || flying() !== undefined;

  /** Every acquisition of this same scope, oldest first. What makes a rebuild countable. */
  const siblings = (): ReadonlyArray<SandboxLine> =>
    [...(doc()?.sandboxes ?? [])]
      .filter((sandbox) => nameOf(sandbox.sandboxId) === props.name)
      .sort((left, right) => left.acquiredAt - right.acquiredAt);
  const ordinal = () => siblings().findIndex((one) => one.sandboxId === sandboxId()) + 1;
  /**
   * How long this scope stood torn down before it was built again.
   *
   * The dead time between the release of the previous acquisition of this scope and this one. On the
   * run console.md is built around, that number *is* the gate: forty-one hours during which the
   * factory held nothing at all.
   */
  const idleBefore = (): number | undefined => {
    const previous = siblings()[ordinal() - 2];
    const acquired = acquiredAt();
    return previous === undefined || acquired === undefined
      ? undefined
      : acquired - previous.releasedAt;
  };

  /**
   * What the build itself cost — from acquiring the container to the first phase running inside it.
   *
   * This is the other half of what a mid-lane gate imposes, and the half nobody would go looking
   * for: ninety seconds of setup that produced no work at all, paid again on every rebuild.
   */
  const setupCost = (): number | undefined => {
    const first = [...inside()].sort((left, right) => left.startedAt - right.startedAt)[0];
    const acquired = acquiredAt();
    return first === undefined || acquired === undefined ? undefined : first.startedAt - acquired;
  };

  createEffect(() => {
    const open = sandboxId();
    if (store.state.scope !== open) store.dispatch(scoped(open));
  });
  // Only when the store still holds this acquisition — see the same note in `PhasePanel`.
  onCleanup(() => {
    if (store.state.scope === sandboxId()) store.dispatch(deselected());
  });

  const acquiredAt = () => record()?.acquiredAt ?? acquiredAtOf(sandboxId());
  const releasedAt = () => record()?.releasedAt;

  return (
    <DetailPanel
      subject="sandbox"
      title={props.name}
      subtitle={sandboxId()}
      runId={props.runId}
      states={
        <Show when={known()}>
          <Badge tone={outcomeTones[record()?.outcome ?? ""] ?? "running"}>
            {record()?.outcome ?? "held"}
          </Badge>
          <Show when={siblings().length > 1}>
            <Badge tone="neutral">
              acquisition {ordinal()} of {siblings().length}
            </Badge>
          </Show>
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
            <Notice tone="empty" title={`This run has no acquisition ${sandboxId()}.`}>
              <p class="mt-1">
                Every scope this run held is a row on the waterfall behind this panel.
              </p>
            </Notice>
          </Show>
        }
      >
        <Show when={record() === undefined}>
          <p data-sandbox-state="held" class="text-xs italic">
            This container has not been released, so the trace has no row for it yet. An acquisition
            is written when it ends; what is below comes from the phases running inside it.
          </p>
        </Show>

        <Pane name="provider" title="What it is">
          <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <Field
              name="provider"
              label="provider"
              when={record()?.provider !== undefined}
              absent="written on release"
            >
              {record()?.provider}
            </Field>
            <Field
              name="sandbox-kind"
              label="kind"
              when={record()?.kind !== undefined}
              absent="written on release"
            >
              {record()?.kind}
            </Field>
            {/*
             * The image is the **run's**, and it is labelled so. No provider in Kojo resolves a
             * digest per acquisition yet, and putting the run's value under a heading that implied
             * otherwise would be a fabricated fact rather than a missing one.
             */}
            <Field
              name="image"
              label="image digest (of the run)"
              when={doc()?.run.run.imageDigest !== undefined}
              absent="no image digest was resolved"
            >
              {doc()?.run.run.imageDigest}
            </Field>
            {/*
             * Hooks are on the *request* a scope makes and are not kept on the acquisition, so the
             * trace cannot say which ran. Said outright, because a heading with nothing under it
             * reads as a Console that failed to load something.
             */}
            <Field name="hooks" label="hooks" when={false} absent="the trace records no hook run" />
          </div>
        </Pane>

        <Pane name="durable" title="What outlives it">
          <div class="flex flex-col gap-2">
            {/* The branch is the durable state the container was derived from — the thing that lives. */}
            <Field
              name="branch"
              label="branch"
              when={record()?.branch !== undefined}
              absent="written on release"
            >
              {record()?.branch}
            </Field>
            <Field
              name="worktree"
              label="worktree"
              when={record()?.worktreePath !== undefined}
              absent="written on release"
            >
              {record()?.worktreePath}
            </Field>
            <Field
              name="environment"
              label="what crossed into it"
              when={Object.keys(record()?.environment ?? {}).length > 0}
              absent="written on release"
            >
              <For each={Object.entries(record()?.environment ?? {})}>
                {([key, value]) => (
                  <span data-environment={key} class="mr-2 inline-block">
                    {key}={value}
                  </span>
                )}
              </For>
            </Field>
          </div>
        </Pane>

        <Pane name="lifetime" title="Its life">
          <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <Field name="acquired" label="acquired" when={acquiredAt() !== undefined}>
              {instant(acquiredAt() ?? 0)}
            </Field>
            <Field
              name="released"
              label="released"
              when={releasedAt() !== undefined}
              absent="still held"
            >
              {instant(releasedAt() ?? 0)}
            </Field>
            <Field name="lifetime" label="useful life">
              {axisDuration((releasedAt() ?? now()) - (acquiredAt() ?? now()))}
            </Field>
            {/*
             * The two numbers the row model exists to make visible. A second acquisition of one
             * scope is the rebuild a mid-lane gate forced: the first says how long the factory held
             * nothing, the second says what building it again cost before any work could resume.
             */}
            <Field
              name="idle"
              label="torn down before this"
              when={idleBefore() !== undefined}
              absent="the first acquisition of this scope"
            >
              {axisDuration(idleBefore() ?? 0)}
            </Field>
            <Field
              name="setup"
              label="setup before the first phase"
              when={setupCost() !== undefined}
              absent="no phase ran inside it"
            >
              {axisDuration(setupCost() ?? 0)}
            </Field>
          </div>
        </Pane>

        <Pane name="phases" title="What ran inside it">
          <Show
            when={inside().length > 0 || flying() !== undefined}
            fallback={
              <p data-inside="none" class="text-muted-foreground text-xs italic">
                Nothing ran inside this acquisition. It was built and torn down having done no work.
              </p>
            }
          >
            <div class="flex flex-col gap-1">
              <ResourceList
                emptyMessage="No completed Phases match this filter."
                items={inside()}
                label="Phases in this Sandbox"
                searchText={(phase) => `${phase.name}\n${phase.kind}\n${phase.outcome}`}
                render={(phase) => (
                  <Link
                    to="/runs/$runId/phases/$name/$attempt"
                    params={{
                      runId: props.runId,
                      name: phase.name,
                      attempt: String(phase.attempt),
                    }}
                    search={keepView}
                    data-inside={phase.phaseId}
                    class="flex items-center gap-2 text-xs underline underline-offset-2"
                  >
                    <span class="font-mono">{phase.name}</span>
                    <span class="text-muted-foreground">
                      {axisDuration(phase.endedAt - phase.startedAt)}
                    </span>
                  </Link>
                )}
              />
              <Show when={flying()}>
                {(one) => (
                  <div class="p-2">
                    <Link
                      to="/runs/$runId/phases/$name/$attempt"
                      params={{
                        runId: props.runId,
                        name: one().name,
                        attempt: String(one().attempt),
                      }}
                      search={keepView}
                      data-inside={one().phaseId}
                      class="flex items-center gap-2 text-xs underline underline-offset-2"
                    >
                      <span class="font-mono">{one().name}</span>
                      <span class="text-muted-foreground">running</span>
                    </Link>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </Pane>
      </Show>
    </DetailPanel>
  );
};
