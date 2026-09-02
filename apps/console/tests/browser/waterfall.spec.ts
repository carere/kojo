import { spawnSync } from "node:child_process";
import type {
  RunDocument,
  RunPhaseDocument,
  RunSandboxDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { expect, type Locator, type Page, test } from "@playwright/test";

const root = "/tmp/kojo-ticket-69-browser";
const origin = "http://127.0.0.1:47241";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;
const base = Date.parse("2026-03-01T00:00:00.000Z");
const hour = 60 * 60 * 1_000;
const minute = 60 * 1_000;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the Waterfall fixture Daemon did not issue a grant");
  return result.stdout;
};

const at = (offset: number): string => new Date(base + offset).toISOString();
const phase = (
  _runId: string,
  name: string,
  startedAt: number,
  endedAt: number,
  options: Partial<RunPhaseDocument> = {},
): RunPhaseDocument => ({
  phasePath: name,
  attempt: 1,
  kind: "code",
  outcome: "succeeded",
  description: name,
  startedAt: at(startedAt),
  endedAt: at(endedAt),
  ...options,
});

const sandbox = (
  sandboxId: string,
  name: string,
  acquiredAt: number,
  releasedAt: number,
): RunSandboxDocument => ({
  sandboxId,
  name,
  provider: "no-sandbox",
  kind: "none",
  branch: `kojo/${sandboxId.split("/")[0]}`,
  worktreePath: `/private/${sandboxId}`,
  environment: {},
  acquiredAt: at(acquiredAt),
  releasedAt: at(releasedAt),
  outcome: "released",
});

const runDocument = (
  runId: string,
  state: RunDocument["state"],
  phases: ReadonlyArray<RunPhaseDocument>,
  options: Partial<RunDocument> = {},
): RunDocument => ({
  runId,
  projectId: "project-waterfall",
  workflowName: "waterfall",
  revisionId: "a".repeat(64),
  packageGraphId: "b".repeat(64),
  state,
  admittedAt: at(0),
  startedAt: at(0),
  ...(state === "succeeded" || state === "failed" || state === "cancelled"
    ? { finishedAt: at(Math.max(...phases.map((item) => Date.parse(item.endedAt) - base), 1)) }
    : {}),
  phases,
  sandboxes: [],
  ...options,
});

const merged = (): RunDocument => {
  const first = "run-merged/build/540000-1";
  const second = "run-merged/build/149280000-2";
  return runDocument(
    "run-merged",
    "succeeded",
    [
      phase("run-merged", "in_progress", 0, 200),
      phase("run-merged", "route", 200, 8_200, { kind: "agent" }),
      phase("run-merged", "hotfix", 10 * minute, 16 * minute, {
        kind: "agent",
        sandboxId: first,
      }),
      phase("run-merged", "test", 41 * hour + 28 * minute, 41 * hour + 30 * minute, {
        sandboxId: second,
      }),
    ],
    {
      finishedAt: at(41 * hour + 30 * minute),
      sandboxes: [
        sandbox(first, "build", 9 * minute, 17 * minute),
        sandbox(second, "build", 41 * hour + 27 * minute, 41 * hour + 30 * minute),
      ],
    },
  );
};

const lanes = (withBreak = false): RunDocument => {
  const runId = withBreak ? "run-lanes-break" : "run-lanes";
  const api = `${runId}/api/0-1`;
  const web = `${runId}/web/0-1`;
  const duration = withBreak ? 3 * hour : 10 * minute;
  return runDocument(
    runId,
    "succeeded",
    [
      phase(runId, withBreak ? "compile" : "probe", 0, withBreak ? duration : 8 * minute, {
        kind: "agent",
        sandboxId: api,
      }),
      phase(runId, "sift", minute, 6 * minute, { sandboxId: web }),
      phase(runId, "report", withBreak ? duration : 9 * minute, duration + minute, {
        sandboxId: web,
      }),
    ],
    {
      finishedAt: at(duration + minute),
      sandboxes: [
        sandbox(api, "api", 0, duration + minute),
        sandbox(web, "web", 0, duration + minute),
      ],
    },
  );
};

const scout = (settled = false): RunDocument => {
  const held = `run-scout/lane/${base + 1_000}-1`;
  return runDocument(
    "run-scout",
    settled ? "succeeded" : "executing",
    [
      phase("run-scout", "in_progress", 0, 200),
      ...(settled
        ? [phase("run-scout", "explore", 1_000, 10_000, { kind: "agent", sandboxId: held })]
        : []),
    ],
    settled
      ? { finishedAt: at(10_000), sandboxes: [sandbox(held, "lane", 1_000, 10_000)] }
      : {
          inFlight: {
            phasePath: "explore",
            attempt: 1,
            kind: "agent",
            startedAt: at(1_000),
            sandboxId: held,
          },
        },
  );
};

const broken = (): RunDocument =>
  runDocument(
    "run-broken",
    "failed",
    [
      phase("run-broken", "in_progress", 0, 200),
      phase("run-broken", "route", 200, 30_000, { kind: "agent" }),
      phase("run-broken", "plan", 30_000, 2 * minute, {
        kind: "agent",
        verification: {
          envelope: "plan",
          ran: ["lint"],
          failed: [],
          corrections: 2,
          correctable: true,
        },
      }),
      phase("run-broken", "implement", 2 * minute, 3 * minute, {
        kind: "agent",
        outcome: "failed",
        errorTag: "CheckViolation",
      }),
      phase("run-broken", "edit", 3 * minute, 4 * minute, {
        kind: "agent",
        outcome: "failed",
        errorTag: "PermissionBreach",
        breaches: [{ path: ".kojo/factory.json", outcome: { _tag: "Preserved" } }],
      }),
    ],
    { finishedAt: at(4 * minute) },
  );

const approve = (): RunDocument =>
  runDocument("run-approve", "suspended", [
    phase("run-approve", "hotfix", 0, 10_000, { kind: "agent", outcome: "interrupted" }),
  ]);

const stale = (): RunDocument =>
  runDocument(
    "run-stale",
    "succeeded",
    [
      phase("run-stale", "explore", 0, 3 * hour, { kind: "agent" }),
      phase("run-stale", "finish", 3 * hour, 3 * hour + minute),
    ],
    { finishedAt: at(3 * hour + minute) },
  );

const fixture = (runId: string, settled = false): RunDocument => {
  if (runId === "run-merged") return merged();
  if (runId === "run-lanes") return lanes();
  if (runId === "run-lanes-break") return lanes(true);
  if (runId === "run-scout") return scout(settled);
  if (runId === "run-broken") return broken();
  if (runId === "run-approve") return approve();
  if (runId === "run-stale") return stale();
  return runDocument(runId, "executing", []);
};

const openRun = async (
  page: Page,
  runId: string,
  options: {
    readonly view?: "timeline" | "table";
    readonly now?: number;
    readonly settled?: boolean;
  } = {},
): Promise<void> => {
  await page.addInitScript(`window.__KOJO_NOW__ = ${options.now ?? base + 10_000}`);
  await page.route(`**/api/v1/runs/${runId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(fixture(runId, options.settled)),
    }),
  );
  await page.goto(launch());
  await page.goto(`${origin}/runs/${runId}?view=${options.view ?? "timeline"}`);
  await page.waitForSelector("[data-waterfall], [data-notice], table");
};

const span = (page: Page, phaseId: string): Locator => page.locator(`[data-phase="${phaseId}"]`);
const row = (page: Page, rowId: string): Locator => page.locator(`[data-row="${rowId}"]`);
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the Waterfall element is not on the page");
  return box;
};

test("the Host is the root row and each acquisition is its child", async ({ page }) => {
  await openRun(page, "run-merged");
  await expect(page.locator("[data-row]")).toHaveCount(3);
  await expect(page.locator("[data-row]").first()).toHaveAttribute("data-scope", "host");
  await expect(page.locator('[data-scope="sandbox"]')).toHaveCount(2);
});

test("a Phase stays on the row of the scope where it ran", async ({ page }) => {
  await openRun(page, "run-merged");
  await expect(row(page, "host").locator('[data-phase="run-merged/route/1"]')).toHaveCount(1);
  await expect(
    page.locator('[data-scope="sandbox"]').first().locator('[data-phase="run-merged/hotfix/1"]'),
  ).toHaveCount(1);
});

test("a post-Gate rebuild is a second acquisition row", async ({ page }) => {
  await openRun(page, "run-merged");
  const sandboxes = page.locator('[data-scope="sandbox"]');
  await expect(sandboxes.nth(0)).toContainText("acquisition 1 of 2");
  await expect(sandboxes.nth(1)).toContainText("acquisition 2 of 2");
});

test("a forty-one-hour wait collapses to one labelled fixed-width break", async ({ page }) => {
  await openRun(page, "run-merged");
  await expect(page.locator("[data-break]")).toHaveAttribute("data-break", /41h/);
  expect((await boxOf(page.locator("[data-break]"))).width).toBeLessThan(
    (await boxOf(span(page, "run-merged/hotfix/1"))).width,
  );
});

test("a break crosses every scope row", async ({ page }) => {
  await openRun(page, "run-merged");
  const wall = await boxOf(page.locator("[data-break]"));
  const first = await boxOf(page.locator("[data-row]").first());
  const last = await boxOf(page.locator("[data-row]").last());
  expect(wall.y).toBeLessThanOrEqual(first.y + 1);
  expect(wall.y + wall.height).toBeGreaterThanOrEqual(last.y + last.height - 1);
});

test("dead time between Phases uses the same break grammar", async ({ page }) => {
  await openRun(page, "run-approve", { now: base + 41 * hour });
  await expect(page.locator('[data-break][data-break-dense="false"]')).toHaveCount(1);
});

test("a dense break keeps the long Phase visible through it", async ({ page }) => {
  await openRun(page, "run-stale");
  const wall = await boxOf(page.locator('[data-break][data-break-dense="true"]'));
  const phaseBox = await boxOf(span(page, "run-stale/explore/1"));
  expect(phaseBox.x).toBeLessThan(wall.x);
  expect(phaseBox.x + phaseBox.width).toBeGreaterThan(wall.x + wall.width);
});

test("wall-clock mode removes every break", async ({ page }) => {
  await openRun(page, "run-merged");
  await page.locator("[data-axis]").click();
  await expect(page.locator("[data-axis]")).toHaveAttribute("data-axis", "wall-clock");
  await expect(page.locator("[data-break]")).toHaveCount(0);
});

test("concurrent acquisitions keep one row each", async ({ page }) => {
  await openRun(page, "run-lanes");
  await expect(page.locator('[data-scope="sandbox"]')).toHaveCount(2);
  await expect(page.locator("[data-acquisition]")).toHaveCount(0);
});

test("concurrent Phases share time but not vertical ground", async ({ page }) => {
  await openRun(page, "run-lanes");
  const probe = await boxOf(span(page, "run-lanes/probe/1"));
  const sift = await boxOf(span(page, "run-lanes/sift/1"));
  expect(probe.x).toBeLessThan(sift.x + sift.width);
  expect(sift.x).toBeLessThan(probe.x + probe.width);
  expect(sift.y).toBeGreaterThanOrEqual(probe.y + probe.height);
});

test("the axis uses wall-clock duration rather than summed lane time", async ({ page }) => {
  await openRun(page, "run-lanes");
  const canvas = Number(await page.locator("[data-canvas]").getAttribute("data-canvas"));
  const probe = await boxOf(span(page, "run-lanes/probe/1"));
  expect(probe.width / canvas).toBeGreaterThan(0.7);
});

test("an acquired Sandbox band spans time spent waiting on a sibling", async ({ page }) => {
  await openRun(page, "run-lanes");
  const web = page.locator('[data-scope="sandbox"]').nth(1);
  const band = await boxOf(web.locator("[data-band]"));
  const probe = await boxOf(span(page, "run-lanes/probe/1"));
  expect(band.x).toBeLessThanOrEqual(probe.x);
  expect(band.x + band.width).toBeGreaterThanOrEqual(probe.x + probe.width);
});

test("a break in one lane preserves its sibling positions and band", async ({ page }) => {
  await openRun(page, "run-lanes-break");
  const wall = await boxOf(page.locator('[data-break][data-break-dense="true"]'));
  const sift = await boxOf(span(page, "run-lanes-break/sift/1"));
  const report = await boxOf(span(page, "run-lanes-break/report/1"));
  expect(sift.x + sift.width).toBeLessThanOrEqual(wall.x);
  expect(report.x).toBeGreaterThanOrEqual(wall.x + wall.width);
});

test("an in-flight Phase grows to now", async ({ page }) => {
  await openRun(page, "run-scout");
  const running = span(page, "run-scout/explore/1");
  await expect(running).toHaveAttribute("data-state", "running");
  const phaseBox = await boxOf(running);
  const canvas = await boxOf(page.locator("[data-canvas]"));
  expect(phaseBox.x + phaseBox.width).toBeCloseTo(canvas.x + canvas.width, 0);
});

test("an in-flight Phase creates a held Sandbox row before release", async ({ page }) => {
  await openRun(page, "run-scout");
  await expect(page.locator('[data-scope="sandbox"][data-held="true"]')).toContainText("lane");
});

test("a later clock changes elapsed geometry without changing records", async ({ page }) => {
  await openRun(page, "run-scout");
  const before = await boxOf(span(page, "run-scout/in_progress/1"));
  await openRun(page, "run-scout", { now: base + 30_000 });
  const after = await boxOf(span(page, "run-scout/in_progress/1"));
  expect(after.width).toBeLessThan(before.width);
});

test("the completed Phase replaces its in-flight projection", async ({ page }) => {
  await openRun(page, "run-scout", { settled: true });
  await expect(span(page, "run-scout/explore/1")).toHaveAttribute("data-state", "succeeded");
  await expect(page.locator('[data-state="running"]')).toHaveCount(0);
});

test("a failed check and a permission breach remain distinct", async ({ page }) => {
  await openRun(page, "run-broken");
  await expect(span(page, "run-broken/implement/1")).toHaveAttribute("data-breach", "false");
  await expect(span(page, "run-broken/edit/1")).toHaveAttribute("data-breach", "true");
  await expect(span(page, "run-broken/edit/1").locator('[data-mark="breach"]')).toHaveCount(1);
});

test("an interrupted Phase is not shown as failed", async ({ page }) => {
  await openRun(page, "run-approve", { now: base + 41 * hour });
  await expect(span(page, "run-approve/hotfix/1")).toHaveAttribute("data-state", "interrupted");
});

test("Phase kind stays on successful and failed spans", async ({ page }) => {
  await openRun(page, "run-broken");
  await expect(span(page, "run-broken/in_progress/1")).toHaveAttribute("data-kind", "code");
  await expect(span(page, "run-broken/implement/1")).toHaveAttribute("data-kind", "agent");
});

test("corrections remain marks inside one Phase span", async ({ page }) => {
  await openRun(page, "run-broken");
  const plan = span(page, "run-broken/plan/1");
  await expect(plan).toHaveAttribute("data-corrections", "2");
  await expect(plan.locator("[data-correction]")).toHaveCount(2);
  await expect(page.locator('[data-phase^="run-broken/plan/"]')).toHaveCount(1);
});

test("the Waterfall is not draggable or editable", async ({ page }) => {
  await openRun(page, "run-merged");
  await expect(page.locator("[data-waterfall] [draggable]")).toHaveCount(0);
  await expect(page.locator("[data-waterfall] [contenteditable]")).toHaveCount(0);
});

test("a short Run uses a seconds scale", async ({ page }) => {
  await openRun(page, "run-scout");
  await expect(page.locator("[data-scale]")).toHaveAttribute("data-scale", /s$/);
});

test("a longer Run selects a coarser scale", async ({ page }) => {
  await openRun(page, "run-broken");
  await expect(page.locator("[data-scale]")).toHaveAttribute("data-scale", /m$|30s/);
});

test("zoom stretches a Phase without changing its row", async ({ page }) => {
  await openRun(page, "run-merged");
  const before = await boxOf(span(page, "run-merged/hotfix/1"));
  await page.locator('[data-zoom="in"]').click();
  const after = await boxOf(span(page, "run-merged/hotfix/1"));
  expect(after.width).toBeGreaterThan(before.width);
  await expect(
    page.locator('[data-scope="sandbox"]').first().locator('[data-phase="run-merged/hotfix/1"]'),
  ).toHaveCount(1);
});

test("click selection is exclusive and reversible", async ({ page }) => {
  await openRun(page, "run-merged");
  const hotfix = span(page, "run-merged/hotfix/1");
  await hotfix.click();
  await expect(hotfix).toHaveAttribute("data-selected", "true");
  await hotfix.click();
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
});

test("pointer hover is exclusive and clears on leave", async ({ page }) => {
  await openRun(page, "run-merged");
  const hotfix = span(page, "run-merged/hotfix/1");
  await hotfix.hover();
  await expect(hotfix).toHaveAttribute("data-hovered", "true");
  await page.locator("[data-run-header]").hover();
  await expect(page.locator('[data-hovered="true"]')).toHaveCount(0);
});

test("the table toggle renders every Waterfall Phase and persists in the URL", async ({ page }) => {
  await openRun(page, "run-merged");
  const spans = await page.locator("[data-phase]").count();
  await page.locator('[data-view="table"]').click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.locator("[data-phase-row]")).toHaveCount(spans);
});

test("the Phase table includes an in-flight Phase", async ({ page }) => {
  await openRun(page, "run-scout", { view: "table" });
  await expect(page.locator('[data-phase-row="run-scout/explore/1"]')).toContainText("running");
});

test("a Run with no Phases shows an explicit empty state", async ({ page }) => {
  await openRun(page, "run-build");
  await expect(page.getByText("No phases yet.")).toBeVisible();
  await expect(page.locator("[data-waterfall]")).toHaveCount(0);
  await expect(page.locator("[data-run-header]")).toBeVisible();
});

test("a Run catalogue row opens the Waterfall", async ({ page }) => {
  await page.route("**/api/v1/runs", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { runs: ReadonlyArray<Record<string, unknown>> };
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({ ...snapshot, runs: [merged()] }),
    });
  });
  await page.route("**/api/v1/runs/run-merged", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(merged()) }),
  );
  await page.goto(launch());
  await page.goto(`${origin}/runs`);
  await page.locator('[data-run="run-merged"] a').click();
  await expect(page.locator("[data-waterfall]")).toBeVisible();
});

test("a narrow Phase wins hit testing against its wider neighbour", async ({ page }) => {
  await openRun(page, "run-merged");
  const narrow = span(page, "run-merged/in_progress/1");
  const hit = await narrow.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return document
      .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      ?.closest("[data-phase]")
      ?.getAttribute("data-phase");
  });
  expect(hit).toBe("run-merged/in_progress/1");
});

test("no two ticks occupy the same position", async ({ page }) => {
  await openRun(page, "run-lanes");
  const positions = await page
    .locator("[data-tick]")
    .evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().x * 10) / 10),
    );
  expect(new Set(positions).size).toBe(positions.length);
});

test("a forty-day wall-clock axis keeps tick labels apart", async ({ page }) => {
  await openRun(page, "run-approve", { now: base + 40 * 24 * hour });
  await page.locator("[data-axis]").click();
  const positions = await page
    .locator("[data-tick]")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
  const gaps = positions.slice(1).map((position, index) => position - (positions[index] ?? 0));
  expect(Math.min(...gaps)).toBeGreaterThan(36);
});

test("a four-hundred-day wall-clock axis keeps tick labels apart", async ({ page }) => {
  await openRun(page, "run-approve", { now: base + 400 * 24 * hour });
  await page.locator("[data-axis]").click();
  const positions = await page
    .locator("[data-tick]")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
  const gaps = positions.slice(1).map((position, index) => position - (positions[index] ?? 0));
  expect(Math.min(...gaps)).toBeGreaterThan(36);
});

test("an unchanged in-flight span keeps its DOM identity", async ({ page }) => {
  await openRun(page, "run-scout");
  const rebuilds = await page.evaluate(async () => {
    const selector = '[data-phase="run-scout/explore/1"]';
    let node = document.querySelector(selector);
    let count = 0;
    for (let sample = 0; sample < 6; sample += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const current = document.querySelector(selector);
      if (current !== node) count += 1;
      node = current;
    }
    return count;
  });
  expect(rebuilds).toBe(0);
});

test("the axis grows and shrinks with its card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openRun(page, "run-merged");
  const canvas = () => page.locator("[data-canvas]").getAttribute("data-canvas").then(Number);
  const narrow = await canvas();
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(canvas).toBeGreaterThan(narrow + 200);
});

test("zoom overflow can pan to the end", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openRun(page, "run-merged");
  const scroller = page.locator("[data-waterfall] div.overflow-x-auto");
  await page.locator('[data-zoom="in"]').click();
  await page.locator('[data-zoom="in"]').click();
  await scroller.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
  });
  expect(await scroller.evaluate((node) => node.scrollLeft)).toBeGreaterThan(100);
});

test("modifier-wheel zooms the Waterfall instead of the page", async ({ page }) => {
  await openRun(page, "run-merged");
  const before = Number(await page.locator("[data-canvas]").getAttribute("data-canvas"));
  await page.locator("[data-waterfall]").dispatchEvent("wheel", { deltaY: -120, ctrlKey: true });
  await expect
    .poll(async () => Number(await page.locator("[data-canvas]").getAttribute("data-canvas")))
    .toBeGreaterThan(before);
});

test("a canonical forty-one-hour break remains human-readable", async ({ page }) => {
  await openRun(page, "run-merged");
  await expect(page.locator("[data-break-label]").first()).toHaveText(/41h/);
});

test("a months-long Gate wait uses weeks instead of thousands of hours", async ({ page }) => {
  await openRun(page, "run-approve", { now: base + 173 * 24 * hour });
  const text = (await page.locator("[data-break-label]").first().textContent()) ?? "";
  expect(text).not.toMatch(/\d{3,}h/);
  expect(text).toMatch(/\d+w/);
});
