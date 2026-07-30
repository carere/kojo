import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const fixtureStartupTimeoutMs = 30_000;
const browserAssertionTimeoutMs = 30_000;
let fixture: Fixture | undefined;
const temporaryDirectories: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../packages/workflow", import.meta.url),
);

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
  await mkdir(join(directory.path, "node_modules", "@kojo"), { recursive: true });
  await symlink(
    workflowPackagePath,
    join(directory.path, "node_modules", "@kojo", "workflow"),
    "dir",
  );
  const firstPath = join(directory.path, "first-project");
  const secondPath = join(directory.path, "second-project");
  await run(["git", "init", firstPath]);
  await run(["git", "init", secondPath]);
  expect((await runKojoCli(["init", firstPath], fixture.host.socketPath)).exitCode).toBe(0);
  expect((await runKojoCli(["init", secondPath], fixture.host.socketPath)).exitCode).toBe(0);
  await writeFile(
    join(firstPath, "kojo.config.ts"),
    `import { defineConfig, defineWorkflow } from "@kojo/workflow";

const schema = { ast: { _tag: "StringKeyword" } };
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "echo",
      revision: "1",
      inputSchema: schema,
      successSchema: schema,
      failureSchema: schema,
      handler: () => ({})
    })
  ]
});
`,
  );
  const listed = await runKojoCli(["project", "list", "--json"], fixture.host.socketPath);
  expect(JSON.parse(listed.stdout).result.items).toHaveLength(2);
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
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: browserAssertionTimeoutMs })
    .toContain(secondIdentity);
  await page.getByText("echo").waitFor({ state: "visible" });
  const projects = page.getByRole("navigation", { name: "Kojo Projects" }).getByRole("button");
  await expect.poll(() => projects.count(), { timeout: browserAssertionTimeoutMs }).toBe(2);

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
  await expect.poll(() => projects.count(), { timeout: browserAssertionTimeoutMs }).toBe(2);
  expect(await projects.nth(0).getAttribute("data-project-identity")).toBe(secondIdentity);
  expect(await projects.nth(0).getAttribute("aria-current")).toBe("page");
}, 60_000);

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
  const visualizerStderr = readStderr(visualizer);

  try {
    await waitFor(async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
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
  } catch (error) {
    if (visualizer.exitCode === null) visualizer.kill("SIGTERM");
    await visualizer.exited;
    await host.stop();
    throw withFixtureStderr(error, await visualizerStderr);
  }
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
  const deadline = Date.now() + fixtureStartupTimeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return;
    if (processHandle.exitCode !== null) {
      throw new Error("Acceptance fixture process exited before becoming ready.");
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out while starting the browser acceptance fixture.");
};

const readStderr = (processHandle: Bun.Subprocess) =>
  processHandle.stderr instanceof ReadableStream
    ? new Response(processHandle.stderr).text()
    : Promise.resolve("");

const withFixtureStderr = (error: unknown, stderr: string) => {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = stderr.trim();

  return new Error(
    diagnostic.length === 0 ? message : `${message}\nVisualizer stderr:\n${diagnostic}`,
    { cause: error },
  );
};

const run = async (command: ReadonlyArray<string>) => {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
};
