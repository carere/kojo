import { expect, type Page, test } from "@playwright/test";
import { realConsole } from "./harness.ts";

/**
 * **The whole loop, from the command to the DOM.**
 *
 * Every other spec in this directory renders *stated* records. This one renders a run that `kojo
 * run` produced against a factory `kojo init` stamped, served by `kojo ui` over the SQLite file that
 * run wrote — see `realFactory.ts` for how the server is built.
 *
 * It exists because the fixtures could not see the defect it was written for. A record built by
 * omitting an absent field encodes to nothing on the wire; the same record built by passing
 * `undefined` encodes to `null`. The fixtures did the first, the SQLite readers did the second, and
 * the Console — which had only ever been shown the first — threw `TypeError: null is not an object`
 * on `spansOf` for every non-terminal run a real factory has ever had. Eighty-five specs stayed
 * green over a Console that rendered nothing at all.
 *
 * So the assertions below are deliberately the *ordinary* ones: the waterfall is drawn, the phases
 * are on it, the gate card is there, the panel opens. Nothing exotic. The value is entirely in what
 * produced the document being read.
 *
 * **No agent is invoked anywhere in this file.** The workflow the harness stamps is two `code`
 * phases and a gate inside a sandbox scope.
 */

/**
 * The only run this factory has, and when it started.
 *
 * Both are read off the API rather than written down here: the id is the engine's — a hash of the
 * idempotency key — and the instant is whenever this suite happened to start the server. A spec that
 * stated either would be asserting against a fixture again.
 */
const theRun = async (page: Page): Promise<{ runId: string; startedAt: number }> => {
  const response = await page.request.get(`${realConsole}/api/runs`);
  expect(response.ok()).toBe(true);
  const runs = (await response.json()) as ReadonlyArray<{
    readonly run: { readonly runId: string; readonly workflow: string; readonly startedAt: number };
  }>;
  expect(runs).toHaveLength(1);
  expect(runs[0]?.run.workflow).toBe("paperwork");
  return { runId: runs[0]?.run.runId as string, startedAt: runs[0]?.run.startedAt as number };
};

/**
 * The run's page, with the clock stopped five seconds after the run began.
 *
 * **Frozen for the same reason every other spec here freezes it, and one more.** A suspended run has
 * no end, so the axis runs to *now* and every span on it narrows once a second while the page is
 * open — geometry that moves under a click. Stopping the clock at a fixed offset from the run's own
 * start makes the layout the same on a fast machine and a slow one, without stating a single
 * timestamp.
 */
const openTheRun = async (page: Page): Promise<string> => {
  const { runId, startedAt } = await theRun(page);
  await page.addInitScript(`window.__KOJO_NOW__ = ${startedAt + 5_000}`);
  await page.goto(`${realConsole}/runs/${runId}`);
  await page.waitForSelector("[data-waterfall], [data-notice]");
  return runId;
};

/**
 * In order, in one worker: the last test writes a verdict into the factory the others are reading.
 *
 * There is one database and one gate, so the write is not repeatable and cannot race the reads.
 */
test.describe.configure({ mode: "serial" });

test.describe("the run view over a run kojo run produced", () => {
  /**
   * **The assertion the ticket is about.** Before adr/trace/0003 this page was a header, an empty
   * panel and *"No phases yet"* over a run with recorded phases — or nothing at all, depending on
   * where the `TypeError` landed.
   */
  test("draws the waterfall, and not the empty notice", async ({ page }) => {
    const runId = await openTheRun(page);

    await expect(page.locator(`[data-run-header="${runId}"]`)).toHaveCount(1);
    await expect(page.locator("[data-waterfall]")).toHaveCount(1);
    // The notice this page used to be. Its absence is the fix, stated the way a reader meets it.
    await expect(page.getByText("No phases yet.")).toHaveCount(0);

    // Both phases the workflow ran, by the ids the engine minted for them.
    await expect(page.locator(`[data-phase="${runId}/prepare/1"]`)).toHaveCount(1);
    await expect(page.locator(`[data-phase="${runId}/stamp/1"]`)).toHaveCount(1);
    await expect(page.locator(`[data-phase="${runId}/prepare/1"]`)).toHaveAttribute(
      "data-state",
      "succeeded",
    );
  });

  /**
   * The scope tree, from a real acquisition.
   *
   * The workflow enters a `sandboxed` scope, so the run has a host row and a `desk` row, and the
   * phases sit on the second. `--sandbox none` is a real answer rather than an opt-out: the scope
   * still cuts a branch and still hands the phases a workspace, on this machine.
   */
  test("puts the phases on the acquisition they ran inside, not on the host", async ({ page }) => {
    const runId = await openTheRun(page);

    const rows = page.locator("[data-row]");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-scope", "host");
    await expect(rows.nth(1)).toHaveAttribute("data-scope", "sandbox");
    await expect(rows.nth(1)).toContainText("desk");

    await expect(rows.nth(1).locator(`[data-phase="${runId}/prepare/1"]`)).toHaveCount(1);
    await expect(rows.nth(0).locator(`[data-phase="${runId}/prepare/1"]`)).toHaveCount(0);
  });

  /** A phase, in the docked panel, over records read out of SQLite rather than stated. */
  test("opens a phase into the detail panel", async ({ page }) => {
    const runId = await openTheRun(page);

    await page.locator(`[data-phase="${runId}/stamp/1"]`).click();

    const panel = page.locator("[data-detail-panel]");
    await expect(panel).toHaveAttribute("data-detail-panel", "phase");
    await expect(panel).toContainText("stamp");
    await expect(panel).toContainText("Stamp the form before anybody signs it");
    // A code phase asked nothing and graded nothing, and the panel says so rather than drawing a
    // blank — which is the same *absent* this ticket made unambiguous on the wire.
    await expect(panel.locator('[data-agent="none"]')).toHaveCount(1);
  });

  /**
   * **A human can answer this gate from a browser.**
   *
   * The card is what the run is stopped on, and the choices on it are the gate's own — `approve` and
   * `reject` come from the workflow file the harness wrote, not from anything the page assumes.
   */
  test("shows the gate the run is suspended on, with the choices the workflow declared", async ({
    page,
  }) => {
    await openTheRun(page);

    const card = page.locator('[data-gate-card="sign-off"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Sign form 12?");
    await expect(card).toContainText("clerk");
    await expect(card.locator('[data-gate-choice="approve"]')).toHaveCount(1);
    await expect(card.locator('[data-gate-choice="reject"]')).toHaveCount(1);
  });

  /**
   * The click, all the way through to the trace — and the receipt that stays honest about it.
   *
   * Nothing is watching this factory, so the answer is **recorded and not applied**: no runner exists
   * to replay the body. adr/gate/0001 is the record; what is new here is that it is graded against a
   * real `GateRepository` on disk instead of a stated one, so the answerer is the OS user and the
   * verdict is a row.
   *
   * It runs last, and it is the only test here that writes: the ones above read the same server.
   */
  test("records an answer against the real factory, and says nothing applied it", async ({
    page,
  }) => {
    await openTheRun(page);

    await page.locator("[data-gate-reason]").fill("the form is in order");
    await page.locator('[data-gate-choice="approve"]').click();

    await expect(page.locator("[data-answering-verdict]")).toContainText("approve");
    await expect(page.locator("[data-answering-verdict]")).toContainText("the form is in order");
    // Recorded, and honest that nothing carried it further. `applied` here would be the one lie the
    // gate card exists to make impossible.
    await expect(page.locator("[data-gate-card] [data-answering]")).toHaveAttribute(
      "data-answering",
      "idle",
    );
  });
});
