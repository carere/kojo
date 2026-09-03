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
const runReadyTimeout = 30_000;

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
        agent: {
          agent: "builder",
          model: "fixture-model",
          session: "run-merged-hotfix",
          resumed: false,
          tokensIn: 4_000,
          tokensOut: 900,
          contextTokens: 22_500,
        },
        repo: {
          claimed: ["src/claimed.ts"],
          changed: ["src/actual.ts"],
          commits: ["abc1234"],
        },
        verification: {
          envelope: "hotfix",
          ran: ["lint", "test"],
          failed: ["test"],
          corrections: 2,
          correctable: true,
        },
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
        verification: {
          envelope: "implement",
          ran: ["lint", "test"],
          failed: ["test", "type checker"],
          corrections: 0,
          correctable: false,
        },
      }),
      phase("run-broken", "edit", 3 * minute, 4 * minute, {
        kind: "agent",
        outcome: "failed",
        errorTag: "PermissionBreach",
        breaches: [
          { path: ".kojo/factory.json", outcome: { _tag: "WorkLost" } },
          { path: "src/restored.ts", outcome: { _tag: "Restored" } },
        ],
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

const invalidAnswer = (): RunDocument =>
  runDocument(
    "run-invalid-answer",
    "failed",
    [
      phase("run-invalid-answer", "draft", 0, minute, {
        kind: "agent",
        outcome: "failed",
        errorTag: "EnvelopeParseError",
      }),
    ],
    { finishedAt: at(minute) },
  );

const fixture = (runId: string, settled = false): RunDocument => {
  if (runId === "run-merged") return merged();
  if (runId === "run-lanes") return lanes();
  if (runId === "run-lanes-break") return lanes(true);
  if (runId === "run-scout") return scout(settled);
  if (runId === "run-broken") return broken();
  if (runId === "run-approve") return approve();
  if (runId === "run-stale") return stale();
  if (runId === "run-invalid-answer") return invalidAnswer();
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
  await expect(page.locator("[data-run-header]")).toBeVisible({ timeout: runReadyTimeout });
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
  const compressed = await boxOf(span(page, "run-merged/hotfix/1"));
  expect(compressed.width).toBeGreaterThan(200);
  await page.locator("[data-axis]").click();
  await expect(page.locator("[data-axis]")).toHaveAttribute("data-axis", "wall-clock");
  await expect(page.locator("[data-break]")).toHaveCount(0);
  const wallClock = await boxOf(span(page, "run-merged/hotfix/1"));
  expect(wallClock.width).toBeLessThan(5);
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
  const testPhase = span(page, "run-merged/test/1");
  await hotfix.click();
  await expect(hotfix).toHaveAttribute("data-selected", "true");
  await testPhase.click();
  await expect(testPhase).toHaveAttribute("data-selected", "true");
  await expect(hotfix).toHaveAttribute("data-selected", "false");
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  await testPhase.click();
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
  await expect(page.locator('[data-phase-row="run-merged/hotfix/1"]')).toContainText("6m 0s");
  await page.reload();
  await expect(page.locator("[data-phase-row]")).toHaveCount(spans);
  await page.goto(`${origin}/runs/run-merged?view=table`);
  await expect(page.locator('[data-phase-row="run-merged/hotfix/1"]')).toContainText("6m 0s");
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
  const runLink = page.locator('[data-run="run-merged"] a');
  await expect(runLink).toBeVisible({ timeout: runReadyTimeout });
  await runLink.click();
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

test("a Phase deep link restores exactly one selected span and keeps the Waterfall", async ({
  page,
}) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/hotfix/1?view=timeline`);
  await expect(page.locator('[data-detail-panel="phase"]')).toBeVisible();
  await expect(span(page, "run-merged/hotfix/1")).toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  await expect(page.locator("[data-waterfall]")).toBeVisible();
  await page.reload();
  await expect(span(page, "run-merged/hotfix/1")).toHaveAttribute("data-selected", "true");
});

test("clicking a Phase span writes its exact Phase URL", async ({ page }) => {
  await openRun(page, "run-merged");
  await span(page, "run-merged/hotfix/1").click();
  await expect(page).toHaveURL(/\/runs\/run-merged\/phases\/hotfix\/1\?view=timeline/);
  await expect(page.locator('[data-detail-panel="phase"]')).toBeVisible();
});

test("a Phase panel shows Agent session, token, correction, and repository facts", async ({
  page,
}) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/hotfix/1?view=timeline`);
  await expect(page.locator('[data-field="attempt"]')).toContainText("1");
  await expect(page.locator('[data-field="started"]')).toContainText("UTC");
  await expect(page.locator('[data-field="duration"]')).toContainText("6m 0s");
  await expect(page.locator('[data-field="agent-name"]')).toContainText("builder");
  await expect(page.locator('[data-field="model"]')).toContainText("fixture-model");
  await expect(page.locator('[data-field="session"]')).toContainText("run-merged-hotfix");
  await expect(page.locator('[data-field="resumed"]')).toContainText("cold");
  await expect(page.locator('[data-field="tokens-in"]')).toContainText("4,000");
  await expect(page.locator('[data-field="tokens-out"]')).toContainText("900");
  await expect(page.locator('[data-field="context"]')).toContainText("22,500");
  await expect(page.locator('[data-field="corrections"]')).toContainText("2");
  await expect(page.locator('[data-field="claimed"]')).toContainText("src/claimed.ts");
  await expect(page.locator('[data-field="changed"]')).toContainText("src/actual.ts");
  await expect(page.locator('[data-field="commits"]')).toContainText("abc1234");
  await expect(page.locator('[data-repo="disagrees"]')).toBeVisible();
  await expect(page.locator('[data-where="sandbox"]')).toBeVisible();
});

test("code and Host Phases do not invent Agent or Sandbox facts", async ({ page }) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/in_progress/1?view=timeline`);
  await expect(page.locator('[data-pane="agent"]')).toHaveCount(0);
  await expect(page.locator('[data-where="host"]')).toContainText("needed no container");
});

test("a Phase and its Sandbox acquisition remain one link apart", async ({ page }) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/hotfix/1?view=timeline`);
  await page.locator('[data-where="sandbox"]').click();
  await expect(page.locator('[data-detail-panel="sandbox"]')).toBeVisible();
  await expect(page.locator('[data-scope="sandbox"][data-selected="true"]')).toHaveCount(1);
  await page.locator('[data-inside="run-merged/hotfix/1"]').click();
  await expect(page.locator('[data-detail-panel="phase"]')).toBeVisible();
  await expect(span(page, "run-merged/hotfix/1")).toHaveAttribute("data-selected", "true");
});

test("an invalid Phase deep link leaves the Run and Waterfall usable", async ({ page }) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/not-a-phase/1?view=timeline`);
  await expect(page.getByText("This run has no phase run-merged/not-a-phase/1.")).toBeVisible();
  await expect(page.locator("[data-waterfall]")).toBeVisible();
  await page.locator("[data-panel-close]").click();
  await expect(page).toHaveURL(/\/runs\/run-merged\?view=timeline/);
});

test("Phase errors keep failed checks and permission outcomes distinct", async ({ page }) => {
  await openRun(page, "run-broken");
  await page.goto(`${origin}/runs/run-broken/phases/implement/1?view=timeline`);
  await expect(page.locator('[data-detail-panel] [data-error="CheckViolation"]')).toContainText(
    "checks failed",
  );
  await expect(page.locator('[data-check="test"]')).toContainText("test");
  await expect(page.locator('[data-check="lint"]')).toHaveCount(0);
  await page.goto(`${origin}/runs/run-broken/phases/edit/1?view=timeline`);
  await expect(page.locator('[data-breach=".kojo/factory.json"]')).toHaveAttribute(
    "data-breach-outcome",
    "WorkLost",
  );
  await expect(page.locator('[data-breach="src/restored.ts"]')).toHaveAttribute(
    "data-breach-outcome",
    "Restored",
  );
});

test("a Sandbox deep link shows the exact acquisition and its Phase", async ({ page }) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/sandboxes/build/540000-1?view=timeline`);
  await expect(page.locator('[data-detail-panel="sandbox"]')).toBeVisible();
  await expect(page.locator('[data-field="provider"]')).toContainText("no-sandbox");
  await expect(page.locator('[data-field="sandbox-kind"]')).toContainText("none");
  await expect(page.locator('[data-field="branch"]')).toContainText("kojo/run-merged");
  await expect(page.locator('[data-field="worktree"]')).toContainText("/private/run-merged");
  await expect(page.locator('[data-inside="run-merged/hotfix/1"]')).toBeVisible();
});

test("the second Sandbox acquisition exposes Gate idle time and setup cost", async ({ page }) => {
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/sandboxes/build/149280000-2?view=timeline`);
  await expect(page.locator('[data-detail-panel="sandbox"]')).toContainText("acquisition 2 of 2");
  await expect(page.locator('[data-field="idle"]')).toContainText("41h 10m");
  await expect(page.locator('[data-field="setup"]')).toContainText("1m");
  await expect(page.locator('[data-inside="run-merged/test/1"]')).toBeVisible();
  await expect(page.locator('[data-inside="run-merged/hotfix/1"]')).toHaveCount(0);
});

test("closing and toggling a Phase panel preserve the selected Run view", async ({ page }) => {
  await openRun(page, "run-merged", { view: "table" });
  await page.goto(`${origin}/runs/run-merged/phases/hotfix/1?view=table`);
  await expect(page.locator('[data-detail-panel="phase"]')).toBeVisible();
  await expect(page.locator("[data-phase-row]").first()).toBeVisible();

  await page.locator("[data-panel-close]").click();
  await expect(page).toHaveURL(/\/runs\/run-merged\?view=table/);
  await expect(page.locator('[data-detail-panel="phase"]')).toHaveCount(0);

  await page.goto(`${origin}/runs/run-merged?view=timeline`);
  await span(page, "run-merged/hotfix/1").click();
  await expect(page.locator('[data-detail-panel="phase"]')).toBeVisible();
  await span(page, "run-merged/hotfix/1").click();
  await expect(page.locator('[data-detail-panel="phase"]')).toHaveCount(0);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
});

test("an invalid Agent answer is an error and does not invent verification fields", async ({
  page,
}) => {
  await openRun(page, "run-invalid-answer");
  await page.goto(`${origin}/runs/run-invalid-answer/phases/draft/1?view=timeline`);
  await expect(page.locator('[data-detail-panel] [data-error="EnvelopeParseError"]')).toContainText(
    "did not match the required format",
  );
  await expect(page.locator('[data-field="failed-checks"]')).toHaveCount(0);
  await expect(page.locator('[data-field="corrections"]')).toHaveCount(0);
});

test("failed checks include a failure that never completed its Run check", async ({ page }) => {
  await openRun(page, "run-broken");
  await page.goto(`${origin}/runs/run-broken/phases/implement/1?view=timeline`);
  await expect(page.locator('[data-check="test"]')).toHaveAttribute("data-check-held", "false");
  await expect(page.locator('[data-check="type checker"]')).toHaveAttribute(
    "data-check-held",
    "false",
  );
  await expect(page.locator('[data-check-held="false"]')).toHaveCount(2);
  await expect(page.locator('[data-check="lint"]')).toHaveCount(0);
});

test("a held Sandbox panel states which release facts are not recorded yet", async ({ page }) => {
  const acquisition = `${base + 1_000}-1`;
  await openRun(page, "run-scout");
  await page.goto(`${origin}/runs/run-scout/sandboxes/lane/${acquisition}?view=timeline`);
  await expect(page.locator('[data-sandbox-state="held"]')).toBeVisible();
  await expect(page.locator('[data-field="provider"]')).toContainText("written on release");
  await expect(page.locator('[data-inside="run-scout/explore/1"]')).toBeVisible();
});

test("a missing Run is a settled answer and not a reconnecting outage", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/v1/runs/run-nope", async (route) => {
    reads += 1;
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "no-such-run", message: "the Run does not exist" }),
    });
  });
  await page.goto(launch());
  await page.goto(`${origin}/runs/run-nope?view=timeline`);
  await expect(page.getByText("There is no run run-nope in this factory.")).toBeVisible();
  await expect(page.locator('[data-notice="retrying"]')).toHaveCount(0);
  await page.waitForTimeout(1_200);
  expect(reads).toBe(1);
});

test("the Phase panel keeps one page scroll and the whole Waterfall axis reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 720 });
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/hotfix/1?view=timeline`);
  const panel = page.locator('[data-detail-panel="phase"]');
  const waterfall = page.locator("[data-waterfall]");
  const scroller = waterfall.locator("div.overflow-x-auto");
  const panelBox = await boxOf(panel);
  const waterfallBox = await boxOf(waterfall);
  expect(panelBox.y).toBeGreaterThan(waterfallBox.y);
  expect(Math.abs(panelBox.width - waterfallBox.width)).toBeLessThan(4);
  expect(await scroller.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  expect(await panel.evaluate((node) => node.scrollHeight > node.clientHeight + 1)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(
    0,
  );
});

test("the Waterfall stays visible while a person reads the Phase panel", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 400 });
  await openRun(page, "run-merged");
  await page.goto(`${origin}/runs/run-merged/phases/hotfix/1?view=timeline`);
  await page
    .locator('[data-detail-panel="phase"]')
    .evaluate((node) => node.scrollIntoView({ block: "end" }));
  const box = await boxOf(page.locator("[data-waterfall]"));
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeLessThan(48);
  expect(box.height).toBeGreaterThan(0);
});

test("failed Run outcome and labelled provenance remain on the Run page", async ({ page }) => {
  await openRun(page, "run-broken");
  const outcome = page.locator('[data-run-outcome="failed"]');
  await expect(outcome).toBeVisible();
  await expect(outcome.locator('[data-outcome-link="edit"]')).toBeVisible();
  await outcome.locator('[data-outcome-link="edit"]').click();
  await expect(page.locator('[data-detail-panel="phase"]')).toBeVisible();

  await page.locator("[data-panel-close]").click();
  for (const name of ["engine", "commit", "host", "config", "idempotency-key", "branch"]) {
    await expect(page.locator(`[data-stamp="${name}"]`)).toHaveCount(1);
  }
});

test("a successful Run has no failure outcome and a Host-only Run states no branch", async ({
  page,
}) => {
  await openRun(page, "run-stale");
  await expect(page.locator("[data-run-outcome]")).toHaveCount(0);
  await expect(page.locator('[data-stamp="branch"]')).toContainText("no sandbox was acquired");
});
