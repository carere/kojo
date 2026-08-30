import { expect, type Locator, type Page, test } from "@playwright/test";
import { consoleAt, type FixtureName, frozenNow } from "./harness.ts";

/**
 * The detail panel — console.md §6, graded against the real server serving stated records.
 *
 * Every assertion here is about **what the panel says and what it asks for**, never about a colour
 * or a heading's wording: which facts a phase shows, which request is made and when, and what a
 * missing artifact does to the rest of the panel. The panel's elements carry the fact they are
 * drawing as a data attribute for exactly that reason, on the rule the waterfall already follows.
 */

const openRun = async (
  page: Page,
  fixtures: FixtureName,
  path: string,
  options: { readonly now?: number } = {},
): Promise<void> => {
  await page.addInitScript(`window.__KOJO_NOW__ = ${options.now ?? frozenNow}`);
  await page.goto(`${consoleAt[fixtures]}${path}`);
};

const span = (page: Page, phaseId: string): Locator => page.locator(`[data-phase="${phaseId}"]`);
const panel = (page: Page): Locator => page.locator("[data-detail-panel]");
const field = (page: Page, name: string): Locator => page.locator(`[data-field="${name}"]`);

/** Every request this page made, so that *fetched on demand* is a claim about the network. */
const watch = (page: Page): ReadonlyArray<string> => {
  const asked: Array<string> = [];
  page.on("request", (request) => asked.push(request.url()));
  return asked;
};

test.describe("the panel is a nested route, not a page", () => {
  test("a click opens it beside the waterfall and puts the phase in the URL", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged");
    await expect(panel(page)).toHaveCount(0);

    await span(page, "run-merged/hotfix/1").click();

    // The URL is the whole point: this is what a person pastes into a chat when they ask why a run
    // died. It names the run, the phase and the attempt, and nothing is percent-encoded.
    await expect(page).toHaveURL(/\/runs\/run-merged\/phases\/hotfix\/1/);
    await expect(panel(page)).toHaveAttribute("data-detail-panel", "phase");
    // And the position they clicked from is still on screen. That is the difference between a panel
    // and a page, and it is the reason the route is nested.
    await expect(page.locator("[data-waterfall]")).toBeVisible();
    await expect(span(page, "run-merged/hotfix/1")).toHaveAttribute("data-selected", "true");
  });

  test("the same URL, pasted, opens the same panel with the span marked", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1");

    await expect(panel(page)).toHaveAttribute("data-detail-panel", "phase");
    await expect(page.locator("[data-waterfall]")).toBeVisible();
    // The ring is written by the panel the route mounted, so a deep link selects without a click.
    await expect(span(page, "run-merged/hotfix/1")).toHaveAttribute("data-selected", "true");
    await expect(page.locator('[data-selected="true"][data-phase]')).toHaveCount(1);
  });

  test("closing it is a move back to the run, and so is clicking the open span again", async ({
    page,
  }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1");

    await page.locator("[data-panel-close]").click();
    await expect(page).toHaveURL(/\/runs\/run-merged\?/);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('[data-selected="true"][data-phase]')).toHaveCount(0);

    // A selection nothing can undo is a trap on a surface whose only job is investigation.
    await span(page, "run-merged/hotfix/1").click();
    await expect(panel(page)).toHaveCount(1);
    await span(page, "run-merged/hotfix/1").click();
    await expect(panel(page)).toHaveCount(0);
  });

  test("the timeline-or-table choice survives being inside the panel", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1?view=table");

    // Both at once: the panel is a dock beside the run view, whichever way the run is being read.
    await expect(page.locator("[data-phase-row]").first()).toBeVisible();
    await expect(panel(page)).toHaveCount(1);

    // And closing it must not quietly put somebody back on a timeline they had switched away from.
    await page.locator("[data-panel-close]").click();
    await expect(page).toHaveURL(/view=table/);
    await expect(page.locator("[data-phase-row]").first()).toBeVisible();
  });
});

test.describe("a phase shows what its record carries", () => {
  test("summary, agent details, repository changes, and where it ran", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1");

    await expect(field(page, "run")).toHaveCount(0);
    await expect(field(page, "attempt")).toContainText("1");
    await expect(field(page, "duration")).toContainText("6m 0s");
    await expect(field(page, "started")).toContainText("UTC");

    await expect(field(page, "agent-name")).toContainText("builder");
    await expect(field(page, "model")).toContainText("fixture-model");
    await expect(field(page, "session")).toContainText("run-merged-hotfix");
    // Cold or resumed is a column of its own: the session id says *which* conversation, this says
    // whether the turn paid for a cold start.
    await expect(field(page, "resumed")).toContainText("cold");
    await expect(field(page, "tokens-in")).toContainText("4,000");
    await expect(field(page, "tokens-out")).toContainText("900");
    await expect(field(page, "context")).toContainText("22,500");

    // Successful verification is quiet. Technical envelope and check details do not compete with
    // the facts a person uses to understand the phase.
    await expect(page.locator('[data-pane="errors"]')).toHaveCount(0);
    await expect(field(page, "envelope")).toHaveCount(0);
    await expect(field(page, "corrections")).toHaveCount(0);

    await expect(field(page, "claimed")).toContainText("src/server.ts");
    await expect(field(page, "changed")).toContainText("src/server.ts");
    await expect(field(page, "commits")).toContainText("9f2c1ab");

    await expect(page.locator('[data-where="sandbox"]')).toBeVisible();
  });

  test("a phase that ran on the host says so, and does not leave the pane blank", async ({
    page,
  }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/route/1");

    await expect(page.locator('[data-where="host"]')).toContainText("needed no container");
  });

  test("a code phase shows no agent-only section or request", async ({ page }) => {
    const asked = watch(page);
    await openRun(page, "busy", "/runs/run-merged/phases/merge/1");

    await expect(page.locator('[data-pane="agent"]')).toHaveCount(0);
    await expect(page.locator('[data-pane="errors"]')).toHaveCount(0);
    await expect(page.locator('[data-pane="occurrences"]')).toHaveCount(0);
    await expect(page.locator('[data-pane="prompt"]')).toHaveCount(0);
    await expect(page.locator('[data-pane="session"]')).toHaveCount(0);
    expect(asked.filter((url) => url.includes("/occurrences"))).toHaveLength(0);
  });

  test("an invalid answer is stated as an error without verification terms", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-refused/phases/draft/1");

    await expect(page.locator('[data-pane="errors"]')).toContainText(
      "The agent answer did not match the required format.",
    );
    await expect(field(page, "decoded")).toHaveCount(0);
    await expect(field(page, "correctable")).toHaveCount(0);
  });

  test("a check that did not hold is marked apart from the ones that did", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-broken/phases/implement/1");

    await expect(field(page, "corrections")).toContainText("3");
    await expect(page.locator('[data-pane="errors"]')).toBeVisible();
    await expect(page.locator('[data-check="the tests pass"]')).toHaveAttribute(
      "data-check-held",
      "false",
    );
  });

  test("a failure the trace never listed among the checks that ran is still shown", async ({
    page,
  }) => {
    await openRun(page, "busy", "/runs/run-broken/phases/implement/1");

    // `the type checker is clean` is in the record's `failed` and absent from its `ran`: a check that
    // threw instead of returning a verdict never completed, so the writer never added it. A panel
    // drawing `ran` alone loses the failure entirely — the reader would see a phase that died on a
    // check violation and no violated check.
    await expect(page.locator('[data-check="the type checker is clean"]')).toHaveAttribute(
      "data-check-held",
      "false",
    );
    // Both failures are on screen, and the one that did complete is still there beside it.
    await expect(page.locator('[data-check-held="false"]')).toHaveCount(2);
  });

  test("an answer that described work it did not do is visible as a disagreement", async ({
    page,
  }) => {
    await openRun(page, "busy", "/runs/run-broken/phases/implement/1");

    await expect(field(page, "claimed")).toContainText("tests/queue.test.ts");
    await expect(field(page, "changed")).not.toContainText("tests/queue.test.ts");
    // The pair of columns is the only thing in the trace that can answer *did the answer describe
    // the work?* — a diff shows what happened and never what was claimed.
    await expect(page.locator('[data-repo="disagrees"]')).toBeVisible();
  });

  test("a breach carries what became of every path it touched", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-breach/phases/edit/1");

    await expect(page.locator('[data-breach=".github/workflows/ci.yml"]')).toHaveAttribute(
      "data-breach-outcome",
      "Restored",
    );
    // The one that must never be silent: work nothing can bring back.
    await expect(page.locator('[data-breach="docs/notes.md"]')).toHaveAttribute(
      "data-breach-outcome",
      "WorkLost",
    );
  });

  test("a phase id one character wrong says so, and leaves the run on screen", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/hotfxi/1");

    await expect(panel(page)).toContainText("no phase run-merged/hotfxi/1");
    await expect(page.locator("[data-waterfall]")).toBeVisible();
    await expect(page.locator("[data-run-header]")).toBeVisible();
  });
});

test.describe("the three artifacts are fetched on demand", () => {
  test("nothing is asked for until a pane is opened, and then only that one", async ({ page }) => {
    const asked = watch(page);
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1");
    await expect(page.locator('[data-artifact="prompt"]')).toHaveAttribute(
      "data-artifact-state",
      "unasked",
    );

    // Opening a span must not pull a transcript and a patch for a phase somebody is passing over.
    expect(asked.filter((url) => /\/(prompt|session|diff)$/.test(url))).toHaveLength(0);

    await page.locator('[data-artifact="prompt"]').click();
    await expect(page.locator('[data-artifact="prompt"]')).toHaveAttribute(
      "data-artifact-state",
      "present",
    );
    await expect(page.locator('[data-artifact="prompt"]')).toContainText("You are the builder");

    expect(asked.filter((url) => url.endsWith("/prompt"))).toHaveLength(1);
    expect(asked.filter((url) => url.endsWith("/session"))).toHaveLength(0);
    expect(asked.filter((url) => url.endsWith("/diff"))).toHaveLength(0);
  });

  test("the session is what makes a correction count auditable", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-broken/phases/implement/1");

    await page.locator('[data-artifact="session"]').click();
    await expect(page.locator('[data-artifact="session"]')).toHaveAttribute(
      "data-artifact-state",
      "present",
    );
    await expect(page.locator('[data-artifact="session"]')).toContainText("Correct your answer");
  });

  test("a missing diff degrades that pane and nothing else", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-broken/phases/implement/1");

    await page.locator('[data-artifact="diff"]').click();
    await page.locator('[data-artifact="prompt"]').click();

    await expect(page.locator('[data-artifact="diff"]')).toHaveAttribute(
      "data-artifact-state",
      "absent",
    );
    await expect(page.locator('[data-artifact="diff"]')).toHaveAttribute(
      "data-artifact-code",
      "no-such-artifact",
    );
    // The record is still there, the prompt still arrives, and the waterfall never noticed.
    await expect(page.locator('[data-artifact="prompt"]')).toHaveAttribute(
      "data-artifact-state",
      "present",
    );
    await expect(field(page, "changed")).toContainText("src/queue.ts");
    await expect(page.locator("[data-waterfall]")).toBeVisible();
  });

  test("an agent phase with no agent artifacts still renders its errors", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-breach/phases/edit/1");

    for (const kind of ["prompt", "session"]) {
      await page.locator(`[data-artifact="${kind}"]`).click();
      await expect(page.locator(`[data-artifact="${kind}"]`)).toHaveAttribute(
        "data-artifact-state",
        "absent",
      );
    }
    await expect(page.locator('[data-artifact="diff"]')).toHaveCount(0);
    await expect(
      page.locator('[data-pane="errors"] [data-error="PermissionBreach"]'),
    ).toContainText("outside its permission policy");
  });

  test("a running agent phase has no agent artifacts to fetch, and says why", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-scout/phases/explore/1");

    await expect(page.locator('[data-artifact="prompt"]')).toHaveAttribute(
      "data-artifact-state",
      "not-yet",
    );
    await expect(page.locator('[data-artifact="diff"]')).toHaveCount(0);
  });
});

test.describe("agent activity", () => {
  test("stream into the panel while the phase is in flight", async ({ page }) => {
    const asked = watch(page);
    await openRun(page, "busy", "/runs/run-scout/phases/explore/1");

    await expect(page.locator("[data-occurrences]")).toHaveAttribute(
      "data-occurrences",
      "streaming",
    );
    await expect(page.locator("[data-occurrence]")).toHaveCount(3);

    // It keeps asking, and it asks from where it left off. A poll that started from the beginning
    // every second would re-render the same three tool calls forever.
    await page.waitForTimeout(2_500);
    const polls = asked.filter((url) => url.includes("/occurrences"));
    expect(polls.length).toBeGreaterThan(1);
    expect(polls[polls.length - 1]).toMatch(/since=3/);

    // And what is on screen is everything handed over so far. A panel that rendered the last page
    // would be empty by now: every poll after the first returned nothing.
    await expect(page.locator("[data-occurrence]")).toHaveCount(3);
  });

  test("are a finished list once the phase is not, and stop costing a request", async ({
    page,
  }) => {
    const asked = watch(page);
    await openRun(page, "settled", "/runs/run-scout/phases/explore/1");

    await expect(page.locator("[data-occurrences]")).toHaveAttribute("data-occurrences", "listed");
    await expect(page.locator("[data-occurrence]")).toHaveCount(3);

    await page.waitForTimeout(2_500);
    expect(asked.filter((url) => url.includes("/occurrences"))).toHaveLength(1);
  });

  test("carry how each one ended, and live here and nowhere else", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-broken/phases/implement/1");

    await expect(page.locator('[data-occurrence-outcome="failed"]').first()).toContainText(
      "bun test",
    );
    await expect(page.locator("[data-occurrence-detail]").first()).toContainText("exit 1");
    // The waterfall stays phase-grained. Occurrences on it would turn a run's history into an event
    // log with a time axis, which is the shape the whole trace design exists to avoid.
    await expect(page.locator("[data-waterfall] [data-occurrence]")).toHaveCount(0);
  });

  test("an agent that recorded none says so rather than showing an empty list", async ({
    page,
  }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/route/1");

    await expect(page.locator('[data-occurrences="none"]')).toBeVisible();
    await expect(page.locator('[data-pane="occurrences"]')).toContainText("Agent activity");
  });
});

test.describe("the panel's second subject is a sandbox acquisition", () => {
  test("a scope row opens the whole record behind the band", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged");

    await page.locator("[data-scope-open]").first().click();

    await expect(page).toHaveURL(/\/runs\/run-merged\/sandboxes\/build\/\d+-1/);
    await expect(panel(page)).toHaveAttribute("data-detail-panel", "sandbox");
    await expect(field(page, "provider")).toContainText("docker");
    await expect(field(page, "sandbox-kind")).toContainText("isolated");
    await expect(field(page, "branch")).toContainText("kojo/run-merged");
    await expect(field(page, "worktree")).toContainText("/tmp/kojo/run-merged");
    await expect(field(page, "image")).toContainText("sha256:1f0a9c4e");
    await expect(page.locator('[data-environment="KOJO_RUN_ID"]')).toContainText("run-merged");
    // Not recorded anywhere in the trace, and said so rather than left as an empty heading.
    await expect(field(page, "hooks")).toContainText("no hook run");
    await expect(page.locator("[data-waterfall]")).toBeVisible();
  });

  test("the second acquisition states what the gate cost", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged");

    await page.locator("[data-scope-open]").nth(1).click();

    await expect(panel(page)).toContainText("acquisition 2 of 2");
    // Forty-one hours holding nothing, and then ninety seconds of setup before any work could
    // resume. Neither number appears anywhere else in the Console.
    await expect(field(page, "idle")).toContainText("41h 12m");
    await expect(field(page, "setup")).toContainText("1m 30s");
    // And which phases ran inside it, which is what makes the row a fact rather than a repeat.
    await expect(page.locator('[data-inside="run-merged/test/1"]')).toBeVisible();
    await expect(page.locator('[data-inside="run-merged/hotfix/1"]')).toHaveCount(0);
  });

  test("a phase and its acquisition are each one click from the other", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged/phases/test/1");

    await page.locator('[data-where="sandbox"]').click();
    await expect(panel(page)).toHaveAttribute("data-detail-panel", "sandbox");
    await expect(page.locator('[data-scope="sandbox"][data-selected="true"]')).toHaveCount(1);

    await page.locator('[data-inside="run-merged/merge/1"]').click();
    await expect(panel(page)).toHaveAttribute("data-detail-panel", "phase");
    await expect(span(page, "run-merged/merge/1")).toHaveAttribute("data-selected", "true");
    // One subject at a time: opening a phase lets go of the acquisition.
    await expect(page.locator('[data-scope="sandbox"][data-selected="true"]')).toHaveCount(0);
  });

  test("an acquisition still held has no record, and the panel says which parts are missing", async ({
    page,
  }) => {
    await openRun(page, "busy", "/runs/run-scout");

    await page.locator('[data-held="true"] [data-scope-open]').click();

    await expect(page.locator('[data-sandbox-state="held"]')).toBeVisible();
    await expect(field(page, "provider")).toContainText("written on release");
    // What it *can* say comes from the phases inside it, which is how the waterfall drew the row.
    await expect(page.locator('[data-inside="run-scout/explore/1"]')).toBeVisible();
  });
});

test.describe("a run that does not exist is an answer, not an outage", () => {
  test("says the run does not exist, does not blame the API, and stops asking", async ({
    page,
  }) => {
    const asked = watch(page);
    await openRun(page, "busy", "/runs/run-nope");

    await expect(page.getByText("There is no run run-nope in this factory.")).toBeVisible();
    // The API answered in three milliseconds. Blaming it would send somebody looking for an outage
    // that is not there while the actual fault — a character wrong in a pasted id — went unsaid.
    await expect(page.locator('[data-notice="retrying"]')).toHaveCount(0);
    await expect(page.getByText("Loading the run…")).toHaveCount(0);

    // And it is asked **once**. Both halves matter: a retry policy that stopped but an interval that
    // kept polling would ask a settled question every second for as long as the tab stayed open.
    await page.waitForTimeout(3_000);
    expect(asked.filter((url) => url.endsWith("/api/runs/run-nope"))).toHaveLength(1);
  });
});

/**
 * The geometry the panel and the timeline have to hold, which no assertion covered before.
 *
 * These are the three faults a person reported after using the Console on a real run, and every one
 * of them was invisible to a suite that only ever asked what the panel *said*. They are written as
 * measurements rather than as pixel expectations, so they keep meaning something when the layout is
 * tuned again.
 */
test.describe("the panel is below the timeline, and neither one clips the other", () => {
  const scroller = (page: Page): Locator => page.locator("[data-waterfall] div.overflow-x-auto");

  test("the whole axis is reachable with the panel open, at every desktop width", async ({
    page,
  }) => {
    // Before the panel moved below, a 448-pixel dock ate the axis: 382 pixels of a 1148-pixel
    // canvas were unreachable at 1280, and the 41-hour break wall sat outside the scroller
    // entirely — so the one thing the run view exists to show could not be seen at all.
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1");
    await expect(panel(page)).toBeVisible();

    for (const width of [1280, 1440, 1600, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const hidden = await scroller(page).evaluate((node) => node.scrollWidth - node.clientWidth);
      expect(hidden, `${width}px hides ${hidden}px of the axis`).toBe(0);
    }
  });

  test("the panel takes the full width rather than a column of it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRun(page, "busy", "/runs/run-merged/phases/hotfix/1");

    const panelBox = await panel(page).boundingBox();
    const waterfallBox = await page.locator("[data-waterfall]").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(waterfallBox).not.toBeNull();
    if (panelBox === null || waterfallBox === null) return;

    // Below, not beside: the panel starts under the timeline rather than to the right of it.
    expect(panelBox.y).toBeGreaterThan(waterfallBox.y);
    // And it is as wide as the timeline's own column, give or take a border.
    expect(Math.abs(panelBox.width - waterfallBox.width)).toBeLessThan(4);
  });

  test("the page scrolls once, not twice", async ({ page }) => {
    // The panel used to carry `max-h-[80vh]` and its own `overflow-y`, which put a second scrollbar
    // inside the first. The cap measured against the viewport while the panel began wherever flow
    // put it, so on a run with a gate card above it the panel started at y=484 in a 720-pixel
    // window and read through a porthole.
    await page.setViewportSize({ width: 1280, height: 720 });
    await openRun(page, "busy", "/runs/run-approve/phases/hotfix/1");

    const ownScrollbar = await panel(page).evaluate(
      (node) => node.scrollHeight > node.clientHeight + 1,
    );
    expect(ownScrollbar).toBe(false);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBe(0);
  });
});

/**
 * A failed run says what killed it before anybody clicks.
 *
 * The cause used to live only inside the failing span, at nine pixels and clipped by the span's own
 * width. `run-broken` is a failed run with no gate, which is why this component must not reuse the
 * gate card's attribute — a spec asserts that run has no gate card.
 */
test.describe("why a run failed is on the page, not behind a click", () => {
  test("names the failing phase and links to it", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-broken");

    const outcome = page.locator("[data-run-outcome]");
    await expect(outcome).toBeVisible();
    await expect(outcome).toHaveAttribute("data-run-outcome", "failed");

    // The failing phase is named, and its name is a link into its own panel.
    const link = outcome.locator("[data-outcome-link]");
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(panel(page)).toBeVisible();
    expect(page.url()).toContain("/phases/");
  });

  test("a run that succeeded says nothing at all", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged");
    await expect(page.locator("[data-run-outcome]")).toHaveCount(0);
  });
});

/**
 * The timeline stays on screen while the panel is read.
 *
 * This is what the side dock was really buying, and it is the property that had to survive moving
 * the panel below. Adjacency was the means; staying visible was the requirement.
 */
test.describe("the timeline is pinned while the panel is read", () => {
  test("scrolling the panel does not take the waterfall off screen", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openRun(page, "busy", "/runs/run-approve/phases/hotfix/1");
    await expect(panel(page)).toBeVisible();

    const waterfall = page.locator("[data-waterfall]");
    await expect(waterfall).toBeVisible();

    // Scroll to the bottom of the page — the worst case for a panel below the timeline.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(100);

    const box = await waterfall.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    // Pinned near the top, and **both bounds are load-bearing**. The first version of this test
    // asserted only `y < 48`, which a waterfall scrolled clean off the top satisfies perfectly:
    // measured at y=-574 with the sticky removed, and the test stayed green. A check that passes
    // while doing no work is the one thing this repository keeps a list of.
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeLessThan(48);
    expect(box.height).toBeGreaterThan(0);
  });
});

/**
 * The run header names what produced the run, rather than listing four values and hoping.
 *
 * It used to be `0.0.0 · development · fixture-host · sha256:fixture` — four monospace tokens on one
 * line with nothing to say which was which. A person reading it asked what each part was, which is
 * the only evidence a legibility claim can really have.
 *
 * Graded on `data-stamp` and not on the wording, and deliberately on a **different** attribute from
 * the panel's `data-field`: a header that borrowed that one made `[data-field="branch"]` match two
 * elements on the same page.
 */
test.describe("what produced a run is labelled, not merely printed", () => {
  test("every provenance value is named", async ({ page }) => {
    await openRun(page, "busy", "/runs/run-merged");

    const stamp = (name: string): Locator => page.locator(`[data-stamp="${name}"]`);
    for (const name of ["engine", "commit", "host", "config", "idempotency-key", "branch"]) {
      await expect(stamp(name), `${name} is missing from the run header`).toHaveCount(1);
    }

    // The two that were on the wire and drawn nowhere.
    await expect(stamp("idempotency-key")).toContainText("hotfix/run-merged");
    await expect(stamp("branch")).toContainText("kojo/run-merged");

    // Each carries its own name, so the value is never a bare token.
    await expect(stamp("config")).toContainText("config");
    await expect(stamp("config")).toContainText("sha256:fixture");
  });

  test("a run that acquired no sandbox says so rather than drawing a blank", async ({ page }) => {
    // `absent` is a first-class state on this surface: no branch means no sandbox was taken, which
    // is a fact about the run and not a value the Console failed to load.
    await openRun(page, "busy", "/runs/run-scout");
    const branch = page.locator('[data-stamp="branch"]');
    await expect(branch).toHaveCount(1);
    await expect(branch).not.toHaveText(/^branch$/);
  });
});
