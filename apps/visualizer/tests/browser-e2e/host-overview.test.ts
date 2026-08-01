import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { afterAll, afterEach, expect, test } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../tests/support/cli-process";
import {
  type KojoHostProcessFixture,
  startKojoHostProcess,
} from "../../../../tests/support/host-process";

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
const temporaryDirectoryCleanupTimeoutMs = 5_000;
let fixture: Fixture | undefined;
let forcedHostTeardownFallbacks = 0;
let forcedVisualizerTeardownFallbacks = 0;
let forcedBrowserTeardownFallbacks = 0;
const temporaryDirectories: Array<() => Promise<void>> = [];
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
  let failure: unknown;
  try {
    if (closingFixture !== undefined) await closeFixture(closingFixture);
  } catch (error) {
    failure = error;
  } finally {
    const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
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
  await within(
    "Project fixture page HostOverview readiness",
    page.getByText("Connected to Kojo Host 0.1.0").waitFor({ state: "visible" }),
    browserAssertionTimeoutMs,
  );
  await page.getByText("No Kojo Projects yet.").waitFor({ state: "visible" });

  expect(await page.getByText("Connected to Kojo Host 0.1.0").isVisible()).toBe(true);
  expect(await page.getByText("No Kojo Projects yet.").isVisible()).toBe(true);
  const directory = await makeTemporaryDirectory("kojo-navigator-");
  temporaryDirectories.push(() => cleanupTemporaryDirectory(directory));
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
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: browserAssertionTimeoutMs })
    .toContain(secondIdentity);
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
  await page.getByText("Explicit reveal active").waitFor({ state: "visible" });
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
  await page.getByRole("button", { name: "Enable" }).click();
  await page.getByRole("button", { name: "Disable" }).waitFor({ state: "visible" });
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
      chromium.executablePath(),
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
          }, cleanupDeadlineMs + 100);
        }),
    };
    await expect(closeBrowser(eventuallyClosingBrowser, profile.path)).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
    expect(await ownedBrowserPids(profile.path)).toEqual([]);
    expect(await browser.exited).toBeTypeOf("number");
  } finally {
    await terminateOwnedBrowser(profile.path);
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await settlesWithin(browser.exited);
    await cleanupTemporaryDirectory(profile);
  }
});

test("force-reclaims an owned browser process when both Playwright closes fail", async () => {
  const profile = await makeTemporaryDirectory("kojo-browser-profile-failed-reclaim-");
  const browser = Bun.spawn(
    [
      chromium.executablePath(),
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

    await expect(closeBrowser(failingBrowser, profile.path)).rejects.toThrow(
      "BrowserContext.close failed",
    );
    expect(owningCloseCalled).toBe(true);
    expect(await ownedBrowserPids(profile.path)).toEqual([]);
    expect(await browser.exited).toBeTypeOf("number");
  } finally {
    await terminateOwnedBrowser(profile.path);
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await settlesWithin(browser.exited);
    await cleanupTemporaryDirectory(profile);
  }
});

test("selects only Chromium processes with this fixture's exact profile argument", () => {
  const profilePath = "/private/tmp/kojo-browser-profile-[exact]";
  const browser = chromium.executablePath();
  expect(
    ownedBrowserPidsFromProcessEntries(profilePath, [
      { commandLine: `${browser} --user-data-dir=${profilePath}`, pid: 101 },
      { commandLine: `${browser} --user-data-dir=${profilePath}-near-match`, pid: 102 },
      { commandLine: `${browser} --flag=--user-data-dir=${profilePath}`, pid: 103 },
      { commandLine: `node run ${profilePath}`, pid: 104 },
      { commandLine: `node --user-data-dir=${profilePath}`, pid: 105 },
    ]),
  ).toEqual([101]);
});

test("downloads a real Artifact as an inert attachment instead of rendering it", async () => {
  fixture = await startFixture();
  const page = await within("browser page startup", fixture.browser.newPage());
  const origin = `http://127.0.0.1:${fixture.port}`;
  await page.goto(origin, {
    waitUntil: "domcontentloaded",
    timeout: fixtureStartupTimeoutMs,
  });
  await within(
    "Artifact test page HostOverview readiness",
    page.getByText("Connected to Kojo Host 0.1.0").waitFor({ state: "visible" }),
    browserAssertionTimeoutMs,
  );

  const directory = await makeTemporaryDirectory("kojo-artifact-download-browser-");
  temporaryDirectories.push(() => cleanupTemporaryDirectory(directory));
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
    const warmupPage = await browser.newPage();
    try {
      await warmupPage.goto(`http://127.0.0.1:${port}`, {
        waitUntil: "domcontentloaded",
        timeout: fixtureStartupTimeoutMs,
      });
      await warmupPage.getByText("Connected to Kojo Host 0.1.0").waitFor({
        state: "visible",
        timeout: fixtureStartupTimeoutMs,
      });
    } finally {
      await warmupPage.close();
    }

    return {
      browser,
      browserProfile,
      host,
      port,
      visualizer,
    };
  } catch (error) {
    const ownedHostProcessIds =
      host === undefined ? new Set<number>() : await collectOwnedHostProcessIds(host.processId);
    const ownedVisualizerProcessIds =
      visualizer === undefined ? new Set<number>() : await collectOwnedProcessIds([visualizer.pid]);
    const ownedBrowserProcessIds = await collectOwnedBrowserProcessIds(browserProfile.path);
    const cleanupErrors: Array<unknown> = [];
    if (browser !== undefined) {
      try {
        await closeBrowser(browser, browserProfile.path);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else {
      try {
        await terminateOwnedBrowser(browserProfile.path);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (visualizer !== undefined) {
      try {
        await stopVisualizer(visualizer);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (host !== undefined) {
      try {
        await stopHost(host, ownedHostProcessIds);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const [label, processIds] of [
      ["Chromium", ownedBrowserProcessIds],
      ["Vite/esbuild", ownedVisualizerProcessIds],
    ] as const) {
      try {
        await reapOwnedProcessIds(label, processIds);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (host !== undefined) {
      try {
        await assertHostOwnershipReaped(host, ownedHostProcessIds);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await cleanupTemporaryDirectory(browserProfile);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw withFixtureStderr(
      cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors]),
      await visualizerStderr,
    );
  }
};

const closeFixture = async (closingFixture: Fixture) => {
  const ownedHostProcessIds = await collectOwnedHostProcessIds(closingFixture.host.processId);
  const ownedVisualizerProcessIds = await collectOwnedProcessIds([closingFixture.visualizer.pid]);
  const ownedBrowserProcessIds = await collectOwnedBrowserProcessIds(
    closingFixture.browserProfile.path,
  );
  let failure: unknown;
  try {
    await closeBrowser(closingFixture.browser, closingFixture.browserProfile.path);
  } catch (error) {
    failure = error;
  }
  try {
    await stopVisualizer(closingFixture.visualizer);
  } catch (error) {
    failure ??= error;
  }
  try {
    await stopHost(closingFixture.host, ownedHostProcessIds);
  } catch (error) {
    failure ??= error;
  }
  try {
    if (await reapOwnedProcessIds("Chromium", ownedBrowserProcessIds)) {
      forcedBrowserTeardownFallbacks += 1;
    }
  } catch (error) {
    failure ??= error;
  }
  try {
    if (await reapOwnedProcessIds("Vite/esbuild", ownedVisualizerProcessIds)) {
      forcedVisualizerTeardownFallbacks += 1;
    }
  } catch (error) {
    failure ??= error;
  }
  try {
    await assertHostOwnershipReaped(closingFixture.host, ownedHostProcessIds);
    if ((await ownedBrowserPids(closingFixture.browserProfile.path)).length > 0) {
      throw new Error("Owned Chromium processes remained after bounded browser teardown.");
    }
  } catch (error) {
    failure ??= error;
  }
  try {
    await cleanupTemporaryDirectory(closingFixture.browserProfile);
  } catch (error) {
    failure ??= error;
  }
  try {
    if (await pathExists(closingFixture.browserProfile.path)) {
      throw new Error("Owned Chromium profile state remained after browser teardown.");
    }
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
};

const stopHost = async (
  host: KojoHostProcessFixture,
  capturedOwnedProcessIds?: ReadonlySet<number>,
) => {
  const ownedHostProcessIds =
    capturedOwnedProcessIds ?? (await collectOwnedHostProcessIds(host.processId));
  const gracefulStop = host.stop().then(
    () => ({ _tag: "succeeded" }) as const,
    (error) => ({ _tag: "failed", error }) as const,
  );
  const outcome = await Promise.race([
    gracefulStop,
    Bun.sleep(hostShutdownTimeoutMs).then(() => ({ _tag: "timed-out" }) as const),
  ]);
  if (outcome._tag === "succeeded") {
    try {
      await assertHostOwnershipReaped(host, ownedHostProcessIds);
      return;
    } catch (error) {
      forcedHostTeardownFallbacks += 1;
      await forceReapHostOwnership(host, ownedHostProcessIds, error);
      return;
    }
  }

  try {
    await forceReapHostOwnership(host, ownedHostProcessIds);
  } catch (error) {
    if (outcome._tag === "failed")
      throw new Error("Kojo Host graceful teardown failed.", { cause: error });
    throw error;
  }
  await Promise.race([gracefulStop, Bun.sleep(cleanupDeadlineMs)]);
  if (outcome._tag === "failed") throw outcome.error;
  forcedHostTeardownFallbacks += 1;
};

const forceReapHostOwnership = async (
  host: KojoHostProcessFixture,
  ownedProcessIds: ReadonlySet<number>,
  cause?: unknown,
) => {
  const crash = host.crash().then(
    () => ({ _tag: "succeeded" }) as const,
    (error) => ({ _tag: "failed", error }) as const,
  );
  let crashOutcome = await Promise.race([
    crash,
    Bun.sleep(cleanupDeadlineMs).then(() => ({ _tag: "timed-out" }) as const),
  ]);
  await reapOwnedProcessIds("Kojo Host", ownedProcessIds);

  if (crashOutcome._tag === "timed-out") {
    crashOutcome = await Promise.race([
      crash,
      Bun.sleep(cleanupDeadlineMs).then(() => ({ _tag: "timed-out" }) as const),
    ]);
  }
  if (crashOutcome._tag === "timed-out") {
    throw new Error("Kojo Host crash fallback did not settle within its bounded deadline.", {
      cause,
    });
  }
  if (crashOutcome._tag === "failed") throw crashOutcome.error;
  await assertHostOwnershipReaped(host, ownedProcessIds);
};

const cleanupDeadlineMs = 1_000;

const settlesWithin = async (operation: Promise<unknown>) =>
  Promise.race([
    operation.then(
      () => true,
      () => true,
    ),
    Bun.sleep(cleanupDeadlineMs).then(() => false),
  ]);

type CloseOutcome =
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "succeeded" };

type TimedCloseOutcome = CloseOutcome | { readonly _tag: "timed-out" };

const observeClose = (operation: Promise<void>): Promise<CloseOutcome> =>
  operation.then(
    () => ({ _tag: "succeeded" }) as const,
    (error) => ({ _tag: "failed", error }) as const,
  );

const closeWithin = async (operation: Promise<CloseOutcome>): Promise<TimedCloseOutcome> =>
  Promise.race([
    operation,
    Bun.sleep(cleanupDeadlineMs).then(() => ({ _tag: "timed-out" }) as const),
  ]);

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

const closePages = async (browser: Pick<BrowserContext, "pages">) => {
  const outcomes = await Promise.all(
    browser.pages().map((page) => closeWithin(observeClose(page.close()))),
  );
  const incomplete = outcomes.find((outcome) => outcome._tag !== "succeeded");
  if (incomplete !== undefined) {
    throw new Error(`A browser page close ${incomplete._tag} within its bounded deadline.`);
  }
};

const closeBrowser = async (
  browser: Pick<BrowserContext, "browser" | "close"> & Partial<Pick<BrowserContext, "pages">>,
  profilePath: string,
) => {
  let pageCloseFailure: unknown;
  if (browser.pages !== undefined) {
    try {
      await closePages({ pages: () => browser.pages?.() ?? [] });
    } catch (error) {
      pageCloseFailure = error;
    }
  }
  const contextClose = observeClose(browser.close());
  const initialContextOutcome = await closeWithin(contextClose);
  let owningBrowserClose: Promise<CloseOutcome> | undefined;
  let owningBrowserOutcome: TimedCloseOutcome | undefined;
  const owningBrowser = browser.browser();
  if (owningBrowser !== null) {
    owningBrowserClose = observeClose(owningBrowser.close());
    owningBrowserOutcome = await closeWithin(owningBrowserClose);
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
    return;
  }
  if (!(await terminateOwnedBrowser(profilePath))) {
    throw new Error(
      `${describeCloseOutcome("BrowserContext.close", initialContextOutcome)} and force-reclaiming its owned process failed.`,
      { cause: closeFailureCause(initialContextOutcome, owningBrowserOutcome) },
    );
  }
  const finalContextOutcome = await closeWithin(contextClose);
  const finalOwningBrowserOutcome =
    owningBrowserClose === undefined ? undefined : await closeWithin(owningBrowserClose);
  if (
    finalContextOutcome._tag === "succeeded" &&
    (finalOwningBrowserOutcome === undefined || finalOwningBrowserOutcome._tag === "succeeded")
  ) {
    if (pageCloseFailure !== undefined) throw pageCloseFailure;
    return;
  }
  throw new Error(
    `Browser process was reclaimed, but ${describeCloseOutcome("BrowserContext.close", finalContextOutcome)}${finalOwningBrowserOutcome === undefined ? "" : ` and ${describeCloseOutcome("Browser.close", finalOwningBrowserOutcome)}`}.`,
    { cause: closeFailureCause(finalContextOutcome, finalOwningBrowserOutcome) },
  );
};

interface ProcessEntry {
  readonly commandLine: string;
  readonly pid: number;
  readonly parentPid?: number;
}

const ownsBrowserProfile = (commandLine: string, profilePath: string) => {
  const browser = chromium.executablePath();
  const exactProfileArgument = `--user-data-dir=${profilePath}`;
  return (
    (commandLine === browser || commandLine.startsWith(`${browser} `)) &&
    new RegExp(`(?:^|\\s)${escapeRegularExpression(exactProfileArgument)}(?=$|\\s)`).test(
      commandLine,
    )
  );
};

const escapeRegularExpression = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ownedBrowserPidsFromProcessEntries = (
  profilePath: string,
  processes: ReadonlyArray<ProcessEntry>,
) =>
  processes
    .filter(({ commandLine }) => ownsBrowserProfile(commandLine, profilePath))
    .map(({ pid }) => pid);

const processEntries = async (): Promise<ReadonlyArray<ProcessEntry>> => {
  const search = Bun.spawn(["ps", "-axww", "-o", "pid=", "-o", "ppid=", "-o", "command="], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([search.exited, new Response(search.stdout).text()]);
  if (exitCode !== 0) return [];
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const pid = Number.parseInt(match[1] ?? "", 10);
    const parentPid = Number.parseInt(match[2] ?? "", 10);
    const commandLine = match[3] ?? "";
    return Number.isSafeInteger(pid) && pid > 0 ? [{ commandLine, parentPid, pid }] : [];
  });
};

const pathExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const isProcessRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const collectOwnedProcessIds = async (rootPids: ReadonlyArray<number>) => {
  const processes = await processEntries();
  const childrenByParent = new Map<number, Array<number>>();
  for (const entry of processes) {
    if (entry.parentPid === undefined) continue;
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.parentPid, children);
  }

  const owned = new Set<number>(rootPids);
  const pending = [...rootPids];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (owned.has(childPid)) continue;
      owned.add(childPid);
      pending.push(childPid);
    }
  }
  return owned;
};

const collectOwnedHostProcessIds = (rootPid: number) => collectOwnedProcessIds([rootPid]);

const collectOwnedBrowserProcessIds = async (profilePath: string) =>
  collectOwnedProcessIds(await ownedBrowserPids(profilePath));

const assertProcessIdsReaped = (label: string, ownedProcessIds: ReadonlySet<number>) => {
  const remainingProcessIds = [...ownedProcessIds].filter(isProcessRunning);
  if (remainingProcessIds.length > 0) {
    throw new Error(
      `${label} ownership remained after teardown (PIDs: ${remainingProcessIds.join(", ")}).`,
    );
  }
};

const reapOwnedProcessIds = async (
  label: string,
  ownedProcessIds: ReadonlySet<number>,
): Promise<boolean> => {
  if ([...ownedProcessIds].every((pid) => !isProcessRunning(pid))) return false;

  for (const pid of ownedProcessIds) {
    if (pid === process.pid) {
      throw new Error(`${label} ownership capture included the browser-test process.`);
    }
    if (!isProcessRunning(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ([...ownedProcessIds].every((pid) => !isProcessRunning(pid))) break;
    await Bun.sleep(25);
  }
  assertProcessIdsReaped(label, ownedProcessIds);
  return true;
};

const assertHostOwnershipReaped = async (
  host: KojoHostProcessFixture,
  ownedProcessIds: ReadonlySet<number>,
) => {
  assertProcessIdsReaped("Kojo Host", ownedProcessIds);

  const remainingStatePaths = [
    host.socketPath,
    `${host.socketPath}.lock`,
    dirname(host.socketPath),
  ];
  const stateExists = await Promise.all(remainingStatePaths.map((path) => pathExists(path)));
  const existingStatePaths = remainingStatePaths.filter((_, index) => stateExists[index]);
  if (existingStatePaths.length > 0) {
    throw new Error(
      `Kojo Host socket/store state remained after teardown: ${existingStatePaths.join(", ")}.`,
    );
  }
};

const ownedBrowserPids = async (profilePath: string) =>
  ownedBrowserPidsFromProcessEntries(profilePath, await processEntries());

const signalOwnedBrowser = async (signal: "SIGKILL" | "SIGTERM", profilePath: string) => {
  // The process snapshot already proves both the exact Chromium executable and
  // the exact fixture profile. Kill that bounded ownership set directly so a
  // per-PID `ps` probe cannot stall teardown under process contention.
  const processIds = ownedBrowserPidsFromProcessEntries(profilePath, await processEntries());
  for (const pid of processIds) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
};

/** Reclaims only Chromium processes launched with this fixture's unique profile. */
const terminateOwnedBrowser = async (profilePath: string) => {
  await signalOwnedBrowser("SIGTERM", profilePath);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await ownedBrowserPids(profilePath)).length === 0) return true;
    await Bun.sleep(25);
  }
  await signalOwnedBrowser("SIGKILL", profilePath);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await ownedBrowserPids(profilePath)).length === 0) return true;
    await Bun.sleep(25);
  }
  return (await ownedBrowserPids(profilePath)).length === 0;
};

const stopVisualizer = async (visualizer: Bun.Subprocess) => {
  if (visualizer.exitCode === null) visualizer.kill("SIGTERM");
  if (await settlesWithin(visualizer.exited)) return;
  if (visualizer.exitCode === null) visualizer.kill("SIGKILL");
  if (!(await settlesWithin(visualizer.exited))) {
    throw new Error("Visualizer teardown did not settle after SIGKILL.");
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

const cleanupTemporaryDirectory = (directory: TemporaryDirectory) =>
  within(
    `Temporary directory cleanup (${directory.path})`,
    directory.cleanup(),
    temporaryDirectoryCleanupTimeoutMs,
  );

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
