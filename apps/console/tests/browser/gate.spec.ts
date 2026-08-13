import { expect, type Locator, type Page, test } from "@playwright/test";
import { consoleAt, type FixtureName, frozenNow } from "./harness.ts";

/**
 * Answering a gate from a browser — console.md §4 and §9, and adr/gate/0001.
 *
 * **The claim under test is not "the click worked".** It is that the Console never draws a recorded
 * answer as an applied one. A `POST` writes a verdict; a live runner applies it; those are two
 * events that can be days apart, and an *approved ✓* that means nothing is the single failure that
 * destroys trust in a control surface. So the assertions below are about *which of five words* the
 * card says, and where each one is read from.
 *
 * Three states, three sources, and the fixtures are arranged so that no two of them can be confused:
 *
 * | State | What the server is showing | What proves it |
 * |---|---|---|
 * | *recorded — nothing is running* | `busy`, whose runner table is empty | the receipt's `runner` |
 * | *recorded — applying…* | `watching`, one fresh registration | the same records, one variable apart |
 * | *applied — the run resumed* | `busy`, `run-merged` | the run's own settled gate record |
 *
 * **Which askings a test may answer is part of the design of this file.** The askings live in one
 * repository for the life of the server, so a test that answered a gate another test reads would
 * change what that test sees. `run-waiting` exists to be answered and nothing asserts how it is
 * drawn beforehand; `run-approve` on `watching` is answered only by the refusal test.
 */

const openAt = async (
  page: Page,
  fixtures: FixtureName,
  path: string,
  options: { readonly now?: number } = {},
): Promise<void> => {
  await page.addInitScript(`window.__KOJO_NOW__ = ${options.now ?? frozenNow}`);
  await page.goto(`${consoleAt[fixtures]}${path}`);
};

const card = (page: Page): Locator => page.locator("[data-gate-card]");
const state = (page: Page): Locator => page.locator("[data-gate-card] [data-answering]");
const field = (page: Page, name: string): Locator =>
  page.locator(`[data-gate-card] [data-field="${name}"]`);
const choice = (page: Page, name: string): Locator =>
  page.locator(`[data-gate-card] [data-gate-choice="${name}"]`);

/**
 * The same things, inside the docked panel.
 *
 * **The card and the panel can both be on screen holding the same asking**, because the panel is a
 * nested route beside the run view and the card sits in the run's header. Both carry the answer
 * controls on purpose — the queue links straight into the panel, so the panel has to be answerable
 * without going through the card — so every assertion here says which of the two it is about.
 */
const panel = (page: Page): Locator => page.locator("[data-detail-panel]");
const panelState = (page: Page): Locator => page.locator("[data-detail-panel] [data-answering]");
const panelField = (page: Page, name: string): Locator =>
  page.locator(`[data-detail-panel] [data-field="${name}"]`);

/** The asking the engine names `gate/<gate>/<round>`, as it travels in a URL. */
const askingPath = (gate: string): string => encodeURIComponent(`gate/${gate}/1`);

test.describe("the gate card sits beneath the run header", () => {
  test("says what is being decided, how long it has waited, and the deadline with its branch", async ({
    page,
  }) => {
    await openAt(page, "busy", "/runs/run-approve");

    await expect(card(page)).toHaveAttribute("data-gate-card", "approve-hotfix");
    await expect(card(page)).toContainText("Should the approve-hotfix proceed?");
    await expect(card(page)).toContainText("release-manager");
    // Human latency, readable while the wait is still happening — which is the only time anybody
    // can shorten it. Nothing else in the Console states it for a gate that has not settled.
    await expect(field(page, "waited")).toContainText("41h 0m");
    await expect(field(page, "deadline")).toContainText("in 7h 0m");
    // The deadline without its branch is a number with no consequence attached.
    await expect(field(page, "on-expiry")).toContainText("fail");
    await expect(state(page)).toHaveAttribute("data-answering", "waiting");
  });

  test("draws one button per choice the gate declared, and no other", async ({ page }) => {
    await openAt(page, "busy", "/runs/run-approve");

    // Three, because this gate declares three. A card that hard-coded approve and reject would hide
    // whatever third answer the workflow was written to handle.
    await expect(page.locator("[data-gate-choice]")).toHaveCount(3);
    await expect(choice(page, "hold")).toBeVisible();
  });

  test("is absent from a run that has never waited on anybody", async ({ page }) => {
    await openAt(page, "busy", "/runs/run-scout");

    await expect(card(page)).toHaveCount(0);
    await expect(page.locator("[data-run-header]")).toBeVisible();
  });

  test("is absent from a finished run whose gate nobody is owed anything about", async ({
    page,
  }) => {
    await openAt(page, "busy", "/runs/run-broken");

    await expect(card(page)).toHaveCount(0);
  });

  test("reads the clock it was given, so a deadline crosses when the clock does", async ({
    page,
  }) => {
    await openAt(page, "busy", "/runs/run-approve", { now: frozenNow + 8 * 60 * 60 * 1_000 });

    await expect(field(page, "deadline")).toContainText("overdue by 1h 0m");
    await expect(state(page)).toHaveAttribute("data-answering", "overdue");
  });
});

test.describe("a recorded answer is never drawn as an applied one", () => {
  /**
   * One click, and everything that click has to be true about — in one test on purpose.
   *
   * There is exactly one asking on this server a test may answer, because the askings live in one
   * repository for the life of it. Splitting these assertions into three tests would make the second
   * and third depend on running before the first.
   */
  test("with nothing running, the click records the verdict and says the run has not moved", async ({
    page,
  }) => {
    await openAt(page, "busy", "/runs/run-waiting");
    await expect(state(page)).toHaveAttribute("data-answering", "waiting");

    await page.locator("[data-gate-reason]").fill("the migration is reversible");
    await choice(page, "approve").click();

    // The sentence adr/gate/0001 exists to make sure gets written. The verdict is real and will
    // apply; the run has not moved, and the card says which of those two things happened.
    await expect(state(page)).toHaveAttribute("data-answering", "idle");
    await expect(state(page)).toContainText("Recorded — nothing is running");
    await expect(state(page)).toContainText("kojo watch");
    await expect(state(page)).not.toContainText("Applied");
    // And the run is exactly where it was, which is the fact the wording is about.
    await expect(page.locator("[data-run-header]")).toBeVisible();
    await expect(page.getByText("suspended").first()).toBeVisible();

    // The verdict, the reason and who it is attributed to. The answerer comes from the server's own
    // process and never from a field a browser could fill — an attribution a page could forge is
    // worse than none, and a gate is worth auditing only because of this line.
    await expect(page.locator("[data-answering-verdict]")).toContainText("approve");
    await expect(page.locator("[data-answering-verdict]")).toContainText(
      "the migration is reversible",
    );
    await expect(page.locator("[data-answering-verdict]")).not.toHaveText("");

    // The controls are gone: the engine keeps the first answer, so a second click could only ever
    // produce a refusal over a decision already made.
    await expect(page.locator("[data-gate-choice]")).toHaveCount(0);
  });

  test("a verdict recorded before this page loaded still reads as recorded", async ({ page }) => {
    // No click at all: the fixture states an asking answered five minutes ago with no settled record
    // beside it. A page that decided *applied* from a verdict alone would say the run had resumed.
    await openAt(page, "busy", "/runs/run-recorded");

    await expect(state(page)).toHaveAttribute("data-answering", "idle");
    await expect(page.locator("[data-answering-since]")).toContainText("5m 0s");
    await expect(state(page)).not.toContainText("Applied");
  });

  test("with a runner alive the same click says applying, and stays there without complaint", async ({
    page,
  }) => {
    await openAt(page, "watching", "/runs/run-waiting");

    await choice(page, "approve").click();

    // The records are `busy`'s, byte for byte. The only difference between this server and that one
    // is a row in the runner table, so this word can only have come from reading it.
    await expect(state(page)).toHaveAttribute("data-answering", "applying");
    await expect(state(page)).toContainText("Recorded — applying…");
    // Still not applied. A runner being alive says somebody *can* apply it, and nothing more.
    await expect(state(page)).not.toContainText("the run resumed");

    // A runner picks up a message written by another process on its own poll interval, so this state
    // has a visible duration — around ten seconds is ordinary. A spinner that gave up sooner would
    // be lying in the other direction, and an error here would send somebody debugging a healthy
    // factory.
    await page.waitForTimeout(11_000);

    await expect(state(page)).toHaveAttribute("data-answering", "applying");
    await expect(page.locator("[data-gate-refusal]")).toHaveCount(0);
    await expect(page.locator('[data-notice="retrying"]')).toHaveCount(0);
  });
});

test.describe("applied is drawn from the run's own record and from nothing else", () => {
  test("a settled asking says the run resumed", async ({ page }) => {
    await openAt(
      page,
      "busy",
      `/runs/run-merged/gates/approve-hotfix/${askingPath("approve-hotfix")}`,
    );

    // `run-merged` carries both halves: a verdict on the asking and a settled gate record written by
    // the run itself, in the activity that follows the suspension. Only the second may say this.
    await expect(panelState(page)).toHaveAttribute("data-answering", "applied");
    await expect(panelState(page)).toContainText("Applied — the run resumed");
    await expect(page.locator("[data-gate-outcome]")).toHaveAttribute(
      "data-gate-outcome",
      "answered",
    );
  });

  test("a verdict with no settled record beside it never reaches applied", async ({ page }) => {
    await openAt(
      page,
      "busy",
      `/runs/run-recorded/gates/approve-release/${askingPath("approve-release")}`,
    );

    await expect(panelState(page)).toHaveAttribute("data-answering", "idle");
    // The pair is the whole test: same verdict shape, no record, and therefore a different word.
    await expect(page.locator("[data-gate-outcome]")).toHaveCount(0);
  });

  /**
   * The same lie, pointed the other way — and the one that survived the first implementation.
   *
   * `phase/gate.ts` writes the `<asking>/record` activity for **both** settlements: the durable
   * deferred resolving *and* the durable clock firing. So a settled record keyed by an asking is not
   * proof anybody answered — only a record whose outcome is `answered` is. A card that read presence
   * alone put *"Applied — the run resumed. A runner picked the answer up"* in front of a person over
   * a question nobody ever decided, beside a panel already saying `expired`.
   */
  test("an asking the deadline settled never says a runner picked an answer up", async ({
    page,
  }) => {
    await openAt(page, "busy", "/runs/run-expired");

    await expect(state(page)).toHaveAttribute("data-answering", "expired");
    await expect(state(page)).toContainText("Expired — the run moved on without an answer");
    // The two sentences that must never appear over a gate nobody answered.
    await expect(state(page)).not.toContainText("Applied");
    await expect(state(page)).not.toContainText("A runner picked the answer up");
    // Nor is it *overdue*: overdue means the run has not taken its branch yet and an answer might
    // still land. This one is finished, and offering a button would invite an answer that is not
    // wanted and would be refused.
    await expect(page.locator("[data-gate-choice]")).toHaveCount(0);
    await expect(page.locator("[data-answering-verdict]")).toHaveCount(0);
  });

  test("and the panel's two halves say the same thing about it", async ({ page }) => {
    await openAt(
      page,
      "busy",
      `/runs/run-expired/gates/approve-deploy/${askingPath("approve-deploy")}`,
    );

    // The trace's own word for how it ended, and the sentence the answering block draws from the
    // same record. Before the fix these two were on screen together and contradicted each other.
    await expect(page.locator("[data-gate-outcome]")).toHaveAttribute(
      "data-gate-outcome",
      "expired",
    );
    await expect(panelState(page)).toHaveAttribute("data-answering", "expired");
    await expect(panelState(page)).not.toContainText("the run resumed");
  });
});

test.describe("a gate is the detail panel's third subject", () => {
  test("opens docked beside the waterfall, with the asking encoded in the URL", async ({
    page,
  }) => {
    await openAt(page, "busy", "/runs/run-approve");

    await page.locator("[data-gate-open]").click();

    // The asking is the engine's durable deferred name and carries slashes, so it is the one segment
    // on this surface that is percent-encoded. It round-trips: the panel found the asking by it.
    await expect(page).toHaveURL(/\/runs\/run-approve\/gates\/approve-hotfix\/gate%2F/);
    await expect(panel(page)).toHaveAttribute("data-detail-panel", "gate");
    await expect(panelField(page, "token")).not.toHaveText("");
    await expect(panelField(page, "choices")).toContainText("hold");
    // A panel and not a page: the position somebody clicked from is still on screen.
    await expect(page.locator("[data-waterfall]")).toBeVisible();
  });

  test("the same URL, pasted, opens the same panel", async ({ page }) => {
    await openAt(
      page,
      "busy",
      `/runs/run-approve/gates/approve-hotfix/${askingPath("approve-hotfix")}`,
    );

    await expect(panel(page)).toHaveAttribute("data-detail-panel", "gate");
    await expect(panelField(page, "waited")).toContainText("41h 0m");
  });

  test("one subject at a time: opening a gate lets go of a selected phase", async ({ page }) => {
    await openAt(page, "busy", "/runs/run-approve/phases/scout/1");
    await expect(page.locator('[data-selected="true"]')).toHaveCount(1);

    await page.locator("[data-gate-open]").click();

    await expect(page.locator("[data-detail-panel]")).toHaveAttribute("data-detail-panel", "gate");
    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  });

  test("an asking one character wrong says so and leaves the run on screen", async ({ page }) => {
    await openAt(page, "busy", "/runs/run-approve/gates/approve-hotfix/gate%2Fapprove-hotfix%2F9");

    await expect(page.locator("[data-detail-panel]")).toContainText(
      "no asking gate/approve-hotfix/9",
    );
    await expect(page.locator("[data-waterfall]")).toBeVisible();
    await expect(page.locator("[data-run-header]")).toBeVisible();
  });
});

test.describe("the queue is what waits on a human, across runs", () => {
  test("lists every waiting asking, worst first, with the wait on each", async ({ page }) => {
    await openAt(page, "busy", "/gates");

    const waiting = page.locator('[data-queued="run-stale"]');
    await expect(waiting).toContainText("approve-feature");
    await expect(waiting).toContainText("tech-lead");
    await expect(waiting).toContainText("overdue by 2h 0m");

    // Worst first: the overdue one is above the one still inside its deadline, whatever order the
    // server answered in. The whole reason to print this list is to find what nobody has looked at.
    const rows = page.locator("[data-queued]");
    await expect(rows.first()).toHaveAttribute("data-queued", "run-stale");
    await expect(page.locator('[data-queued="run-approve"]')).toContainText("41h 0m");
  });

  test("an answered asking moves into the settled list rather than vanishing", async ({ page }) => {
    await openAt(page, "busy", "/gates");

    const recorded = page.locator('[data-queue="recorded"]');
    await expect(recorded.locator('[data-queued="run-recorded"]')).toContainText(
      "recorded by release-manager",
    );
    // A queue that emptied on a click would be claiming the run had moved. This page reads one list
    // across every run and has no run document to check, so it says *recorded* and stops there.
    await expect(recorded).not.toContainText("Applied");
    await expect(recorded).toContainText("whether a runner has applied it is on the run");
  });

  test("an expired asking leaves the waiting list, and is expired, never overdue", async ({
    page,
  }) => {
    await openAt(page, "busy", "/gates");

    // Ticket 46's failure, on the page it happened on: `run-expired`'s deadline passed two hours
    // ago and the run has already taken its expiry branch, yet this queue listed it as waiting,
    // *overdue by* a number growing without bound. It has exactly one row, and that row is in the
    // settled list — so it is out of the table of work somebody could still do.
    await page.locator('[data-queue="recorded"]').waitFor();
    await expect(page.locator('[data-queued="run-expired"]')).toHaveCount(1);
    const settled = page.locator('[data-queue="recorded"] [data-queued="run-expired"]');
    await expect(settled).toContainText("approve-deploy");

    // Expired is not overdue: overdue means an answer may still land, expired means it cannot.
    await expect(settled.locator("[data-queued-expired]")).toContainText(
      "expired — nobody answered in time",
    );
    await expect(settled).not.toContainText("overdue");

    // The wait it cost is still on the row — frozen at the expiry, request to deadline — because
    // human latency is the number this surface exists for.
    await expect(settled.locator("[data-queued-waited]")).toContainText("2h 0m");
  });

  test("a gate in the queue is one click from the panel that answers it", async ({ page }) => {
    await openAt(page, "busy", "/gates");

    await page.locator('[data-queued="run-approve"] [data-queued-open]').click();

    await expect(page).toHaveURL(/\/runs\/run-approve\/gates\/approve-hotfix\/gate%2F/);
    await expect(page.locator("[data-detail-panel]")).toHaveAttribute("data-detail-panel", "gate");
    await expect(panel(page).locator("[data-gate-choice]")).toHaveCount(3);
  });

  test("the run list is a way into it, and its count leaves settled askings out", async ({
    page,
  }) => {
    await openAt(page, "busy", "/");

    // The count may not include `run-expired`: its asking settled without an answer, and a count
    // that kept it would inherit the queue's own lie. It is compared against the server's own list
    // rather than against a literal, because the askings live in one repository for the life of
    // this server and another test legitimately answers one of them in parallel — the *rule* under
    // test is which rows count, not how many the suite's ordering happens to leave.
    const gatesOnServer = async () => {
      const listed = await page.request.get(`${consoleAt.busy}/api/gates`);
      return (await listed.json()) as ReadonlyArray<{
        readonly request: { readonly runId: string };
        readonly verdict?: unknown;
        readonly expiredAt?: number;
      }>;
    };

    // The fixture's own invariant, read where the page reads it: `run-expired` has no verdict and
    // is settled anyway — exactly the row the old filter kept. No test ever answers it, so this
    // half is stable whatever runs beside it.
    const expired = (await gatesOnServer()).find(
      (asking) => asking.request.runId === "run-expired",
    );
    expect(expired?.verdict).toBeUndefined();
    expect(expired?.expiredAt).toBeDefined();

    await expect
      .poll(async () => {
        const askings = await gatesOnServer();
        const stillWaiting = askings.filter(
          (asking) => asking.verdict === undefined && asking.expiredAt === undefined,
        ).length;
        const text = await page.locator("[data-queue-link]").textContent();
        return text?.includes(`${stillWaiting} waiting on a human`) ?? false;
      })
      .toBe(true);

    await page.locator("[data-queue-link]").click();
    await expect(page).toHaveURL(/\/gates$/);
  });

  test("a factory with nothing waiting says so rather than showing an empty table", async ({
    page,
  }) => {
    await openAt(page, "empty", "/gates");

    await expect(page.getByText("Nothing is waiting on a human.")).toBeVisible();
  });
});

test.describe("a refusal is the server answering, not an outage", () => {
  test("a gate somebody else answered first refuses the second answer and says why", async ({
    page,
  }) => {
    // The askings are frozen at what this page loaded, so the card keeps its controls while the gate
    // is answered underneath it. That is the race this refusal exists for — two answering halves,
    // one token — reproduced without two browsers.
    await openAt(page, "watching", "/runs/run-approve");
    await expect(page.locator("[data-gate-choice]")).toHaveCount(3);

    const listed = await page.request.get(`${consoleAt["watching"]}/api/gates`);
    const askings = (await listed.json()) as ReadonlyArray<{
      readonly request: { readonly runId: string; readonly token: string };
    }>;
    const token = askings.find((one) => one.request.runId === "run-approve")?.request.token ?? "";
    expect(token).not.toBe("");

    await page.route("**/api/gates", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(askings) });
    });

    const first = await page.request.post(
      `${consoleAt["watching"]}/api/gates/${encodeURIComponent(token)}/answer`,
      { data: { choice: "approve", reason: "answered from a terminal" } },
    );
    expect(first.status()).toBe(200);

    await page.locator('[data-gate-choice="reject"]').click();

    // The API's own code, drawn as a refusal rather than as a retrying banner: the first answer is
    // the one that counts, and a page that showed this as an outage would send somebody looking for
    // a server fault over a decision that had already been made.
    await expect(page.locator("[data-gate-refusal]")).toHaveAttribute(
      "data-gate-refusal",
      "already-answered",
    );
    await expect(page.locator("[data-gate-refusal]")).toContainText("first answer");
    await expect(page.locator('[data-notice="retrying"]')).toHaveCount(0);
  });
});
