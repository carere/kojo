import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const root = "/tmp/kojo-ticket-74-browser";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launchUrl = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the isolated Daemon did not issue a launch grant");
  return result.stdout;
};

test("serves an Artifact only through authenticated bounded display and download responses", async ({
  page,
}) => {
  const artifactId = readFileSync(`${root}/artifact-id`, "utf8");
  const path = `/api/v1/runs/run-applied/artifacts/${artifactId}`;

  await page.goto(launchUrl());
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await page.goto(new URL("/runs/run-applied", page.url()).href);
  const displayButton = page.locator(`[data-published-artifact-display="${artifactId}"]`);
  await expect(displayButton).toBeVisible();
  await displayButton.click();
  const displayed = page.locator(`[data-published-artifact-content="${artifactId}"]`);
  await expect(displayed).toHaveText("<script>window.__artifactExecuted = true</script>\n");
  expect(await page.evaluate(() => "__artifactExecuted" in window)).toBe(false);

  const download = page.waitForEvent("download");
  await page.locator(`[data-published-artifact-download="${artifactId}"]`).click();
  expect((await download).suggestedFilename()).toBe("agent__output_.txt");

  const responses = await page.evaluate(async (artifactPath) => {
    const stored = window.sessionStorage.getItem("kojo.browser-session.v1");
    if (stored === null) throw new Error("the browser session was not retained");
    const credential = (JSON.parse(stored) as { readonly credential: string }).credential;
    const headers = { authorization: `Bearer ${credential}` };
    const display = await fetch(artifactPath, { headers });
    const download = await fetch(`${artifactPath}?download=1`, { headers });
    return {
      displayStatus: display.status,
      displayType: display.headers.get("content-type"),
      displayBody: await display.text(),
      downloadStatus: download.status,
      downloadType: download.headers.get("content-type"),
      disposition: download.headers.get("content-disposition"),
      nosniff: download.headers.get("x-content-type-options"),
      policy: download.headers.get("content-security-policy"),
      downloadBody: await download.text(),
      executed: "__artifactExecuted" in window,
    };
  }, path);

  expect(responses).toMatchObject({
    displayStatus: 200,
    displayType: "application/json;charset=utf-8",
    downloadStatus: 200,
    downloadType: "application/octet-stream",
    disposition: 'attachment; filename="agent__output_.txt"',
    nosniff: "nosniff",
    policy: "sandbox; default-src 'none'",
    downloadBody: "<script>window.__artifactExecuted = true</script>\n",
    executed: false,
  });
  expect(JSON.parse(responses.displayBody)).toMatchObject({
    name: "agent <output>.txt",
    mediaType: "text/plain; charset=utf-8",
    content: "<script>window.__artifactExecuted = true</script>\n",
  });

  const withoutAuthority = await page.request.get(`http://127.0.0.1:47244${path}`);
  expect(withoutAuthority.status()).toBe(401);
});
