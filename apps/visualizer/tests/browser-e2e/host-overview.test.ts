import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterEach, expect, test } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../tests/support/cli-process";
import {
  type KojoHostProcessFixture,
  startKojoHostProcess,
} from "../../../../tests/support/host-process";

interface Fixture {
  readonly browser: Browser;
  readonly host: KojoHostProcessFixture;
  readonly port: number;
  readonly visualizer: Bun.Subprocess;
}

let fixture: Fixture | undefined;
const temporaryDirectories: Array<() => Promise<void>> = [];

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.browser.close();
    fixture.visualizer.kill("SIGTERM");
    await fixture.visualizer.exited;
    await fixture.host.stop();
    fixture = undefined;
  }
  await Promise.all(temporaryDirectories.splice(0).map((cleanup) => cleanup()));
});

test("loads the Host-authoritative Project state and reconciles Navigator preferences by Project Identity", async () => {
  fixture = await startFixture();
  const page = await fixture.browser.newPage();

  await page.goto(`http://127.0.0.1:${fixture.port}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Connected to Kojo Host 0.1.0").waitFor({ state: "visible" });
  await page.getByText("No Kojo Projects yet.").waitFor({ state: "visible" });

  expect(await page.getByText("Connected to Kojo Host 0.1.0").isVisible()).toBe(true);
  expect(await page.getByText("No Kojo Projects yet.").isVisible()).toBe(true);
  const directory = await makeTemporaryDirectory("kojo-navigator-");
  temporaryDirectories.push(directory.cleanup);
  const firstPath = join(directory.path, "first-project");
  const secondPath = join(directory.path, "second-project");
  await run(["git", "init", firstPath]);
  await run(["git", "init", secondPath]);
  expect((await runKojoCli(["init", firstPath], fixture.host.socketPath)).exitCode).toBe(0);
  expect((await runKojoCli(["init", secondPath], fixture.host.socketPath)).exitCode).toBe(0);
  const listed = await runKojoCli(["project", "list", "--json"], fixture.host.socketPath);
  expect(JSON.parse(listed.stdout).result.projects).toHaveLength(2);
  const firstIdentity = JSON.parse(await readFile(join(firstPath, ".kojo", "project.json"), "utf8"))
    .projectIdentity as string;
  const secondIdentity = JSON.parse(
    await readFile(join(secondPath, ".kojo", "project.json"), "utf8"),
  ).projectIdentity as string;
  const staleIdentity = "00000000-0000-7000-8000-000000000000";
  await page.evaluate(
    ({ firstIdentity, secondIdentity, staleIdentity }) => {
      window.localStorage.setItem(
        "kojo.navigator.preferences",
        JSON.stringify({
          version: 1,
          order: [secondIdentity, "malformed-project-identity", staleIdentity, firstIdentity],
          selectedProjectIdentity: secondIdentity,
        }),
      );
    },
    { firstIdentity, secondIdentity, staleIdentity },
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.locator("body").innerText()).toContain(secondIdentity);
  const projects = page.getByRole("navigation", { name: "Kojo Projects" }).getByRole("button");
  await expect.poll(() => projects.count()).toBe(2);

  expect(await projects.nth(0).getAttribute("data-project-identity")).toBe(secondIdentity);
  expect(await projects.nth(0).getAttribute("aria-current")).toBe("page");
  expect(await projects.nth(1).getAttribute("data-project-identity")).toBe(firstIdentity);
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("kojo.navigator.preferences") ?? "null"),
  );
  expect(stored).toEqual({
    version: 1,
    order: [secondIdentity, firstIdentity],
    selectedProjectIdentity: secondIdentity,
  });

  await page.evaluate(
    ({ firstIdentity, secondIdentity }) => {
      window.localStorage.setItem(
        "kojo.navigator.preferences",
        JSON.stringify({
          version: 1,
          order: [secondIdentity, firstIdentity],
          selectedProjectIdentity: "malformed-project-identity",
        }),
      );
    },
    { firstIdentity, secondIdentity },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => projects.count()).toBe(2);
  expect(await projects.nth(0).getAttribute("data-project-identity")).toBe(secondIdentity);
  expect(await projects.nth(0).getAttribute("aria-current")).toBe("page");
}, 30_000);

const startFixture = async (): Promise<Fixture> => {
  const visualizerDirectory = process.cwd().endsWith("apps/visualizer")
    ? process.cwd()
    : join(process.cwd(), "apps/visualizer");
  const port = await availablePort();
  const host = await startKojoHostProcess();

  const visualizer = Bun.spawn(
    ["bun", "vite", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: visualizerDirectory,
      env: { ...process.env, KOJO_HOST_SOCKET: host.socketPath },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}`)).ok;
    } catch {
      return false;
    }
  }, visualizer);

  return {
    browser: await chromium.launch({ headless: true }),
    host,
    port,
    visualizer,
  };
};

const availablePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a browser-test port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const waitFor = async (condition: () => Promise<boolean>, processHandle: Bun.Subprocess) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    if (processHandle.exitCode !== null) {
      const stderr =
        processHandle.stderr instanceof ReadableStream
          ? await new Response(processHandle.stderr).text()
          : "";
      throw new Error(`Acceptance fixture process exited early: ${stderr}`);
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out while starting the browser acceptance fixture.");
};

const run = async (command: ReadonlyArray<string>) => {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
};
