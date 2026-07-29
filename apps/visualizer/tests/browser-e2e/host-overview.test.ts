import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterEach, expect, test } from "vitest";

interface Fixture {
  readonly browser: Browser;
  readonly directory: string;
  readonly host: Bun.Subprocess;
  readonly port: number;
  readonly visualizer: Bun.Subprocess;
}

let fixture: Fixture | undefined;

afterEach(async () => {
  if (fixture === undefined) return;
  await fixture.browser.close();
  fixture.visualizer.kill("SIGTERM");
  fixture.host.kill("SIGTERM");
  await Promise.all([fixture.visualizer.exited, fixture.host.exited]);
  await rm(fixture.directory, { recursive: true });
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
  const directory = await mkdtemp(join(tmpdir(), "kojo-browser-"));
  const socketPath = join(directory, "host.sock");
  const port = await availablePort();
  const host = Bun.spawn(["bun", "run", "../host/main.ts"], {
    cwd: visualizerDirectory,
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitFor(async () => {
    try {
      await stat(socketPath);
      return true;
    } catch {
      return false;
    }
  }, host);

  const visualizer = Bun.spawn(
    ["bun", "vite", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: visualizerDirectory,
      env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
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
    directory,
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
