import { expect, type Locator, type Page, test } from "@playwright/test";
import { consoleAt, type FixtureName, frozenNow, open } from "./harness.ts";

/**
 * The waterfall's grammar, graded against the real server serving stated records.
 *
 * console.md §5 and adr/trace/0001 are the specification, and each `describe` below is one line of
 * it. The assertions are about **geometry and structure** rather than about colour: a colour can be
 * re-themed, and "the break is drawn across every row" is a measurable claim about a box while "the
 * gate looks long" is not.
 *
 * Every fixture is written against a frozen clock, so every width here is the same number on every
 * machine.
 */

/** One run's page, at the frozen instant, in whichever of the two modes. */
const openRun = async (
  page: Page,
  fixtures: FixtureName,
  runId: string,
  options: { readonly view?: "timeline" | "table"; readonly now?: number } = {},
): Promise<void> => {
  await page.addInitScript(`window.__KOJO_NOW__ = ${options.now ?? frozenNow}`);
  await page.goto(`${consoleAt[fixtures]}/runs/${runId}?view=${options.view ?? "timeline"}`);
  await page.waitForSelector("[data-waterfall], [data-notice], table");
};

const span = (page: Page, phaseId: string): Locator => page.locator(`[data-phase="${phaseId}"]`);
const row = (page: Page, rowId: string): Locator => page.locator(`[data-row="${rowId}"]`);

/** A span's own box, in the page's pixels. Every claim about the axis is a claim about one of these. */
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("that element is not on the page");
  return box;
};

test.describe("rows are the scope tree, not concurrency lanes", () => {
  test("the host is the root row and each acquisition is a child of it", async ({ page }) => {
    await openRun(page, "busy", "run-merged");

    // Three rows for a run that is mostly sequential: a gantt using the vertical axis for
    // concurrency would have drawn one lane and a staircase.
    const rows = page.locator("[data-row]");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute("data-scope", "host");
    await expect(rows.nth(0)).toHaveAttribute("data-depth", "0");
    await expect(rows.nth(1)).toHaveAttribute("data-scope", "sandbox");
    await expect(rows.nth(1)).toHaveAttribute("data-depth", "1");
    await expect(rows.nth(2)).toHaveAttribute("data-scope", "sandbox");
  });

  test("a phase sits on the row of the scope it ran in", async ({ page }) => {
    await openRun(page, "busy", "run-merged");

    // The router ran on the host; the builder ran inside a container. That is the question no other
    // view answers, and it is answered by which row the span is inside.
    await expect(row(page, "host").locator('[data-phase="run-merged/route/1"]')).toHaveCount(1);
    await expect(row(page, "host").locator('[data-phase="run-merged/hotfix/1"]')).toHaveCount(0);

    const first = page.locator('[data-scope="sandbox"]').first();
    await expect(first.locator('[data-phase="run-merged/hotfix/1"]')).toHaveCount(1);
    await expect(first.locator('[data-phase="run-merged/scout/1"]')).toHaveCount(1);
  });

  test("the rebuild a gate forced is a second row, with nothing built to mark it", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-merged");

    const sandboxes = page.locator('[data-scope="sandbox"]');
    await expect(sandboxes).toHaveCount(2);
    // Same scope, two acquisitions, two rows. The trace writes one record per acquisition, so this
    // falls out of the row model rather than out of a rebuild indicator anybody designed.
    await expect(sandboxes.nth(0)).toContainText("build");
    await expect(sandboxes.nth(0)).toContainText("acquisition 1 of 2");
    await expect(sandboxes.nth(1)).toContainText("build");
    await expect(sandboxes.nth(1)).toContainText("acquisition 2 of 2");

    // And the work after the gate is on the second one, which is what makes the two rows a fact
    // about the run rather than a repeated label.
    await expect(sandboxes.nth(1).locator('[data-phase="run-merged/test/1"]')).toHaveCount(1);
    await expect(sandboxes.nth(0).locator('[data-phase="run-merged/test/1"]')).toHaveCount(0);
  });
});

test.describe("the time axis breaks", () => {
  test("a gate held for forty-one hours collapses to a fixed width stating its duration", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-merged");

    const wall = page.locator("[data-break]");
    await expect(wall).toHaveCount(1);
    // The number, not a long bar. A 41-hour bar reads as "long" and cannot be measured.
    await expect(wall).toHaveAttribute("data-break", "41h 12m");
    await expect(page.locator("[data-break-label]")).toContainText("41h 12m");

    // And it is *fixed* width: the run before the gate is ten minutes and the wait is forty-one
    // hours, so anything proportional would be four hundred times wider than the whole rest.
    const wallBox = await boxOf(wall);
    const hotfix = await boxOf(span(page, "run-merged/hotfix/1"));
    expect(wallBox.width).toBeLessThan(hotfix.width);
  });

  test("the break is drawn across every row, not only the one the gate stopped", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-merged");

    const wall = await boxOf(page.locator("[data-break]"));
    const first = await boxOf(row(page, "host"));
    const last = await boxOf(page.locator('[data-scope="sandbox"]').nth(1));

    // From the top of the first row to the bottom of the last: a gate stops the whole run, and a
    // gap drawn per row would say it stopped only the rows it happened to touch.
    expect(wall.y).toBeLessThanOrEqual(first.y + 1);
    expect(wall.y + wall.height).toBeGreaterThanOrEqual(last.y + last.height - 1);
  });

  test("dead time between phases breaks the same way, so an idle hour cannot hide", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-approve");

    // Nothing covers this stretch — the run is suspended and no phase is running — so it is a gap
    // rather than a span, and it breaks on exactly the same terms.
    const wall = page.locator("[data-break]");
    await expect(wall).toHaveCount(1);
    await expect(wall).toHaveAttribute("data-break", "41h 0m");
    await expect(wall).toHaveAttribute("data-break-dense", "false");
  });

  test("a break inside a long phase keeps the phase drawn", async ({ page }) => {
    await openRun(page, "busy", "run-stale");

    const inside = page.locator('[data-break][data-break-dense="true"]');
    await expect(inside).toHaveCount(1);
    await expect(inside).toHaveAttribute("data-break", "3h 0m");

    // The three-hour phase still has a head and a tail on either side of the wall. A break that
    // swallowed the span would have deleted the very thing it was called in to make readable.
    const wall = await boxOf(inside);
    const explore = await boxOf(span(page, "run-stale/explore/1"));
    expect(explore.x).toBeLessThan(wall.x);
    expect(explore.x + explore.width).toBeGreaterThan(wall.x + wall.width);
  });

  test("wall-clock gives up every break, and the run becomes the hairline it was", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-merged");
    const broken = await boxOf(span(page, "run-merged/hotfix/1"));
    expect(broken.width).toBeGreaterThan(200);

    await page.locator("[data-axis]").click();

    await expect(page.locator("[data-axis]")).toHaveAttribute("data-axis", "wall-clock");
    await expect(page.locator("[data-break]")).toHaveCount(0);
    // Six minutes of an agent, on an axis sized to forty-one hours. This is the control case the
    // toggle exists to offer: linear is not a compromise the design gave up on, it is unreadable.
    const linear = await boxOf(span(page, "run-merged/hotfix/1"));
    expect(linear.width).toBeLessThan(5);
  });
});

/**
 * Two lanes held at the same time — ticket 35's fourth criterion, executed at last.
 *
 * Everything above this block grades a **staircase**: `run-merged` holds two containers and they are
 * sequential, so every assertion in it would read the same on a waterfall that had laid the run's
 * phases end to end. `run-lanes` and `run-lanes-break` are the first fixtures in this build whose
 * intervals genuinely overlap, and the assertions here are chosen for one property — each of them
 * reads differently on a wall-clock axis and on an axis built by adding durations up.
 *
 * The three claims are ticket 35's own handover, and each is graded rather than repeated:
 *
 * 1. one row per acquisition, and rows that do not overlap;
 * 2. the axis is `max(end) − min(start)`, never a sum;
 * 3. a held container is a real span across the sibling's phase, not a gap.
 */
test.describe("two lanes, held at the same time", () => {
  /** Whether two boxes share any horizontal ground at all. Concurrency, as a fact about pixels. */
  const overlaps = (
    left: { readonly x: number; readonly width: number },
    right: { readonly x: number; readonly width: number },
  ): boolean => left.x < right.x + right.width && right.x < left.x + left.width;

  test("one row per acquisition, and two phases running at once are on two of them", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-lanes");

    // The host, plus one row per acquisition. Two containers were alive together and the row model
    // has no matching step to get wrong — but *has no matching step* is an argument, and the run
    // that could turn it into a measurement did not exist until this fixture did.
    const rows = page.locator("[data-row]");
    await expect(rows).toHaveCount(3);
    const lanes = page.locator('[data-scope="sandbox"]');
    await expect(lanes.nth(0)).toContainText("api");
    await expect(lanes.nth(1)).toContainText("web");
    // Two acquisitions of two *different* scopes, so neither row is numbered: `acquisition 1 of 1`
    // is noise, and a lane that wore it would be indistinguishable from `run-merged`'s rebuild.
    await expect(page.locator("[data-acquisition]")).toHaveCount(0);

    await expect(lanes.nth(0).locator('[data-phase="run-lanes/probe/1"]')).toHaveCount(1);
    await expect(lanes.nth(1).locator('[data-phase="run-lanes/sift/1"]')).toHaveCount(1);
    await expect(lanes.nth(1).locator('[data-phase="run-lanes/report/1"]')).toHaveCount(1);
  });

  test("two phases that share time do not share ground", async ({ page }) => {
    await openRun(page, "busy", "run-lanes");

    const probe = await boxOf(span(page, "run-lanes/probe/1"));
    const sift = await boxOf(span(page, "run-lanes/sift/1"));

    // The criterion in two lines, and it is a claim about boxes rather than about the row model:
    // the two spans share time, and they do not share ground. A waterfall that drew both lanes on
    // one row would satisfy the first and fail the second, and no fixture before this one could
    // even ask — a staircase satisfies both for the trivial reason that nothing ever overlaps.
    expect(overlaps(probe, sift)).toBe(true);
    expect(sift.y).toBeGreaterThanOrEqual(probe.y + probe.height);
  });

  test("the axis is the wall clock, never the sum of what the lanes did", async ({ page }) => {
    await openRun(page, "busy", "run-lanes");

    // The axis the geometry decided on, in pixels, straight off the canvas it sized.
    const canvas = Number(await page.locator("[data-canvas]").getAttribute("data-canvas"));
    const probe = await boxOf(span(page, "run-lanes/probe/1"));

    // `probe` is eight minutes of a ten-minute run, so it is four fifths of the axis. The same run
    // holds 13m 28s of phase time, and an axis that added the durations up would draw this span at
    // 59% — the two readings are eighteen points of canvas apart, and they are identical on every
    // other fixture in this build, because no other fixture ever held two containers at once.
    expect(probe.width / canvas).toBeGreaterThan(0.78);
    expect(probe.width / canvas).toBeLessThan(0.82);

    // And the concurrency itself, stated the other way round: `sift` starts after `probe` starts and
    // ends before `probe` ends, so it is drawn strictly *inside* it. An axis built from a sum has
    // nowhere to put a span inside another one — it would have to lay `sift` after `probe`.
    const sift = await boxOf(span(page, "run-lanes/sift/1"));
    expect(sift.x).toBeGreaterThan(probe.x);
    expect(sift.x + sift.width).toBeLessThan(probe.x + probe.width);
  });

  test("the waiting lane's row is a span across the sibling's phase, not a gap", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-lanes");

    const web = page.locator('[data-scope="sandbox"]').nth(1);
    // Two spans on the lane and nothing between them: `sift` finished at six minutes and `report`
    // could not start until the sibling let go at nine.
    await expect(web.locator("[data-phase]")).toHaveCount(2);
    const sift = await boxOf(span(page, "run-lanes/sift/1"));
    const report = await boxOf(span(page, "run-lanes/report/1"));
    expect(report.x - (sift.x + sift.width)).toBeGreaterThan(200);

    // The band under them is continuous across that gap. The container was up for the whole of it
    // and was being paid for, so the row is a span; drawing it idle would say the sibling constraint
    // ticket 35 measured costs nothing.
    const band = await boxOf(web.locator("[data-band]"));
    expect(band.x).toBeLessThanOrEqual(sift.x);
    expect(band.x + band.width).toBeGreaterThanOrEqual(report.x + report.width);

    // And it reaches across the sibling's phase, which is the interval it was waiting through.
    const probe = await boxOf(span(page, "run-lanes/probe/1"));
    expect(band.x).toBeLessThanOrEqual(probe.x);
    expect(band.x + band.width).toBeGreaterThanOrEqual(probe.x + probe.width);
  });

  test("a break inside one lane leaves the other lane's spans where they belong", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-lanes-break");

    // Three hours of `compile` on one lane, collapsed. A break rescales every stretch that is left,
    // so it is the operation most able to put a *sibling's* span in the wrong place.
    const inside = page.locator('[data-break][data-break-dense="true"]');
    await expect(inside).toHaveCount(1);
    await expect(inside).toHaveAttribute("data-break", "2h 55m");
    const wall = await boxOf(inside);

    // The sibling lane first, because it is the claim this test exists for: what happened before the
    // elided hours stays before the wall, what happened after stays after, and neither is dragged
    // onto it. `report` starts on the instant the break ends, which is the position a reader of the
    // axis is most able to lose.
    const sift = await boxOf(span(page, "run-lanes-break/sift/1"));
    const report = await boxOf(span(page, "run-lanes-break/report/1"));
    expect(sift.x + sift.width).toBeLessThanOrEqual(wall.x);
    expect(report.x).toBeGreaterThanOrEqual(wall.x + wall.width);

    // And its container crosses the wall, because it did not stop existing when the axis stopped
    // drawing those three hours.
    const watch = page.locator('[data-scope="sandbox"]').nth(1);
    const band = await boxOf(watch.locator("[data-band]"));
    expect(band.x).toBeLessThan(wall.x);
    expect(band.x + band.width).toBeGreaterThan(wall.x + wall.width);

    // The broken lane itself still keeps a head and a tail, as it does on a run with one lane —
    // stated last because it is the context the three assertions above are read against.
    const compile = await boxOf(span(page, "run-lanes-break/compile/1"));
    expect(compile.x).toBeLessThan(wall.x);
    expect(compile.x + compile.width).toBeGreaterThan(wall.x + wall.width);
  });
});

test.describe("the in-flight phase", () => {
  test("is a span that grows to now, from the run row rather than a phase record", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-scout");

    const running = span(page, "run-scout/explore/1");
    await expect(running).toHaveAttribute("data-state", "running");

    // It ends at *now*: the axis is exactly as wide as the run is long, and the span reaches its
    // right edge. A record-shaped span could not — there is no record, because the phase is running.
    const box = await boxOf(running);
    const canvas = await boxOf(page.locator("[data-canvas]"));
    expect(box.x + box.width).toBeCloseTo(canvas.x + canvas.width, 0);
  });

  test("runs on the row of the container it is inside, which has no record yet", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-scout");

    // An acquisition is written when it is **released**, so a container in use right now is named by
    // a phase and by nothing else. Putting that phase on the host row would say the work needed no
    // container while it is sitting inside one.
    const held = page.locator('[data-scope="sandbox"][data-held="true"]');
    await expect(held).toHaveCount(1);
    await expect(held).toContainText("lane");
    await expect(held.locator('[data-phase="run-scout/explore/1"]')).toHaveCount(1);
  });

  test("grows when the clock moves, and nothing else does", async ({ page }) => {
    await openRun(page, "busy", "run-scout");
    const atRest = await boxOf(span(page, "run-scout/in_progress/1"));

    // Twenty seconds later the run is thirty seconds old rather than ten, so the same axis width
    // now holds three times as much time and the exited phase shrinks by exactly that much.
    await openRun(page, "busy", "run-scout", { now: frozenNow + 20_000 });
    await expect(page.locator("[data-elapsed]")).toHaveText("30s");
    const later = await boxOf(span(page, "run-scout/in_progress/1"));
    expect(later.width).toBeLessThan(atRest.width / 2);
  });

  test("is replaced by the real span on exit", async ({ page }) => {
    // The same run id and the same phase id, one phase later. Two servers rather than two requests,
    // because whether a phase has exited is a property of the trace and not of the page.
    await openRun(page, "settled", "run-scout");

    const exited = span(page, "run-scout/explore/1");
    await expect(exited).toHaveCount(1);
    await expect(exited).toHaveAttribute("data-state", "succeeded");
    // Not both: a poll that caught the record arriving must not leave the growing span behind.
    await expect(page.locator('[data-state="running"]')).toHaveCount(0);
    // And the acquisition it ran in is a released one now, with a record behind it.
    await expect(page.locator('[data-scope="sandbox"][data-held="true"]')).toHaveCount(0);
  });
});

test.describe("phase kind, failure and permission breach are visually distinct", () => {
  test("a failed check and a permission breach do not read alike", async ({ page }) => {
    await openRun(page, "busy", "run-broken");

    const violated = span(page, "run-broken/implement/1");
    await expect(violated).toHaveAttribute("data-state", "failed");
    await expect(violated).toHaveAttribute("data-error", "CheckViolation");
    await expect(violated).toHaveAttribute("data-breach", "false");
    await expect(violated.locator('[data-mark="breach"]')).toHaveCount(0);

    await openRun(page, "busy", "run-breach");
    const breached = span(page, "run-breach/edit/1");
    await expect(breached).toHaveAttribute("data-state", "failed");
    await expect(breached).toHaveAttribute("data-breach", "true");
    // Its own mark. A breach cannot be fixed by re-prompting, so it must not wear the outline a
    // refused answer wears and nothing else.
    await expect(breached.locator('[data-mark="breach"]')).toHaveCount(1);
  });

  test("an interrupted phase is not a failed one", async ({ page }) => {
    await openRun(page, "busy", "run-approve");

    // The suspension killed it. It did nothing wrong, and drawing it as a fault would accuse it.
    await expect(span(page, "run-approve/hotfix/1")).toHaveAttribute("data-state", "interrupted");
  });

  test("kind is on the span, whatever the outcome was", async ({ page }) => {
    await openRun(page, "busy", "run-broken");

    await expect(span(page, "run-broken/in_progress/1")).toHaveAttribute("data-kind", "code");
    await expect(span(page, "run-broken/route/1")).toHaveAttribute("data-kind", "agent");
    // Failure is an outline rather than a different fill, so the kind survives it — *which agent
    // phase died* is the question a person actually asks.
    await expect(span(page, "run-broken/implement/1")).toHaveAttribute("data-kind", "agent");
  });
});

test.describe("corrections stay inside one span", () => {
  test("a phase that took three attempts is one span with two correction marks", async ({
    page,
  }) => {
    await openRun(page, "busy", "run-broken");

    const plan = span(page, "run-broken/plan/1");
    // One. adr/trace/0001: a corrected phase is one record, so the attempts are a detail-panel
    // concern. `fix_1` / `retest_1` / `fix_2` are separate spans because the *author* wrote
    // separate phases, and that is the distinction this assertion protects.
    await expect(plan).toHaveCount(1);
    await expect(plan).toHaveAttribute("data-corrections", "2");
    await expect(plan.locator("[data-correction]")).toHaveCount(2);

    // And no phase named `plan` appears a second time under any attempt.
    await expect(page.locator('[data-phase^="run-broken/plan/"]')).toHaveCount(1);
  });
});

test.describe("the widget is read-only, and its scales reach seconds", () => {
  test("nothing on the timeline is draggable or resizable", async ({ page }) => {
    await openRun(page, "busy", "run-merged");

    // Drag, resize, snapping and `addEvent` have no meaning over immutable history. A draggable
    // trace bar is a bug shaped like a feature, so the editing half was not ported.
    await expect(page.locator("[data-waterfall] [draggable]")).toHaveCount(0);
    await expect(page.locator("[data-waterfall] [contenteditable]")).toHaveCount(0);

    const before = await boxOf(span(page, "run-merged/hotfix/1"));
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 250, before.y + 60, { steps: 8 });
    await page.mouse.up();

    const after = await boxOf(span(page, "run-merged/hotfix/1"));
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
  });

  test("a run measured in seconds gets a scale measured in seconds", async ({ page }) => {
    await openRun(page, "busy", "run-scout");

    // The reui component's own scales start at *daily*, which is three orders of magnitude out for
    // a phase that lasted two hundred milliseconds.
    await expect(page.locator("[data-scale]")).toHaveAttribute("data-scale", "1s");
    await expect(page.locator("[data-tick]").first()).toHaveText("0s");
  });

  test("and a longer run gets a coarser step, off the same table", async ({ page }) => {
    // The step table is the whole of the first consequence console.md §5 draws out of choosing a
    // gantt, and one assertion at the second end of it left every step above `1s` free to be
    // deleted. Two more runs, two more steps: a thirty-second run and a twelve-minute one.
    await openRun(page, "busy", "run-breach");
    await expect(page.locator("[data-scale]")).toHaveAttribute("data-scale", "30s");

    await openRun(page, "busy", "run-merged");
    await expect(page.locator("[data-scale]")).toHaveAttribute("data-scale", "2m");
  });

  test("zoom stretches the axis without moving a phase off its row", async ({ page }) => {
    await openRun(page, "busy", "run-merged");
    const before = await boxOf(span(page, "run-merged/hotfix/1"));

    await page.locator('[data-zoom="in"]').click();

    const after = await boxOf(span(page, "run-merged/hotfix/1"));
    expect(after.width).toBeGreaterThan(before.width);
    // Still inside the acquisition it ran in: zoom is a property of the look, not of the record.
    await expect(
      page.locator('[data-scope="sandbox"]').first().locator('[data-phase="run-merged/hotfix/1"]'),
    ).toHaveCount(1);
  });
});

/**
 * Solux's own two events, graded because ticket 29 opens from one of them.
 *
 * console.md §8 gives the waterfall's zoom, hover and selection to a store scoped to the component.
 * Zoom is graded above. These two were not, and selection is the thing the detail panel is opened
 * by — an unenforced click here would be a hole three tickets deep, so it is enforced here.
 */
test.describe("what the pointer does", () => {
  test("a click marks one span, and clicking the same one again lets go", async ({ page }) => {
    await openRun(page, "busy", "run-merged");
    const hotfix = span(page, "run-merged/hotfix/1");
    const route = span(page, "run-merged/route/1");

    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);

    await hotfix.click();
    await expect(hotfix).toHaveAttribute("data-selected", "true");
    // One at a time, across rows: the selection is the run's, not the row's.
    await route.click();
    await expect(route).toHaveAttribute("data-selected", "true");
    await expect(hotfix).toHaveAttribute("data-selected", "false");
    await expect(page.locator('[data-selected="true"]')).toHaveCount(1);

    // And it can be let go of. A selection nothing can undo is a trap on a surface whose only job
    // is investigation.
    await route.click();
    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  });

  test("the pointer marks the span it is over, and lets go when it leaves", async ({ page }) => {
    await openRun(page, "busy", "run-merged");
    const hotfix = span(page, "run-merged/hotfix/1");

    await hotfix.hover();
    await expect(hotfix).toHaveAttribute("data-hovered", "true");
    await expect(page.locator('[data-hovered="true"]')).toHaveCount(1);

    // Leaving is its own event rather than a hover carrying nothing, which is why it can be graded
    // on its own at all.
    await page.locator("[data-run-header]").hover();
    await expect(page.locator('[data-hovered="true"]')).toHaveCount(0);
  });
});

test.describe("the table toggle", () => {
  test("renders the same phase records as rows, and lives in the URL", async ({ page }) => {
    await openRun(page, "busy", "run-merged");
    const spans = await page.locator("[data-phase]").count();

    await page.locator('[data-view="table"]').click();

    await expect(page).toHaveURL(/view=table/);
    await expect(page.locator("[data-waterfall]")).toHaveCount(0);
    // The same records, not a second read: every span is a row and every row is a span.
    await expect(page.locator("[data-phase-row]")).toHaveCount(spans);
    await expect(page.locator('[data-phase-row="run-merged/hotfix/1"]')).toContainText("6m 0s");

    // Pasted to a colleague, it still opens as a table. That is the whole reason it is not
    // component state.
    await openRun(page, "busy", "run-merged", { view: "table" });
    await expect(page.locator("[data-phase-row]")).toHaveCount(spans);
  });

  test("the table holds the in-flight phase too", async ({ page }) => {
    await openRun(page, "busy", "run-scout", { view: "table" });

    await expect(page.locator('[data-phase-row="run-scout/explore/1"]')).toContainText("running");
  });
});

test.describe("a run with nothing in it yet", () => {
  test("says so rather than showing an empty timeline or an error", async ({ page }) => {
    await openRun(page, "busy", "run-build");

    await expect(page.getByText("No phases yet.")).toBeVisible();
    await expect(page.locator("[data-waterfall]")).toHaveCount(0);
    // The header is still there: what produced the run is useful before any phase has run.
    await expect(page.locator("[data-run-header]")).toBeVisible();
  });
});

test.describe("the way in", () => {
  test("a run in the list opens the run view", async ({ page }) => {
    await open(page, "busy");

    await page.locator('tr[data-run="run-merged"] a').click();

    await expect(page).toHaveURL(/\/runs\/run-merged/);
    await expect(page.locator("[data-waterfall]")).toBeVisible();
  });
});
