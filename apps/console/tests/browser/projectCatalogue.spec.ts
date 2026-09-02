import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const root = "/tmp/kojo-ticket-70-browser";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the Project fixture Daemon did not issue a grant");
  return result.stdout;
};

test("filters an authoritative Project grid and keeps stable URL selection", async ({ page }) => {
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
  await expect(page.locator("[data-project-id]")).toHaveCount(2);
  await expect(page.getByText("1 missing Factory", { exact: true })).toBeVisible();
  await expect(page.getByText("1 invalid Factory", { exact: true })).toBeVisible();

  await page.getByLabel("Factory state").selectOption("missing");
  await expect(page.locator("[data-project-id]")).toHaveCount(1);
  await page.getByLabel("Find Projects").fill("does-not-exist");
  await expect(page.getByText("No Projects match these filters.", { exact: true })).toBeVisible();
  await page.getByLabel("Find Projects").fill("");

  const selector = page.getByRole("checkbox", { name: /Select project-missing/ });
  await selector.check();
  await expect(page).toHaveURL(/factory=missing.*selected=/);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Select project-missing/ })).toBeChecked();

  const navigation = page.getByRole("navigation", { name: "Console" });
  await expect(navigation.getByRole("link")).toHaveCount(4);
  await expect(navigation.getByText("project-missing")).toHaveCount(0);
});

test("keeps flat resource navigation and durable links out of every Project row", async ({
  page,
}) => {
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  const navigation = page.getByRole("navigation", { name: "Console" });
  await expect(navigation.getByRole("link")).toHaveText(["Projects", "Runs", "Gate", "Daemon"]);
  await expect(navigation.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/");
  await expect(navigation.getByRole("link", { name: "Runs" })).toHaveAttribute("href", "/runs");
  await expect(navigation.getByRole("link", { name: "Gate" })).toHaveAttribute("href", "/gates");
  await expect(navigation.getByRole("link", { name: "Daemon" })).toHaveAttribute("href", "/daemon");
  await expect(page.getByRole("link", { name: "project-missing", exact: true })).toHaveAttribute(
    "href",
    /^\/projects\/[^/]+$/,
  );
});

test("paginates fifty filtered Projects and keeps the cursor in the URL", async ({ page }) => {
  await page.route("**/api/v1/projects", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as {
      projects: ReadonlyArray<Record<string, unknown>>;
      counts: Record<string, number>;
    };
    const template = snapshot.projects[0];
    if (template === undefined) throw new Error("the Project fixture has no pagination template");
    const projects = Array.from({ length: 51 }, (_, index) => ({
      ...template,
      projectId: `project-page-${String(index + 1).padStart(2, "0")}`,
      label: `project-page-${String(index + 1).padStart(2, "0")}`,
      location: `/tmp/project-page-${String(index + 1).padStart(2, "0")}`,
    }));
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({
        ...snapshot,
        projects,
        counts: { ...snapshot.counts, total: projects.length },
      }),
    });
  });
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.locator("[data-project-id]")).toHaveCount(50);
  await expect(page.getByText("1–50 of 51", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("[data-project-id]")).toHaveCount(1);
  await expect(page.getByText("51–51 of 51", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/cursor=50/);
  await page.getByLabel("Find Projects").fill("project-page-51");
  await expect(page.locator("[data-project-id]")).toHaveCount(1);
  await expect(page).not.toHaveURL(/cursor=/);
});

test("shows Project location history, drain consequences, and explicit confirmation", async ({
  page,
}) => {
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
  const project = page.getByRole("link", { name: "project-missing", exact: true });
  const href = await project.getAttribute("href");
  expect(href).not.toBeNull();
  await page.goto(`http://127.0.0.1:47242${href}`);

  const location = page.getByRole("region", { name: "Project location" });
  await expect(location.getByText("Active location · confirmed", { exact: true })).toBeVisible();
  await expect(location.getByText(/Retained history: 1 location record/)).toBeVisible();
  await location.getByRole("button", { name: "Relocate or confirm" }).click();
  await expect(location.getByLabel("Exact Git working-tree root")).toHaveValue(
    /\/kojo-ticket-70-browser\/project-missing$/,
  );
  const confirm = location.getByRole("checkbox", {
    name: /new dispatch will stop and drain.*Workflows will become inactive.*pinned revisions will not change/i,
  });
  const apply = location.getByRole("button", { name: "Confirm relocate" });
  await expect(apply).toBeDisabled();
  await confirm.check();
  await expect(apply).toBeEnabled();
});
