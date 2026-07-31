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

afterEach(async () => {
  const closingFixture = fixture;
  fixture = undefined;
  if (closingFixture !== undefined) await closeFixture(closingFixture);
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
  await page
    .getByLabel("Accepted Workflow Definitions")
    .getByText(/^echo /)
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

test("downloads a real Artifact as an inert attachment instead of rendering it", async () => {
  fixture = await within("browser fixture startup", startFixture(), 30_000);
  const page = await within("browser page startup", fixture.browser.newPage());
  const origin = `http://127.0.0.1:${fixture.port}`;
  await within("visualizer page navigation", page.goto(origin, { waitUntil: "domcontentloaded" }));

  const directory = await makeTemporaryDirectory("kojo-artifact-download-browser-");
  temporaryDirectories.push(directory.cleanup);
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

  const artifactResponse = await page.request.get(artifactUrl, { timeout: 10_000 });
  expect(artifactResponse.status()).toBe(200);
  expect(artifactResponse.headers()).toMatchObject({
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="artifact-${artifactId}.json"`,
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  expect(await artifactResponse.text()).toContain("present:");

  await page.evaluate((url) => {
    const link = document.createElement("a");
    link.dataset.artifactDownload = "";
    link.download = "";
    link.href = url;
    link.textContent = "Download Artifact";
    document.body.append(link);
  }, artifactUrl);
  const artifactLink = page.locator("[data-artifact-download]");
  const download = page.waitForEvent("download", { timeout: 10_000 });
  await artifactLink.click();
  const artifactDownload = await download;
  await artifactLink.evaluate((link) => link.remove());
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
    await stopVisualizer(visualizer);
    await host.crash();
    throw withFixtureStderr(error, await visualizerStderr);
  }
};

const closeFixture = async (closingFixture: Fixture) => {
  let failure: unknown;
  try {
    await closeBrowser(closingFixture.browser);
  } catch (error) {
    failure = error;
  }
  try {
    await stopVisualizer(closingFixture.visualizer);
  } catch (error) {
    failure ??= error;
  }
  try {
    await closingFixture.host.crash();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
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

const closeBrowser = async (browser: Browser) => {
  const closed = await Promise.race([
    browser.close().then(() => true),
    Bun.sleep(cleanupDeadlineMs).then(() => false),
  ]);
  if (!closed) throw new Error("Browser teardown did not settle after its request was cancelled.");
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
