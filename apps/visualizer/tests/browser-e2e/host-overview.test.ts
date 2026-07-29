import { createServer } from "node:net";
import { join } from "node:path";
import { type KojoHostProcessFixture, startKojoHostProcess } from "@kojo/test-support";
import { type Browser, chromium } from "playwright";
import { afterEach, expect, test } from "vitest";

interface Fixture {
  readonly browser: Browser;
  readonly host: KojoHostProcessFixture;
  readonly port: number;
  readonly visualizer: Bun.Subprocess;
}

let fixture: Fixture | undefined;

afterEach(async () => {
  if (fixture === undefined) return;
  await fixture.browser.close();
  fixture.visualizer.kill("SIGTERM");
  await fixture.visualizer.exited;
  await fixture.host.stop();
  fixture = undefined;
});

test("loads the authoritative empty Project state through the visualizer route and local Host", async () => {
  fixture = await startFixture();
  const page = await fixture.browser.newPage();

  await page.goto(`http://127.0.0.1:${fixture.port}`, { waitUntil: "networkidle" });

  expect(await page.getByText("Connected to Kojo Host 0.1.0").isVisible()).toBe(true);
  expect(await page.getByText("No Kojo Projects yet.").isVisible()).toBe(true);
}, 20_000);

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
