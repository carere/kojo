import { axisDuration, tickLabel } from "../../shared/lib/duration.ts";
import { acquiredAtOf, nameOf } from "./ids.ts";
import type { PhaseKind, PhaseState, RunDoc } from "./RunDoc.ts";

/**
 * The run waterfall, as pure geometry over one run document and one instant.
 *
 * Everything the run view draws is decided here and nothing is decided in a component, for the same
 * reason the run list's rows are: a component that computed a width from a clock could not be graded
 * without a browser, and a screenshot of it could not be stable. `now` is an argument.
 *
 * Two decisions carry the shape, and both are settled records rather than choices made here —
 * adr/trace/0001 and console.md §5:
 *
 * - **Rows are the scope tree, not concurrency lanes.** The host is the root row and each sandbox
 *   *acquisition* is a child row, so the vertical axis means *where this ran* — which nothing else
 *   answers — and the rebuild a mid-run gate forces appears as a second row without anybody building
 *   a rebuild indicator. A run is mostly sequential, so a conventional gantt would spend the whole
 *   vertical plane drawing a staircase.
 * - **The time axis breaks.** A realistic hotfix run is `route` 8 s and a gate 41 h. On a linear axis
 *   sized to 41 hours everything worth reading is a hairline, so any stretch that would flatten the
 *   rest of the run collapses to a fixed width labelled with its real duration. A 41-hour bar reads
 *   as *long* and cannot be measured; a break states the number.
 */

/** How wide a break is drawn, whatever it elides. Fixed, because that is what makes it a break. */
export const breakWidth = 88;

/**
 * How much room a break inside a *covered* stretch leaves at each end.
 *
 * The head and the tail of the span it cuts through. Without them a phase whose whole duration is
 * elided would be drawn as a two-pixel sliver — the break would delete the span it was called in to
 * make readable, which is the one thing it must never do.
 */
const spanEdge = 24;

/** How narrow a span may get before it stops being visible at all. */
const minimumSpanWidth = 2;

/** What the geometry is tuned by — Solux's state, defaulted here so the pure function stands alone. */
export interface BreakRule {
  /**
   * How much of the axis one stretch may take before it is collapsed.
   *
   * *"Would flatten the rest of the run"*, stated as a number. At `0.6` a stretch has to be longer
   * than everything else put together by half again before it breaks, so the ordinary long phase —
   * six minutes of an agent in a twelve-minute run — keeps its real width, and the forty-one hour
   * wait does not. Applied repeatedly: collapsing the worst re-scales the rest, and the next worst is
   * then judged against what is left.
   */
  readonly share: number;
  /**
   * The floor, below which nothing is ever collapsed however dominant it is.
   *
   * A run of two phases is *always* dominated by the longer one, and breaking an eight-second span
   * would replace a readable bar with a label saying `8s`. Ten minutes is the point below which a
   * stretch is still something a person can read on a timeline.
   *
   * **This argument is about a stretch with a bar in it.** See {@link deadFloorMillis}.
   */
  readonly floorMillis: number;
  /**
   * The same floor, for a stretch nothing runs in.
   *
   * The argument above does not reach dead time: a break over a span replaces a readable bar, and a
   * break over nothing replaces nothing. One floor for both was measured making the axis useless on
   * an ordinary run — 65.6 seconds of idle at the end of a 67-second run took 939 of 960 pixels,
   * because it cleared the share test and was saved only by the ten-minute floor. Every phase in
   * that run was then crammed into the leading 20 pixels, and the step table read that squashed
   * scale and chose `10s` ticks for 1.4 seconds of work.
   *
   * Thirty seconds, because that is about where a gap stops being the shape of the run and starts
   * being a wait. Below it, dead time is still something worth seeing the width of.
   */
  readonly deadFloorMillis: number;
}

export const defaultBreakRule: BreakRule = {
  share: 0.6,
  floorMillis: 10 * 60 * 1_000,
  deadFloorMillis: 30 * 1_000,
};

/**
 * One row of the waterfall: a scope, not a lane.
 *
 * `depth` is 0 for the host and 1 for an acquisition. There is no deeper nesting today because a
 * sandbox scope inside a sandbox scope is not something the engine builds; when it is, the field is
 * already what the indentation reads.
 */
export interface ScopeRow {
  readonly rowId: string;
  readonly label: string;
  readonly scope: "host" | "sandbox";
  readonly depth: number;
  /** *acquired 2 of 2* — what turns a rebuild into a fact instead of a duplicate-looking row. */
  readonly acquisition?: { readonly ordinal: number; readonly of: number };
  readonly outcome?: "released" | "interrupted" | "failed";
  readonly branch?: string;
  /** The band behind the spans: from acquisition to release, or to *now* while it is still held. */
  readonly from?: number;
  readonly to?: number;
  /** True for an acquisition the trace has no record of yet, because it has not been released. */
  readonly held: boolean;
}

/** One phase, as one span. Corrections are inside it; they are never spans of their own. */
export interface PhaseSpan {
  readonly phaseId: string;
  readonly name: string;
  readonly kind: PhaseKind;
  readonly state: PhaseState;
  readonly rowId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly attempt: number;
  /** How many correction turns the phase spent. Drawn as marks inside the one span. */
  readonly corrections: number;
  /** Paths the phase changed without permission. A breach is not a check violation. */
  readonly breaches: ReadonlyArray<string>;
  readonly errorTag?: string;
}

/**
 * One stretch of the axis.
 *
 * `linear` stretches share one scale, so two spans of equal duration on either side of a break are
 * drawn equally wide. A `break` is a fixed width whatever it elides, and carries the real duration as
 * its label — that is the whole trade: the position stops being measurable and the number becomes
 * readable.
 */
export interface AxisSegment {
  readonly kind: "linear" | "break";
  readonly from: number;
  readonly to: number;
  readonly offset: number;
  readonly width: number;
  /** Whether a phase or a sandbox covered this stretch. A break over nothing is the idle-hour case. */
  readonly dense: boolean;
  /** *41h 12m*, on a break. Absent on a linear stretch, which is measured rather than stated. */
  readonly label?: string;
  /**
   * Where the wall itself is drawn inside the segment.
   *
   * A break over **dead** time is the whole segment: nothing crosses it and it should read as a wall
   * through the run. A break inside something that was running is not — a three-hour phase whose
   * middle is elided has to keep a head and a tail, or the break would delete the very span it was
   * called in to make readable. So a dense break reserves a margin at each end for that span to be
   * drawn in, and the wall sits between them.
   */
  readonly wallOffset: number;
  readonly wallWidth: number;
}

export interface AxisTick {
  readonly at: number;
  readonly offset: number;
  /** Elapsed since the run started — never a wall-clock time, which would move with a timezone. */
  readonly label: string;
}

export interface Waterfall {
  readonly rows: ReadonlyArray<ScopeRow>;
  readonly spans: ReadonlyArray<PhaseSpan>;
  readonly segments: ReadonlyArray<AxisSegment>;
  readonly ticks: ReadonlyArray<AxisTick>;
  readonly width: number;
  readonly from: number;
  readonly to: number;
  /** The tick step, named — `1s`, `5m`, `1h`. Seconds are reachable; the reui default is not. */
  readonly scale: string;
  /** Where a span sits, in pixels. Every phase edge is an axis boundary, so this never guesses. */
  readonly xOf: (at: number) => number;
}

/** The host row's id. A constant because both the row and every host phase have to name it. */
export const hostRow = "host";

const isTerminal = (doc: RunDoc): boolean =>
  doc.run.outcome === "succeeded" || doc.run.outcome === "failed";

/**
 * The rows, in the order a scope tree reads: the host, then each acquisition oldest first.
 *
 * An acquisition a phase names but the trace has no record of gets a row anyway. That is not a
 * defensive branch — a sandbox record is written when the sandbox is **released**, so a phase running
 * inside a container right now names an acquisition that has no row yet, and putting it on the host
 * would say the work needed no container when it is inside one.
 */
export const rowsOf = (doc: RunDoc, now: number): ReadonlyArray<ScopeRow> => {
  const acquisitions = [...doc.sandboxes].sort((left, right) => left.acquiredAt - right.acquiredAt);
  const total = new Map<string, number>();
  for (const sandbox of acquisitions) {
    total.set(sandbox.name, (total.get(sandbox.name) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const rows: Array<ScopeRow> = [
    { rowId: hostRow, label: "host", scope: "host", depth: 0, held: false },
  ];

  for (const sandbox of acquisitions) {
    const ordinal = (seen.get(sandbox.name) ?? 0) + 1;
    seen.set(sandbox.name, ordinal);
    const of = total.get(sandbox.name) ?? 1;
    rows.push({
      rowId: sandbox.sandboxId,
      label: sandbox.name,
      scope: "sandbox",
      depth: 1,
      // Only when there is more than one. A lone acquisition numbered *1 of 1* is noise; a second
      // one is the cost of the gate, and saying so is the point of the row model.
      ...(of > 1 ? { acquisition: { ordinal, of } } : {}),
      outcome: sandbox.outcome,
      branch: sandbox.branch,
      from: sandbox.acquiredAt,
      to: sandbox.releasedAt,
      held: false,
    });
  }

  // Acquisitions still held: named by a phase, with no record because nothing has released them.
  const known = new Set(rows.map((row) => row.rowId));
  const running = [...doc.phases.map((line) => line.sandboxId), doc.run.inFlight?.sandboxId].filter(
    (sandboxId): sandboxId is string => sandboxId !== undefined && !known.has(sandboxId),
  );

  for (const sandboxId of new Set(running)) {
    const acquiredAt = acquiredAtOf(sandboxId);
    rows.push({
      rowId: sandboxId,
      label: nameOf(sandboxId) ?? sandboxId,
      scope: "sandbox",
      depth: 1,
      ...(acquiredAt === undefined ? {} : { from: acquiredAt }),
      to: now,
      held: true,
    });
  }

  return rows;
};

/**
 * Every phase as one span, plus the one that has not ended.
 *
 * **The in-flight phase is added only while the run can still be executing one.** A process killed
 * outright never clears the column, so a terminal run may still carry a stale value; drawing it would
 * put a span on a finished run that grows forever. And a phase that already has a record is never
 * drawn twice: the record wins, which is what *replaced by the real span on exit* means when a poll
 * catches the two states one after the other.
 */
export const spansOf = (doc: RunDoc, now: number): ReadonlyArray<PhaseSpan> => {
  const spans: Array<PhaseSpan> = doc.phases.map((line) => ({
    phaseId: line.phaseId,
    name: line.name,
    kind: line.kind,
    state: line.outcome,
    rowId: line.sandboxId ?? hostRow,
    startedAt: line.startedAt,
    endedAt: line.endedAt,
    attempt: line.attempt,
    corrections: line.verification?.corrections ?? 0,
    breaches: (line.breaches ?? []).map((breach) => breach.path),
    ...(line.errorTag === undefined ? {} : { errorTag: line.errorTag }),
  }));

  const inFlight = doc.run.inFlight;
  const exited = new Set(spans.map((span) => span.phaseId));
  if (inFlight === undefined || isTerminal(doc) || exited.has(inFlight.phaseId)) return spans;

  return [
    ...spans,
    {
      phaseId: inFlight.phaseId,
      name: inFlight.name,
      kind: inFlight.kind,
      state: "running",
      rowId: inFlight.sandboxId ?? hostRow,
      startedAt: inFlight.startedAt,
      // The whole of what makes it in-flight: it ends at whatever the clock says, so it grows.
      endedAt: Math.max(inFlight.startedAt, now),
      attempt: inFlight.attempt,
      corrections: 0,
      breaches: [],
    },
  ];
};

/** One stretch between two consecutive edges, before anything has been collapsed. */
interface Stretch {
  readonly from: number;
  readonly to: number;
  readonly dense: boolean;
}

/** Something that occupies a stretch of the axis: a phase, or an acquisition's own band. */
interface Occupied {
  readonly from: number;
  readonly to: number;
}

/**
 * The axis cut at every phase and acquisition edge, each piece marked as covered or dead.
 *
 * Cutting at *every* edge is what makes the rest of this module simple: no phase can start or end in
 * the middle of a stretch, so no span ever begins inside a break, and a span that crosses one is
 * drawn as one bar passing under it rather than as two pieces somebody has to read as one.
 *
 * **The acquisitions count as occupancy, and that is not a detail.** The ninety seconds a container
 * takes to build after a gate is a stretch with no phase in it, so a rule that only knew about phases
 * would swallow the rebuild into the gate's break — and *what the rebuild cost* is one of the two
 * things console.md §5 says the row model exists to make visible.
 */
export const stretchesOf = (
  occupied: ReadonlyArray<Occupied>,
  from: number,
  to: number,
): ReadonlyArray<Stretch> => {
  const edges = new Set<number>([from, to]);
  for (const one of occupied) {
    if (one.from > from && one.from < to) edges.add(one.from);
    if (one.to > from && one.to < to) edges.add(one.to);
  }
  const ordered = [...edges].sort((left, right) => left - right);

  const stretches: Array<Stretch> = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const start = ordered[index] as number;
    const end = ordered[index + 1] as number;
    stretches.push({
      from: start,
      to: end,
      // Dead time is a stretch nothing covers at all. It breaks on exactly the same terms as a span
      // does, which is what stops an idle hour hiding in a gap.
      dense: occupied.some((one) => one.from <= start && one.to >= end),
    });
  }
  return stretches;
};

/**
 * Which stretches collapse — the worst first, re-judged after each one.
 *
 * Greedy and repeated rather than one pass over a fixed total, because collapsing the gate changes
 * what *dominant* means for everything left: 41 hours makes a 6-minute phase look like nothing, and
 * once the 41 hours is gone the 6 minutes is the longest thing on screen and must stay drawn.
 */
export const collapsedOf = (
  stretches: ReadonlyArray<Stretch>,
  rule: BreakRule,
): ReadonlySet<number> => {
  const collapsed = new Set<number>();

  for (;;) {
    const live = stretches
      .map((stretch, index) => ({
        index,
        millis: stretch.to - stretch.from,
        dense: stretch.dense,
      }))
      .filter((entry) => !collapsed.has(entry.index));
    // Never the last one standing: an axis of nothing but breaks says nothing at all.
    if (live.length < 2) return collapsed;

    const total = live.reduce((sum, entry) => sum + entry.millis, 0);
    const worst = live.reduce((longest, entry) =>
      entry.millis > longest.millis ? entry : longest,
    );
    // The floor depends on what is in the stretch, not on how long it is. A dense stretch is a bar
    // somebody can read; a dead one is a gap, and a gap has nothing to lose by being elided.
    const floor = worst.dense ? rule.floorMillis : rule.deadFloorMillis;
    if (worst.millis < floor || worst.millis <= total * rule.share) return collapsed;

    collapsed.add(worst.index);
  }
};

/** The steps a tick may take, from a second up to a day. The reui default starts three orders up. */
const steps: ReadonlyArray<{ readonly millis: number; readonly label: string }> = [
  // Below a second, because collapsing dead time can leave very little linear content behind. A
  // real run measured after that change had 0.77 s of work left on the axis; with the table
  // bottoming out at `1s` it carried exactly one tick, which is an axis nobody can measure by.
  { millis: 100, label: "100ms" },
  { millis: 200, label: "200ms" },
  { millis: 500, label: "500ms" },
  { millis: 1_000, label: "1s" },
  { millis: 2_000, label: "2s" },
  { millis: 5_000, label: "5s" },
  { millis: 10_000, label: "10s" },
  { millis: 30_000, label: "30s" },
  { millis: 60_000, label: "1m" },
  { millis: 120_000, label: "2m" },
  { millis: 300_000, label: "5m" },
  { millis: 600_000, label: "10m" },
  { millis: 1_800_000, label: "30m" },
  { millis: 3_600_000, label: "1h" },
  { millis: 10_800_000, label: "3h" },
  { millis: 21_600_000, label: "6h" },
  { millis: 43_200_000, label: "12h" },
  { millis: 86_400_000, label: "1d" },
];

/** How far apart two ticks have to be before their labels stop colliding. */
const tickGap = 72;

export interface WaterfallOptions {
  /** How wide the timeline is drawn at zoom 1. Breaks take a fixed share of it. */
  readonly width: number;
  /** Wall-clock is `false`: one linear scale end to end, and every break given up. */
  readonly breaks: boolean;
  readonly rule?: BreakRule;
}

/**
 * The whole waterfall for one run at one instant.
 *
 * The axis runs from the first thing that happened to the last — or to *now* for a run that has not
 * reached a terminal outcome, which is what makes an open gate's wait a stretch of dead time on
 * screen rather than nothing at all.
 */
export const waterfall = (doc: RunDoc, now: number, options: WaterfallOptions): Waterfall => {
  const spans = spansOf(doc, now);
  const rows = rowsOf(doc, now);
  const rule = options.rule ?? defaultBreakRule;

  const from = Math.min(doc.run.run.startedAt, ...spans.map((span) => span.startedAt));
  const last = Math.max(doc.run.run.startedAt, ...spans.map((span) => span.endedAt));
  // A live or suspended run is still spending time, and the gate it waits on is exactly the dead
  // time this design exists to make visible. A finished one stops where it stopped.
  const to = Math.max(last, isTerminal(doc) ? (doc.run.finishedAt ?? last) : now);

  // A sandbox band occupies the axis exactly as a phase does — see `stretchesOf`.
  const bands = rows
    .filter((row) => row.from !== undefined)
    .map((row) => ({ from: row.from as number, to: row.to ?? to }));
  const occupied = [...spans.map((span) => ({ from: span.startedAt, to: span.endedAt })), ...bands];
  const stretches = to > from ? stretchesOf(occupied, from, to) : [];
  const collapsed = options.breaks ? collapsedOf(stretches, rule) : new Set<number>();

  const linearMillis = stretches.reduce(
    (sum, stretch, index) => (collapsed.has(index) ? sum : sum + (stretch.to - stretch.from)),
    0,
  );
  /** What a collapsed stretch costs the axis: the wall, plus a margin per end for a dense one. */
  const costOf = (index: number): number =>
    breakWidth + ((stretches[index] as Stretch).dense ? 2 * spanEdge : 0);
  const spent = [...collapsed].reduce((sum, index) => sum + costOf(index), 0);
  const linearWidth = Math.max(options.width - spent, 1);
  const perMilli = linearMillis > 0 ? linearWidth / linearMillis : 0;

  const segments: Array<AxisSegment> = [];
  let offset = 0;
  for (const [index, stretch] of stretches.entries()) {
    const broken = collapsed.has(index);
    const edge = broken && stretch.dense ? spanEdge : 0;
    const width = broken ? breakWidth + 2 * edge : (stretch.to - stretch.from) * perMilli;
    segments.push({
      kind: broken ? "break" : "linear",
      from: stretch.from,
      to: stretch.to,
      offset,
      width,
      dense: stretch.dense,
      wallOffset: broken ? offset + edge : offset,
      wallWidth: broken ? breakWidth : width,
      // Hours, never days. A break exists to be compared with the phases beside it, and *1d 17h*
      // beside *2m 0s* is the same number written so that nobody can.
      ...(broken ? { label: axisDuration(stretch.to - stretch.from) } : {}),
    });
    offset += width;
  }

  const width = offset > 0 ? offset : options.width;

  /**
   * Where an instant sits.
   *
   * Every phase and acquisition edge is a segment boundary, so a span's own ends always land exactly
   * — including on a break, where the start of the elided stretch is the segment's left edge and its
   * end is the right. That is what lets a three-hour phase whose middle is elided still be drawn as
   * one bar with a head, a wall and a tail.
   *
   * An instant genuinely *inside* a break — which no phase edge can be — resolves to the wall, the
   * honest answer being that the axis has no position for it any more.
   */
  const xOf = (at: number): number => {
    if (segments.length === 0) return 0;
    for (const segment of segments) {
      if (at <= segment.from) return segment.offset;
      if (at <= segment.to) {
        if (segment.kind !== "break") return segment.offset + (at - segment.from) * perMilli;
        return at >= segment.to ? segment.offset + segment.width : segment.wallOffset;
      }
    }
    return width;
  };

  /**
   * The step, and it must always be coarse enough — the table is not allowed to run out.
   *
   * `steps` ends at one day, and the old code fell back to that last entry whenever nothing in the
   * table was coarse enough. On an axis longer than a day or two that draws one tick **per day**
   * however many days there are, with no lower bound on the spacing: measured on a wall-clock axis
   * of 40 days, 41 ticks at 24 px; at 120 days, 121 ticks at 8 px; at 400 days, 401 ticks at 2.4 px.
   * The labels overprint into a grey smear and the axis stops being readable at all.
   *
   * So when the table runs out the coarsest entry is *multiplied* until one tick clears `tickGap`.
   * `1d` becomes `7d`, `30d`, whatever the axis needs. Wall-clock mode is meant to look bad — that
   * is the case the toggle exists to show — but it has to look bad *honestly*, and a smear is not a
   * measurement of anything.
   */
  const fitting = steps.find((candidate) => candidate.millis * perMilli >= tickGap);
  const coarsest = steps[steps.length - 1] ?? { millis: 86_400_000, label: "1d" };
  const multiple =
    perMilli > 0 && Number.isFinite(perMilli)
      ? Math.max(1, Math.ceil(tickGap / (coarsest.millis * perMilli)))
      : 1;
  const step = fitting ?? {
    millis: coarsest.millis * multiple,
    label: `${multiple * (coarsest.millis / 86_400_000)}d`,
  };

  /**
   * A break's own label sits in the header, so a tick that would land under it is dropped.
   *
   * Not cosmetic: the two would overprint, and the one a reader loses is the break's — the only
   * thing on the axis that cannot be recovered by measuring.
   */
  const shaded = segments
    .filter((segment) => segment.kind === "break")
    .map((segment) => ({
      from: segment.wallOffset - tickGap / 2,
      to: segment.wallOffset + segment.wallWidth,
    }));

  const ticks: Array<AxisTick> = [];
  /**
   * One tick per instant, and the label picked by the step rather than by the magnitude.
   *
   * **`at < segment.to`, not `<=`.** Every phase edge is a segment boundary, so a closing edge and
   * the next segment's opening edge are the same instant; with `<=` both emitted, and two ticks
   * overprinted at one pixel wherever a phase edge landed on an exact multiple of the step. Two of
   * seven fixtures did it, one of them three times over. The last segment's closing tick is emitted
   * once, below, because nothing follows it to open.
   *
   * `seen` is belt and braces for the same fault: a break's ends can also coincide.
   */
  const seen = new Set<number>();
  const push = (at: number): void => {
    if (seen.has(at)) return;
    const offset = xOf(at);
    if (shaded.some((zone) => offset >= zone.from && offset <= zone.to)) return;
    seen.add(at);
    ticks.push({ at, offset, label: tickLabel(at - from, step.millis) });
  };

  for (const segment of segments) {
    if (segment.kind === "break") continue;
    const first = Math.ceil((segment.from - from) / step.millis) * step.millis + from;
    for (let at = first; at < segment.to; at += step.millis) push(at);
  }
  // The closing edge of the axis itself, which the loops above deliberately stop short of.
  const closing = Math.floor((to - from) / step.millis) * step.millis + from;
  if (closing > from || ticks.length === 0) push(closing);

  return { rows, spans, segments, ticks, width, from, to, scale: step.label, xOf };
};

/** How wide one span is drawn, never narrower than a hairline a person can still see and click. */
export const spanWidth = (view: Waterfall, span: PhaseSpan): number =>
  Math.max(view.xOf(span.endedAt) - view.xOf(span.startedAt), minimumSpanWidth);

/** The spans of one row, oldest first. A row with none is still a row: the scope existed. */
export const spansOfRow = (
  spans: ReadonlyArray<PhaseSpan>,
  rowId: string,
): ReadonlyArray<PhaseSpan> =>
  spans
    .filter((span) => span.rowId === rowId)
    .sort((left, right) => left.startedAt - right.startedAt);
