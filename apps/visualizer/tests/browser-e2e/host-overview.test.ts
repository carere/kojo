import { existsSync } from "node:fs";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, afterEach, expect, test } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../tests/support/cli-process";
import {
  type KojoHostProcessFixture,
  startKojoHostProcess,
} from "../../../../tests/support/host-process";
import { makeTeardownBudget, type TeardownBudget } from "./teardown-budget";

interface Fixture {
  readonly browser: BrowserContext;
  readonly browserProfile: TemporaryDirectory;
  readonly host: KojoHostProcessFixture;
  readonly port: number;
  readonly visualizer: Bun.Subprocess;
}

interface TemporaryDirectory {
  readonly cleanup: () => Promise<void>;
  readonly path: string;
}

const fixtureStartupTimeoutMs = 30_000;
const browserLaunchTimeoutMs = 10_000;
const browserAssertionTimeoutMs = 30_000;
const artifactDownloadTimeoutMs = 10_000;
const hostShutdownTimeoutMs = 5_000;
const processSnapshotTimeoutMs = 1_000;
let fixture: Fixture | undefined;
let forcedHostTeardownFallbacks = 0;
let forcedVisualizerTeardownFallbacks = 0;
let forcedBrowserTeardownFallbacks = 0;
const temporaryDirectories: Array<(budget: TeardownBudget) => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../packages/workflow", import.meta.url),
);
const effectPackagePath = fileURLToPath(new URL("../../node_modules/effect", import.meta.url));

const artifactDownloadConfiguration = `
import { Effect, Schema } from "effect";
import { Command, CommandFailure, CommandResult, Sandbox, defineCommand, defineConfig, defineSandbox, defineWorkflow } from "@kojo/workflow";
import { unsafeHost } from "@kojo/workflow/sandboxes/unsafe-host";

const sandbox = defineSandbox({
  sandboxKey: "local-command",
  revision: "1",
  provider: unsafeHost({ providerKey: "trusted-local", revision: "1" }),
});
const command = defineCommand({
  commandKey: "echo-environment",
  revision: "1",
  arguments: ["/bin/sh", "-lc", "printf '%s:%s' \\"$KOJO_SANDBOX_VALUE\\" \\"$PWD\\""],
  environment: { KOJO_SANDBOX_VALUE: "present" },
  workingDirectory: ".",
});

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "sandbox-command",
      revision: "1",
      inputSchema: Schema.Struct({ message: Schema.String }),
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        return yield* Command.run({ operationKey: "command", sandbox: acquired, command });
      }),
    }),
  ],
});
`;

afterAll(() => {
  console.info(
    `Fixture forced teardown fallbacks: Host=${forcedHostTeardownFallbacks}, Vite=${forcedVisualizerTeardownFallbacks}, Chromium=${forcedBrowserTeardownFallbacks}`,
  );
});

afterEach(async () => {
  const closingFixture = fixture;
  fixture = undefined;
  const cleanups = temporaryDirectories.splice(0);
  const teardownBudget = makeTeardownBudget();
  let failure: unknown;
  try {
    if (closingFixture !== undefined) await closeFixture(closingFixture, teardownBudget);
  } catch (error) {
    failure = error;
  } finally {
    const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup(teardownBudget)));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    failure ??= rejected?.reason;
  }
  if (failure !== undefined) throw failure;
});

test("loads the Host-authoritative Project state and reconciles Navigator preferences by Project Identity", async () => {
  fixture = await startFixture();
  const page = await fixture.browser.newPage();

  await page.goto(`http://127.0.0.1:${fixture.port}`, { waitUntil: "domcontentloaded" });
  await waitForHostOverviewReady(page, "Project fixture page HostOverview readiness");
  await page.getByText("No Kojo Projects yet.").waitFor({ state: "visible" });

  expect(await page.getByText("Connected to Kojo Host 0.1.0").isVisible()).toBe(true);
  expect(await page.getByText("No Kojo Projects yet.").isVisible()).toBe(true);
  const directory = await makeTemporaryDirectory("kojo-navigator-");
  temporaryDirectories.push((budget) => cleanupTemporaryDirectory(directory, budget));
  await mkdir(join(directory.path, "node_modules", "@kojo"), { recursive: true });
  await symlink(
    workflowPackagePath,
    join(directory.path, "node_modules", "@kojo", "workflow"),
    "dir",
  );
  await symlink(effectPackagePath, join(directory.path, "node_modules", "effect"), "dir");
  const firstPath = join(directory.path, "first-project");
  const secondPath = join(directory.path, "second-project");
  await run(["git", "init", firstPath]);
  await run(["git", "init", secondPath]);
  expect((await runKojoCli(["init", firstPath], fixture.host.socketPath)).exitCode).toBe(0);
  expect((await runKojoCli(["init", secondPath], fixture.host.socketPath)).exitCode).toBe(0);
  await writeFile(
    join(firstPath, "kojo.config.ts"),
    `import { defineConfig, defineWorkflow } from "@kojo/workflow";
import { Schema } from "effect";

const schema = Schema.String;
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "echo",
      revision: "1",
      inputSchema: schema,
      successSchema: schema,
      failureSchema: schema,
      schedules: [{
        scheduleKey: "morning-echo",
        workflowKey: "echo",
        cron: "0 9 * * 1-5",
        timeZone: "Europe/Paris",
        input: { revision: "input-v1", resolve: () => "scheduled" }
      }],
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
  await waitForHostOverviewReady(page, "Project fixture reload HostOverview readiness");
  const projects = page.locator('[aria-label="Kojo Projects"] button[data-project-identity]');
  await expect.poll(() => projects.count(), { timeout: browserAssertionTimeoutMs }).toBe(2);
  expect(await projects.nth(0).getAttribute("data-project-identity")).toBe(secondIdentity);
  expect(await projects.nth(0).getAttribute("aria-current")).toBe("page");
  expect(await projects.nth(1).getAttribute("data-project-identity")).toBe(firstIdentity);
  await projects.nth(1).click();
  const graphNodes = page.locator("[data-graph-node]");
  const graphNodeCountBeforeFreshStart = await graphNodes.count();
  await page.getByRole("button", { name: "Start a fresh Workflow Run", exact: true }).click();
  await page.getByLabel("Fresh Workflow Run input").fill('"from-browser"');
  await page.getByRole("button", { name: "Start fresh", exact: true }).click();
  await expect
    .poll(() => graphNodes.count(), { timeout: browserAssertionTimeoutMs })
    .toBeGreaterThan(graphNodeCountBeforeFreshStart);
  await page.getByRole("button", { name: "Review warning & reveal", exact: true }).click();
  await page.getByRole("button", { name: "Reveal this view", exact: true }).click();
  await within(
    "reveal rendering",
    page.getByText("Explicit reveal active").waitFor({ state: "visible" }),
    browserAssertionTimeoutMs,
  );
  await page
    .getByLabel("Accepted Workflow Definitions")
    .getByText("echo 1", { exact: true })
    .waitFor({ state: "visible" });
  const schedules = page.getByLabel("Workflow Schedules");
  const initialScheduleText = await schedules.innerText();
  expect(initialScheduleText).toContain("morning-echo");
  expect(initialScheduleText).toContain("Disabled · available");
  expect(initialScheduleText).toContain("echo · 0 9 * * 1-5 · Europe/Paris · allow overlap");
  expect(initialScheduleText).toContain("Next: No next occurrence");
  const enableButton = page.getByRole("button", { name: "Enable", exact: true });
  await enableButton.click();
  await within(
    "schedule enable rendering",
    page.getByRole("button", { name: "Disable" }).waitFor({ state: "visible" }),
    browserAssertionTimeoutMs,
  );
  expect(await schedules.innerText()).toContain("Enabled · available");
  await projects.nth(0).click();
  await schedules.getByText("No Workflow Schedules yet.").waitFor({ state: "visible" });
  expect(
    await page
      .getByLabel("Accepted Workflow Definitions")
      .getByText("echo 1", { exact: true })
      .count(),
  ).toBe(0);
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("kojo.navigator.preferences") ?? "null"),
  );
  expect(stored).toEqual({
    version: 1,
    order: [secondIdentity, firstIdentity],
    selectedProjectIdentity: secondIdentity,
  });

  await page.setViewportSize({ width: 900, height: 720 });
  expect(
    await page.getByRole("separator", { name: "Resize Project resource navigator" }).isVisible(),
  ).toBe(false);
  expect(
    await page.getByRole("complementary", { name: "Project resource navigator" }).isVisible(),
  ).toBe(true);
  expect(await page.getByRole("complementary", { name: "Run inspection panel" }).isVisible()).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 720 });

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

test("force-reclaims an owned browser process when bounded shutdown misses its deadline", async () => {
  const profile = await makeTemporaryDirectory("kojo-browser-profile-reclaim-");
  const browser = Bun.spawn(
    [
      headlessBrowserExecutablePath(),
      "--headless",
      "--no-default-browser-check",
      "--no-first-run",
      `--user-data-dir=${profile.path}`,
      "about:blank",
    ],
    { stderr: "ignore", stdout: "ignore" },
  );
  try {
    await waitFor(async () => (await ownedBrowserPids(profile.path)).length > 0, browser);

    let closeSettled = false;
    const eventuallyClosingBrowser: Pick<BrowserContext, "browser" | "close"> = {
      browser: () => null,
      close: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            closeSettled = true;
            resolve();
          }, processSnapshotTimeoutMs + 100);
        }),
    };
    await expect(
      closeBrowser(eventuallyClosingBrowser, profile.path, makeTeardownBudget()),
    ).resolves.toEqual({ gone: true, forced: true });
    expect(closeSettled).toBe(true);
    expect(await ownedBrowserPids(profile.path)).toEqual([]);
    expect(await browser.exited).toBeTypeOf("number");
  } finally {
    await terminateOwnedBrowser(profile.path, makeTeardownBudget());
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await browser.exited;
    await cleanupTemporaryDirectory(profile, makeTeardownBudget());
  }
});

test("force-reclaims an owned browser process when both Playwright closes fail", async () => {
  const profile = await makeTemporaryDirectory("kojo-browser-profile-failed-reclaim-");
  const browser = Bun.spawn(
    [
      headlessBrowserExecutablePath(),
      "--headless",
      "--no-default-browser-check",
      "--no-first-run",
      `--user-data-dir=${profile.path}`,
      "about:blank",
    ],
    { stderr: "ignore", stdout: "ignore" },
  );
  try {
    await waitFor(async () => (await ownedBrowserPids(profile.path)).length > 0, browser);
    let owningCloseCalled = false;
    const failingBrowser: Pick<BrowserContext, "browser" | "close"> = {
      browser: () =>
        ({
          close: () => {
            owningCloseCalled = true;
            return Promise.reject(new Error("Owning Browser close failed."));
          },
        }) as Browser,
      close: () => Promise.reject(new Error("Browser context close failed.")),
    };

    await expect(closeBrowser(failingBrowser, profile.path, makeTeardownBudget())).resolves.toEqual(
      { gone: true, forced: true },
    );
    expect(owningCloseCalled).toBe(true);
    expect(await ownedBrowserPids(profile.path)).toEqual([]);
    expect(await browser.exited).toBeTypeOf("number");
  } finally {
    await terminateOwnedBrowser(profile.path, makeTeardownBudget());
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await browser.exited;
    await cleanupTemporaryDirectory(profile, makeTeardownBudget());
  }
});

test("does not count a force reclaim when Browser.close removes Chromium after context timeout", async () => {
  const profile = await makeTemporaryDirectory("kojo-browser-profile-already-gone-");
  const browser = Bun.spawn(
    [
      headlessBrowserExecutablePath(),
      "--headless",
      "--no-default-browser-check",
      "--no-first-run",
      `--user-data-dir=${profile.path}`,
      "about:blank",
    ],
    { stderr: "ignore", stdout: "ignore" },
  );
  try {
    await waitFor(async () => (await ownedBrowserPids(profile.path)).length > 0, browser);
    const playwrightBrowser: Pick<BrowserContext, "browser" | "close"> = {
      browser: () =>
        ({
          close: async () => {
            if (browser.exitCode === null) browser.kill("SIGTERM");
            await browser.exited;
          },
        }) as Browser,
      close: () => Bun.sleep(processSnapshotTimeoutMs + 100),
    };

    await expect(
      closeBrowser(playwrightBrowser, profile.path, makeTeardownBudget()),
    ).resolves.toEqual({ gone: true, forced: false });
    expect(await ownedBrowserPids(profile.path)).toEqual([]);
    expect(await browser.exited).toBeTypeOf("number");
  } finally {
    await terminateOwnedBrowser(profile.path, makeTeardownBudget());
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await browser.exited;
    await cleanupTemporaryDirectory(profile, makeTeardownBudget());
  }
});

test("selects only Chromium processes with this fixture's exact profile argument", () => {
  const profilePath = "/private/tmp/kojo-browser-profile-[exact]";
  const browser = headlessBrowserExecutablePath();
  const chromiumExecutable = chromium.executablePath();
  const alternateBrowser =
    browser === chromiumExecutable
      ? join(dirname(browser), "chrome-headless-shell")
      : chromiumExecutable;
  const supportedBrowserEntries = browserExecutablePaths().includes(alternateBrowser)
    ? [{ commandLine: `${alternateBrowser} --user-data-dir=${profilePath}`, pid: 106 }]
    : [];
  expect(
    ownedBrowserPidsFromProcessEntries(profilePath, [
      { commandLine: `${browser} --user-data-dir=${profilePath}`, pid: 101 },
      ...supportedBrowserEntries,
      { commandLine: `${browser} --user-data-dir=${profilePath}-near-match`, pid: 102 },
      { commandLine: `${browser} --flag=--user-data-dir=${profilePath}`, pid: 103 },
      { commandLine: `node run ${profilePath}`, pid: 104 },
      { commandLine: `node --user-data-dir=${profilePath}`, pid: 105 },
    ]),
  ).toEqual([101, ...supportedBrowserEntries.map(({ pid }) => pid)]);
});

test("does not retain a PID after its process identity is reused", () => {
  const snapshot = new Map<number, ProcessEntry>([
    [
      101,
      {
        commandLine: "/owned/host --socket=/private/tmp/kojo.sock",
        pid: 101,
        startTime: "Sat Aug  1 05:00:00 2026",
      },
    ],
  ]);
  const reusedEntry: ProcessEntry = {
    commandLine: "/unrelated/process --socket=/private/tmp/other.sock",
    pid: 101,
    startTime: "Sat Aug  1 05:01:00 2026",
  };

  expect(revalidatedProcessEntries(snapshot, [reusedEntry])).toEqual([]);
});

test("does not report an empty browser ownership set as reclaimed", async () => {
  await expect(
    terminateOwnedBrowser(
      "/private/tmp/kojo-browser-profile-without-a-process",
      makeTeardownBudget(),
    ),
  ).resolves.toBe(false);
});

test("downloads a real Artifact as an inert attachment instead of rendering it", async () => {
  fixture = await startFixture();
  const page = await within("browser page startup", fixture.browser.newPage());
  const origin = `http://127.0.0.1:${fixture.port}`;
  await page.goto(origin, {
    waitUntil: "domcontentloaded",
    timeout: fixtureStartupTimeoutMs,
  });
  await waitForHostOverviewReady(page, "Artifact test page HostOverview readiness");

  const directory = await makeTemporaryDirectory("kojo-artifact-download-browser-");
  temporaryDirectories.push((budget) => cleanupTemporaryDirectory(directory, budget));
  await mkdir(join(directory.path, "node_modules", "@kojo"), { recursive: true });
  await symlink(
    workflowPackagePath,
    join(directory.path, "node_modules", "@kojo", "workflow"),
    "dir",
  );
  await symlink(effectPackagePath, join(directory.path, "node_modules", "effect"), "dir");
  const project = join(directory.path, "project");
  await run(["git", "init", project]);
  await run([
    "git",
    "-C",
    project,
    "-c",
    "user.name=Kojo Test",
    "-c",
    "user.email=kojo@example.test",
    "commit",
    "--allow-empty",
    "--message",
    "initial",
  ]);
  await writeFile(join(project, "kojo.config.ts"), artifactDownloadConfiguration);
  expect(
    (
      await within(
        "Artifact project initialization",
        runKojoCli(["init", project], fixture.host.socketPath),
      )
    ).exitCode,
  ).toBe(0);

  const started = await within(
    "Artifact Workflow Run start",
    runKojoCli(
      ["run", "start", "sandbox-command", "--input", '{"message":"download"}', "--json"],
      fixture.host.socketPath,
      project,
    ),
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  let artifactId: string | undefined;
  await within(
    "Artifact record",
    (async () => {
      for (let attempt = 0; attempt < 100 && artifactId === undefined; attempt += 1) {
        const shown = await within(
          "Artifact Workflow Run inspection",
          runKojoCli(["run", "show", runId, "--json"], fixture.host.socketPath, project),
        );
        if (shown.exitCode === 0) {
          const run = JSON.parse(shown.stdout).result.run as {
            readonly sandboxTrace?: ReadonlyArray<{
              readonly artifactIds?: ReadonlyArray<string>;
              readonly kind?: string;
            }>;
          };
          artifactId = run.sandboxTrace?.find((entry) => entry.kind === "command.completed")
            ?.artifactIds?.[0];
        }
        if (artifactId === undefined) await Bun.sleep(50);
      }
    })(),
    15_000,
  );
  expect(artifactId).toEqual(expect.any(String));
  if (artifactId === undefined) throw new Error("The browser fixture did not record an Artifact.");
  const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
    .projectIdentity as string;
  const artifactUrl = `${origin}/api/artifacts?artifact=${artifactId}&project=${identity}&run=${runId}`;

  const artifactResponse = await page.request.get(artifactUrl, {
    timeout: artifactDownloadTimeoutMs,
  });
  expect(artifactResponse.status()).toBe(200);
  expect(artifactResponse.headers()).toMatchObject({
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="artifact-${artifactId}.json"`,
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  expect(await artifactResponse.text()).toContain("present:");

  // The page loaded before the CLI created the Project and Workflow Run. Refresh the
  // Host-authoritative overview before exercising the real download control.
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForHostOverviewReady(page, "Artifact reload HostOverview readiness");
  const runButton = page.getByRole("button", { name: runId, exact: true });
  await runButton.waitFor({ state: "visible", timeout: browserAssertionTimeoutMs });
  await runButton.click();
  const artifactLink = page.getByRole("link", { name: `Download Artifact ${artifactId}` }).last();
  await artifactLink.waitFor({ state: "visible", timeout: browserAssertionTimeoutMs });
  const artifactDownloadControl = await within(
    "Artifact download control handle",
    artifactLink.elementHandle(),
  );
  if (artifactDownloadControl === null) throw new Error("Artifact download control disappeared.");
  const [artifactDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: artifactDownloadTimeoutMs }),
    artifactDownloadControl.click({
      noWaitAfter: true,
      timeout: artifactDownloadTimeoutMs,
    }),
  ]);
  const downloadPath = await artifactDownload.path();
  expect(downloadPath).not.toBeNull();
  if (downloadPath !== null) expect(await readFile(downloadPath, "utf8")).toContain("present:");
  expect(artifactDownload.suggestedFilename()).toBe(`artifact-${artifactId}.json`);
  expect(await artifactDownload.failure()).toBeNull();
  expect(page.url()).not.toBe(artifactUrl);
  expect(await page.locator("body").innerText()).not.toContain("present:");
}, 60_000);

const startFixture = async (): Promise<Fixture> => {
  const visualizerDirectory = process.cwd().endsWith("apps/visualizer")
    ? process.cwd()
    : join(process.cwd(), "apps/visualizer");
  const port = await availablePort();
  const browserProfile = await makeTemporaryDirectory("kojo-browser-profile-");
  let host: KojoHostProcessFixture | undefined;
  let visualizer: Bun.Subprocess | undefined;
  let browser: BrowserContext | undefined;
  let visualizerStderr: Promise<string> = Promise.resolve("");
  try {
    host = await startKojoHostProcess();
    const hostProcess = host;
    visualizer = Bun.spawn(
      ["bun", "vite", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: visualizerDirectory,
        env: { ...process.env, KOJO_HOST_SOCKET: hostProcess.socketPath },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    visualizerStderr = readStderr(visualizer);
    await waitFor(async () => {
      try {
        const origin = `http://127.0.0.1:${port}`;
        const page = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
        return page.ok;
      } catch {
        return false;
      }
    }, visualizer);

    browser = await chromium.launchPersistentContext(browserProfile.path, {
      headless: true,
      timeout: browserLaunchTimeoutMs,
    });

    return {
      browser,
      browserProfile,
      host,
      port,
      visualizer,
    };
  } catch (error) {
    const budget = makeTeardownBudget();
    const ownedHostProcessSnapshot = new Map<number, ProcessEntry>();
    const ownedVisualizerProcessSnapshot = new Map<number, ProcessEntry>();
    const ownedBrowserProcessSnapshot = new Map<number, ProcessEntry>();
    const cleanupErrors: Array<unknown> = [];
    const capture = async (
      label: string,
      target: Map<number, ProcessEntry>,
      snapshot: () => Promise<ProcessSnapshot>,
    ) => {
      try {
        mergeProcessSnapshots(target, await snapshot());
      } catch (captureError) {
        cleanupErrors.push(
          new Error(`${label} ownership capture failed.`, { cause: captureError }),
        );
      }
    };
    await capture("Chromium", ownedBrowserProcessSnapshot, () =>
      collectOwnedBrowserProcessSnapshot(browserProfile.path, budget),
    );
    if (browser !== undefined) {
      try {
        const browserTeardown = await closeBrowser(browser, browserProfile.path, budget);
        if (browserTeardown.forced) {
          forcedBrowserTeardownFallbacks += 1;
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else {
      try {
        if (await terminateOwnedBrowser(browserProfile.path, budget)) {
          forcedBrowserTeardownFallbacks += 1;
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    await capture("Chromium after startup browser cleanup", ownedBrowserProcessSnapshot, () =>
      collectOwnedBrowserProcessSnapshot(browserProfile.path, budget),
    );
    if (visualizer !== undefined) {
      const visualizerProcess = visualizer;
      await capture("Vite/esbuild", ownedVisualizerProcessSnapshot, () =>
        collectOwnedProcessSnapshot([visualizerProcess.pid], budget),
      );
      try {
        await stopVisualizer(visualizerProcess, budget);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      await capture("Vite/esbuild after startup shutdown", ownedVisualizerProcessSnapshot, () =>
        collectOwnedProcessSnapshot([visualizerProcess.pid], budget),
      );
    }
    if (host !== undefined) {
      const hostProcess = host;
      await capture("Kojo Host", ownedHostProcessSnapshot, () =>
        collectOwnedHostProcessSnapshot(hostProcess.processId, budget),
      );
      try {
        await stopHost(hostProcess, ownedHostProcessSnapshot, budget);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      await capture("Kojo Host after startup shutdown", ownedHostProcessSnapshot, () =>
        collectOwnedHostProcessSnapshot(hostProcess.processId, budget),
      );
    }
    for (const [label, processIds] of [
      ["Chromium", ownedBrowserProcessSnapshot],
      ["Vite/esbuild", ownedVisualizerProcessSnapshot],
    ] as const) {
      try {
        if (await reapOwnedProcessSnapshot(label, processIds, budget)) {
          if (label === "Chromium") forcedBrowserTeardownFallbacks += 1;
          else forcedVisualizerTeardownFallbacks += 1;
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      const remainingBrowserPids = await ownedBrowserPids(browserProfile.path, budget);
      if (remainingBrowserPids.length > 0) {
        if (await terminateOwnedBrowser(browserProfile.path, budget)) {
          forcedBrowserTeardownFallbacks += 1;
        }
        if ((await ownedBrowserPids(browserProfile.path, budget)).length > 0) {
          throw new Error("Owned Chromium processes remained after startup cleanup.");
        }
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (host !== undefined) {
      try {
        await assertHostOwnershipReaped(host, ownedHostProcessSnapshot, budget);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await cleanupTemporaryDirectory(browserProfile, budget);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    let stderr = "";
    try {
      stderr = await budget.run("Visualizer stderr collection", () => visualizerStderr);
    } catch (stderrError) {
      cleanupErrors.push(stderrError);
    }
    throw withFixtureStderr(
      cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors]),
      stderr,
    );
  }
};

const closeFixture = async (closingFixture: Fixture, budget: TeardownBudget) => {
  const ownedHostProcessSnapshot = new Map<number, ProcessEntry>();
  const ownedVisualizerProcessSnapshot = new Map<number, ProcessEntry>();
  const ownedBrowserProcessSnapshot = new Map<number, ProcessEntry>();
  const cleanupErrors: Array<unknown> = [];
  const record = (error: unknown) => cleanupErrors.push(error);
  const capture = async (
    label: string,
    target: Map<number, ProcessEntry>,
    snapshot: () => Promise<ProcessSnapshot>,
  ) => {
    try {
      mergeProcessSnapshots(target, await snapshot());
    } catch (captureError) {
      record(new Error(`${label} ownership capture failed.`, { cause: captureError }));
    }
  };

  await capture("Chromium", ownedBrowserProcessSnapshot, () =>
    collectOwnedBrowserProcessSnapshot(closingFixture.browserProfile.path, budget),
  );
  try {
    const browserTeardown = await closeBrowser(
      closingFixture.browser,
      closingFixture.browserProfile.path,
      budget,
    );
    if (browserTeardown.forced) {
      forcedBrowserTeardownFallbacks += 1;
    }
  } catch (error) {
    record(error);
  }
  await capture("Chromium after Browser close", ownedBrowserProcessSnapshot, () =>
    collectOwnedBrowserProcessSnapshot(closingFixture.browserProfile.path, budget),
  );

  await capture("Vite/esbuild", ownedVisualizerProcessSnapshot, () =>
    collectOwnedProcessSnapshot([closingFixture.visualizer.pid], budget),
  );
  try {
    await stopVisualizer(closingFixture.visualizer, budget);
  } catch (error) {
    record(error);
  }
  await capture("Vite/esbuild after shutdown", ownedVisualizerProcessSnapshot, () =>
    collectOwnedProcessSnapshot([closingFixture.visualizer.pid], budget),
  );

  // Visualizer shutdown closes the child-creation window before Host ownership
  // is captured, so the Host snapshot includes the complete remaining tree.
  await capture("Kojo Host", ownedHostProcessSnapshot, () =>
    collectOwnedHostProcessSnapshot(closingFixture.host.processId, budget),
  );
  try {
    await stopHost(closingFixture.host, ownedHostProcessSnapshot, budget);
  } catch (error) {
    record(error);
  }
  await capture("Kojo Host after shutdown", ownedHostProcessSnapshot, () =>
    collectOwnedHostProcessSnapshot(closingFixture.host.processId, budget),
  );

  try {
    if (await reapOwnedProcessSnapshot("Chromium", ownedBrowserProcessSnapshot, budget)) {
      forcedBrowserTeardownFallbacks += 1;
    }
  } catch (error) {
    record(error);
  }
  try {
    if (await reapOwnedProcessSnapshot("Vite/esbuild", ownedVisualizerProcessSnapshot, budget)) {
      forcedVisualizerTeardownFallbacks += 1;
    }
  } catch (error) {
    record(error);
  }
  try {
    const remainingBrowserPids = await ownedBrowserPids(closingFixture.browserProfile.path, budget);
    if (remainingBrowserPids.length > 0) {
      if (await terminateOwnedBrowser(closingFixture.browserProfile.path, budget)) {
        forcedBrowserTeardownFallbacks += 1;
      }
      if ((await ownedBrowserPids(closingFixture.browserProfile.path, budget)).length > 0) {
        throw new Error("Owned Chromium processes remained after bounded browser teardown.");
      }
    }
  } catch (error) {
    record(error);
  }
  try {
    await assertHostOwnershipReaped(closingFixture.host, ownedHostProcessSnapshot, budget);
  } catch (error) {
    record(error);
  }
  try {
    await cleanupTemporaryDirectory(closingFixture.browserProfile, budget);
  } catch (error) {
    record(error);
  }
  try {
    if (
      await budget.run("Chromium profile postcondition", () =>
        pathExists(closingFixture.browserProfile.path),
      )
    ) {
      throw new Error("Owned Chromium profile state remained after browser teardown.");
    }
  } catch (error) {
    record(error);
  }
  if (cleanupErrors.length > 0) {
    throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors);
  }
};

type CloseOutcome =
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "succeeded" };

type TimedCloseOutcome = CloseOutcome | { readonly _tag: "timed-out"; readonly error?: unknown };

const observeClose = (operation: Promise<void>): Promise<CloseOutcome> =>
  operation.then(
    () => ({ _tag: "succeeded" }) as const,
    (error) => ({ _tag: "failed", error }) as const,
  );

const describeCloseOutcome = (
  owner: "Browser.close" | "BrowserContext.close",
  outcome: TimedCloseOutcome,
) => `${owner} ${outcome._tag}`;

const closeFailureCause = (...outcomes: ReadonlyArray<TimedCloseOutcome | undefined>) =>
  outcomes.find(
    (outcome): outcome is Extract<CloseOutcome, { readonly _tag: "failed" }> =>
      outcome?._tag === "failed",
  )?.error;

const isAlreadyClosedError = (error: unknown) =>
  error instanceof Error && /closed|disconnected/i.test(error.message);

const closeWithinBudget = (
  budget: TeardownBudget,
  label: string,
  operation: () => Promise<void>,
  limitMs = processSnapshotTimeoutMs,
): Promise<TimedCloseOutcome> =>
  budget
    .run(label, () => observeClose(operation()), limitMs)
    .catch(
      (error) =>
        ({
          _tag: "timed-out",
          error,
        }) as const,
    );

const closePages = async (browser: Pick<BrowserContext, "pages">, budget: TeardownBudget) => {
  const pages = await budget.run(
    "BrowserContext.pages",
    () => Promise.resolve().then(() => browser.pages()),
    processSnapshotTimeoutMs,
  );
  const outcomes = await Promise.all(
    pages.map((page) =>
      closeWithinBudget(budget, "Browser page close", () =>
        Promise.resolve().then(() => page.close()),
      ),
    ),
  );
  const incomplete = outcomes.find((outcome) => outcome._tag !== "succeeded");
  if (incomplete !== undefined) {
    throw new Error(`A browser page close ${incomplete._tag} within its bounded deadline.`);
  }
};

const closeBrowser = async (
  browser: Pick<BrowserContext, "browser" | "close"> & Partial<Pick<BrowserContext, "pages">>,
  profilePath: string,
  budget: TeardownBudget,
): Promise<{ readonly gone: boolean; readonly forced: boolean }> => {
  let pageCloseFailure: unknown;
  if (browser.pages !== undefined) {
    try {
      await closePages({ pages: () => browser.pages?.() ?? [] }, budget);
    } catch (error) {
      pageCloseFailure = error;
    }
  }
  let contextClosePromise: Promise<void> | undefined;
  const contextClose = () => {
    contextClosePromise ??= Promise.resolve().then(() => browser.close());
    return contextClosePromise;
  };
  const initialContextOutcome = await closeWithinBudget(
    budget,
    "BrowserContext.close",
    contextClose,
  );
  let owningBrowserOutcome: TimedCloseOutcome | undefined;
  let owningBrowser: Browser | null = null;
  try {
    owningBrowser = browser.browser();
  } catch (error) {
    owningBrowserOutcome = { _tag: "failed", error };
  }
  if (owningBrowser !== null) {
    const browserToClose = owningBrowser;
    let owningBrowserClosePromise: Promise<void> | undefined;
    const owningBrowserClose = () => {
      owningBrowserClosePromise ??= Promise.resolve().then(() => browserToClose.close());
      return owningBrowserClosePromise;
    };
    owningBrowserOutcome = await closeWithinBudget(budget, "Browser.close", owningBrowserClose);
    if (
      owningBrowserOutcome._tag === "failed" &&
      isAlreadyClosedError(owningBrowserOutcome.error)
    ) {
      owningBrowserOutcome = { _tag: "succeeded" };
    }
  }
  if (
    initialContextOutcome._tag === "succeeded" &&
    (owningBrowserOutcome === undefined || owningBrowserOutcome._tag === "succeeded")
  ) {
    if (pageCloseFailure !== undefined) throw pageCloseFailure;
    return { gone: true, forced: false };
  }
  const ownedBeforeReclaim = await ownedBrowserPids(profilePath, budget);
  if (ownedBeforeReclaim.length === 0) {
    if (pageCloseFailure !== undefined) throw pageCloseFailure;
    return { gone: true, forced: false };
  }
  const reclaimed = await terminateOwnedBrowser(profilePath, budget);
  const remainingOwnedBrowserPids = await ownedBrowserPids(profilePath, budget);
  if (remainingOwnedBrowserPids.length > 0) {
    throw new Error(
      `${describeCloseOutcome("BrowserContext.close", initialContextOutcome)} and force-reclaiming its owned process failed.`,
      { cause: closeFailureCause(initialContextOutcome, owningBrowserOutcome) },
    );
  }
  if (pageCloseFailure !== undefined) throw pageCloseFailure;
  return { gone: true, forced: reclaimed };
};

const stopHost = async (
  host: KojoHostProcessFixture,
  ownedProcessSnapshot: ProcessSnapshot,
  budget: TeardownBudget,
) => {
  const gracefulOutcome = await closeWithinBudget(
    budget,
    "Kojo Host graceful teardown",
    () => host.stop(),
    hostShutdownTimeoutMs,
  );
  if (gracefulOutcome._tag === "succeeded") {
    try {
      await assertHostOwnershipReaped(host, ownedProcessSnapshot, budget);
      return;
    } catch (error) {
      forcedHostTeardownFallbacks += 1;
      await forceReapHostOwnership(host, ownedProcessSnapshot, budget, error);
      return;
    }
  }

  try {
    forcedHostTeardownFallbacks += 1;
    await forceReapHostOwnership(host, ownedProcessSnapshot, budget, gracefulOutcome);
  } catch (error) {
    if (gracefulOutcome._tag === "failed") {
      throw new Error("Kojo Host graceful teardown failed.", { cause: error });
    }
    throw error;
  }
  if (gracefulOutcome._tag === "failed") throw gracefulOutcome.error;
};

const forceReapHostOwnership = async (
  host: KojoHostProcessFixture,
  ownedProcessSnapshot: ProcessSnapshot,
  budget: TeardownBudget,
  cause?: unknown,
) => {
  const crashOutcome = await closeWithinBudget(
    budget,
    "Kojo Host crash fallback",
    () => host.crash(),
    hostShutdownTimeoutMs,
  );
  let reapError: unknown;
  try {
    await reapOwnedProcessSnapshot("Kojo Host", ownedProcessSnapshot, budget);
  } catch (error) {
    reapError = error;
  }
  if (reapError !== undefined) {
    throw new Error("Kojo Host ownership was not reaped.", { cause: reapError });
  }
  if (crashOutcome._tag === "timed-out") {
    throw new Error("Kojo Host crash fallback did not settle within its shared deadline.", {
      cause,
    });
  }
  if (crashOutcome._tag === "failed") throw crashOutcome.error;
  await assertHostOwnershipReaped(host, ownedProcessSnapshot, budget);
};

const stopVisualizer = async (visualizer: Bun.Subprocess, budget: TeardownBudget) => {
  if (visualizer.exitCode === null) visualizer.kill("SIGTERM");
  try {
    await budget.run(
      "Visualizer graceful teardown",
      () => visualizer.exited,
      processSnapshotTimeoutMs,
    );
    return;
  } catch (error) {
    if (visualizer.exitCode === null) visualizer.kill("SIGKILL");
    await budget
      .run("Visualizer forced teardown", () => visualizer.exited, processSnapshotTimeoutMs)
      .catch(() => {
        throw error;
      });
  }
};

interface ProcessEntry {
  readonly commandLine: string;
  readonly pid: number;
  readonly parentPid?: number;
  readonly startTime?: string;
}

type ProcessSnapshot = ReadonlyMap<number, ProcessEntry>;

const escapeRegularExpression = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const browserExecutablePaths = () => {
  const chromiumExecutable = chromium.executablePath();
  const headlessShell = join(dirname(chromiumExecutable), "chrome-headless-shell");
  return [...new Set([chromiumExecutable, ...(existsSync(headlessShell) ? [headlessShell] : [])])];
};

const headlessBrowserExecutablePath = () => {
  const executablePaths = browserExecutablePaths();
  return (
    executablePaths.find((path) => path.endsWith("chrome-headless-shell")) ?? executablePaths[0]
  );
};

const ownsBrowserProfile = (commandLine: string, profilePath: string) => {
  const exactProfileArgument = `--user-data-dir=${profilePath}`;
  return (
    browserExecutablePaths().some(
      (browser) => commandLine === browser || commandLine.startsWith(`${browser} `),
    ) &&
    new RegExp(`(?:^|\\s)${escapeRegularExpression(exactProfileArgument)}(?=$|\\s)`).test(
      commandLine,
    )
  );
};

const ownedBrowserPidsFromProcessEntries = (
  profilePath: string,
  processes: ReadonlyArray<ProcessEntry>,
) =>
  processes
    .filter(({ commandLine }) => ownsBrowserProfile(commandLine, profilePath))
    .map(({ pid }) => pid);

const processEntries = async (budget?: TeardownBudget): Promise<ReadonlyArray<ProcessEntry>> => {
  const timeoutMs = Math.min(
    processSnapshotTimeoutMs,
    budget?.remainingMs() ?? processSnapshotTimeoutMs,
  );
  if (timeoutMs <= 0) throw new Error("Process ownership snapshot exceeded its shared deadline.");
  const search = Bun.spawn(
    ["ps", "-axww", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "command="],
    {
      stderr: "ignore",
      stdout: "pipe",
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      Promise.all([search.exited, new Response(search.stdout).text()]).then(
        ([exitCode, stdout]) => ({ _tag: "completed" as const, exitCode, stdout }),
        (error) => ({ _tag: "failed" as const, error }),
      ),
      new Promise<{ readonly _tag: "timed-out" }>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve({ _tag: "timed-out" });
        }, timeoutMs);
      }),
    ]);
    if (result._tag === "timed-out") {
      throw new Error("Process ownership snapshot exceeded its bounded deadline.");
    }
    if (result._tag === "failed") throw result.error;
    if (result.exitCode !== 0) throw new Error("Process ownership snapshot exited unsuccessfully.");
    const stdout = result.stdout;
    return stdout.split("\n").flatMap((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+((?:\w{3}\s+){2}\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(
          line,
        );
      if (match === null) return [];
      const pid = Number.parseInt(match[1] ?? "", 10);
      const parentPid = Number.parseInt(match[2] ?? "", 10);
      const startTime = match[3];
      const commandLine = match[4] ?? "";
      return Number.isSafeInteger(pid) && pid > 0
        ? [{ commandLine, parentPid, pid, startTime }]
        : [];
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (timedOut && search.exitCode === null) search.kill("SIGKILL");
  }
};

const pathExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const processSnapshotForRoots = (
  processes: ReadonlyArray<ProcessEntry>,
  rootPids: ReadonlyArray<number>,
): Map<number, ProcessEntry> => {
  const entriesByPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const childrenByParent = new Map<number, Array<number>>();
  for (const entry of processes) {
    if (entry.parentPid === undefined) continue;
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.parentPid, children);
  }

  const owned = new Map<number, ProcessEntry>();
  const pending = [...rootPids];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    const parent = entriesByPid.get(parentPid);
    if (parent !== undefined) owned.set(parent.pid, parent);
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (owned.has(childPid)) continue;
      pending.push(childPid);
    }
  }
  return owned;
};

const collectOwnedProcessSnapshot = async (
  rootPids: ReadonlyArray<number>,
  budget?: TeardownBudget,
): Promise<ProcessSnapshot> => processSnapshotForRoots(await processEntries(budget), rootPids);

const collectOwnedHostProcessSnapshot = (rootPid: number, budget?: TeardownBudget) =>
  collectOwnedProcessSnapshot([rootPid], budget);

const collectOwnedBrowserProcessSnapshot = async (
  profilePath: string,
  budget?: TeardownBudget,
): Promise<ProcessSnapshot> => {
  const processes = await processEntries(budget);
  const rootPids = ownedBrowserPidsFromProcessEntries(profilePath, processes);
  return processSnapshotForRoots(processes, rootPids);
};

const mergeProcessSnapshots = (target: Map<number, ProcessEntry>, source: ProcessSnapshot) => {
  for (const [pid, entry] of source) target.set(pid, entry);
};

const sameProcessIdentity = (captured: ProcessEntry, current: ProcessEntry) =>
  captured.commandLine === current.commandLine &&
  (captured.startTime === undefined || captured.startTime === current.startTime);

const revalidatedProcessEntries = (
  snapshot: ProcessSnapshot,
  currentEntries: ReadonlyArray<ProcessEntry>,
  predicate: (entry: ProcessEntry) => boolean = () => true,
) => {
  const currentByPid = new Map(currentEntries.map((entry) => [entry.pid, entry]));
  return [...snapshot.values()].filter((captured) => {
    const current = currentByPid.get(captured.pid);
    return current !== undefined && sameProcessIdentity(captured, current) && predicate(current);
  });
};

const currentSnapshotEntries = async (
  snapshot: ProcessSnapshot,
  budget: TeardownBudget,
  predicate: (entry: ProcessEntry) => boolean = () => true,
) => {
  return revalidatedProcessEntries(snapshot, await processEntries(budget), predicate);
};

const assertProcessSnapshotReaped = async (
  label: string,
  snapshot: ProcessSnapshot,
  budget: TeardownBudget,
  predicate?: (entry: ProcessEntry) => boolean,
) => {
  const remainingEntries = await currentSnapshotEntries(snapshot, budget, predicate);
  if (remainingEntries.length > 0) {
    throw new Error(
      `${label} ownership remained after teardown (PIDs: ${remainingEntries.map(({ pid }) => pid).join(", ")}).`,
    );
  }
};

const signalOwnedProcessSnapshot = async (
  label: string,
  snapshot: ProcessSnapshot,
  signal: "SIGKILL" | "SIGTERM",
  budget: TeardownBudget,
  predicate?: (entry: ProcessEntry) => boolean,
): Promise<number> => {
  const currentEntries = await currentSnapshotEntries(snapshot, budget, predicate);
  let signaled = 0;
  for (const { pid } of currentEntries) {
    if (pid === process.pid) {
      throw new Error(`${label} ownership capture included the browser-test process.`);
    }
    try {
      process.kill(pid, signal);
      signaled += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return signaled;
};

const reapOwnedProcessSnapshot = async (
  label: string,
  snapshot: ProcessSnapshot,
  budget: TeardownBudget,
  predicate?: (entry: ProcessEntry) => boolean,
): Promise<boolean> => {
  if (snapshot.size === 0) return false;
  const signaled = await signalOwnedProcessSnapshot(label, snapshot, "SIGKILL", budget, predicate);
  if (signaled === 0) return false;
  for (;;) {
    if ((await currentSnapshotEntries(snapshot, budget, predicate)).length === 0) return true;
    if (budget.remainingMs() <= 25) break;
    await budget.sleep(`${label} reap polling`, 25);
  }
  throw new Error(`${label} ownership remained after bounded reaping.`);
};

const assertHostOwnershipReaped = async (
  host: KojoHostProcessFixture,
  ownedProcessSnapshot: ProcessSnapshot,
  budget: TeardownBudget,
) => {
  await assertProcessSnapshotReaped("Kojo Host", ownedProcessSnapshot, budget);
  const currentHostEntry = (await processEntries(budget)).find(({ pid }) => pid === host.processId);
  if (ownedProcessSnapshot.size === 0 && currentHostEntry !== undefined) {
    throw new Error("Kojo Host ownership was not captured before teardown.");
  }

  const remainingStatePaths = [
    host.socketPath,
    `${host.socketPath}.lock`,
    dirname(host.socketPath),
  ];
  const stateExists = await budget.run("Kojo Host socket/store state check", () =>
    Promise.all(remainingStatePaths.map((path) => pathExists(path))),
  );
  const existingStatePaths = remainingStatePaths.filter((_, index) => stateExists[index]);
  if (existingStatePaths.length > 0) {
    throw new Error(
      `Kojo Host socket/store state remained after teardown: ${existingStatePaths.join(", ")}.`,
    );
  }
};

const ownedBrowserPids = async (profilePath: string, budget?: TeardownBudget) =>
  ownedBrowserPidsFromProcessEntries(profilePath, await processEntries(budget));

const signalOwnedBrowser = async (
  signal: "SIGKILL" | "SIGTERM",
  profilePath: string,
  budget: TeardownBudget,
) => {
  const processes = await processEntries(budget);
  const ownedEntries = processes.filter(({ commandLine }) =>
    ownsBrowserProfile(commandLine, profilePath),
  );
  let signaled = 0;
  for (const { pid, commandLine } of ownedEntries) {
    if (pid === process.pid) {
      throw new Error("Chromium ownership capture included the browser-test process.");
    }
    // This is the immediate pre-signal identity check: only the freshly observed
    // exact executable/profile command line is eligible for the signal.
    if (!ownsBrowserProfile(commandLine, profilePath)) continue;
    try {
      process.kill(pid, signal);
      signaled += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return signaled;
};

const waitForNoOwnedBrowser = async (profilePath: string, budget: TeardownBudget) => {
  for (;;) {
    if ((await ownedBrowserPids(profilePath, budget)).length === 0) return true;
    if (budget.remainingMs() <= 25) return false;
    await budget.sleep("Chromium reap polling", 25);
  }
};

/** Reclaims only Chromium processes launched with this fixture's unique profile. */
const terminateOwnedBrowser = async (
  profilePath: string,
  budget: TeardownBudget,
): Promise<boolean> => {
  const termSignaled = await signalOwnedBrowser("SIGTERM", profilePath, budget);
  if (termSignaled === 0) return false;
  if (await waitForNoOwnedBrowser(profilePath, budget)) return true;
  const killSignaled = await signalOwnedBrowser("SIGKILL", profilePath, budget);
  if (killSignaled === 0) return false;
  return await waitForNoOwnedBrowser(profilePath, budget);
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

const within = async <Value>(label: string, operation: Promise<Value>, timeoutMs = 10_000) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const waitForHostOverviewReady = async (page: Page, label: string) => {
  const connected = page.getByText("Connected to Kojo Host 0.1.0");
  const alert = page.getByRole("alert");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      connected
        .waitFor({ state: "visible", timeout: browserAssertionTimeoutMs })
        .then(() => "connected" as const),
      alert
        .waitFor({ state: "visible", timeout: browserAssertionTimeoutMs })
        .then(() => "alert" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), browserAssertionTimeoutMs);
      }),
    ]);
    if (result === "connected") return;
    const body = await page.locator("body").innerText({ timeout: 1_000 });
    if (result === "alert") {
      throw new Error(`${label} reported a HostOverview error. Body: ${body}`);
    }
    throw new Error(`${label} timed out before Connected. Body: ${body}`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const cleanupTemporaryDirectory = (directory: TemporaryDirectory, budget: TeardownBudget) =>
  budget.run(`Temporary directory cleanup (${directory.path})`, () => directory.cleanup());

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
