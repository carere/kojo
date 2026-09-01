import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserSessionResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { browserSessionLifetimeMs } from "../../../../src/contexts/daemon/services/browserAuthority.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";

const roots: Array<string> = [];
const daemons: Array<RunningDaemon> = [];

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(tmpdir(), "kojo-browser-access-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const value = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(value);
  return value;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const start = (
  hostPaths: DaemonPaths,
  options: { readonly consolePort?: number; readonly now?: () => number } = {},
) => {
  const daemon = startDaemon(hostPaths, options);
  daemons.push(daemon);
  return daemon;
};

const grant = async (daemon: RunningDaemon): Promise<string> => {
  const response = await fetch("http://localhost/ui-grants", {
    method: "POST",
    unix: daemon.endpoint.socketPath,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const value = (await response.json()) as { readonly launchUrl: string };
  const launch = new URL(value.launchUrl);
  expect(launch.origin).toBe(daemon.endpoint.consoleOrigin);
  expect(launch.pathname).toBe("/daemon");
  const secret = new URLSearchParams(launch.hash.slice(1)).get("grant");
  expect(secret).not.toBeNull();
  return secret ?? "";
};

const exchange = async (
  daemon: RunningDaemon,
  secret: string,
  origin: string = daemon.endpoint.consoleOrigin,
): Promise<Response> =>
  fetch(`${daemon.endpoint.consoleOrigin}/_kojo/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ grant: secret }),
  });

describe("instance-bound browser access", () => {
  it("serves only bootstrap and active-release assets without session authority", async () => {
    const daemon = start(paths());
    const compat = await fetch(`${daemon.endpoint.consoleOrigin}/_kojo/compat`);
    expect(compat.status).toBe(200);
    expect(await compat.json()).toMatchObject({
      bootstrapVersion: 1,
      instanceId: daemon.endpoint.instanceId,
      dataIdentity: daemon.endpoint.dataIdentity,
    });

    const asset = await fetch(`${daemon.endpoint.consoleOrigin}/daemon`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("active managed Console");

    for (const path of ["/api/v1/daemon", "/api/v1/events", "/api/v1/artifacts/a/content"]) {
      const response = await fetch(`${daemon.endpoint.consoleOrigin}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("requires the exact Host, Origin, JSON body, and one-use grant", async () => {
    const daemon = start(paths());
    const port = new URL(daemon.endpoint.consoleOrigin).port;
    const wrongHost = await fetch(`http://localhost:${port}/_kojo/compat`);
    expect(wrongHost.status).toBe(421);

    const secret = await grant(daemon);
    const missingOrigin = await fetch(`${daemon.endpoint.consoleOrigin}/_kojo/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: secret }),
    });
    expect(missingOrigin.status).toBe(403);
    expect((await exchange(daemon, secret, "null")).status).toBe(403);
    expect((await exchange(daemon, secret, "http://127.0.0.1:1")).status).toBe(403);

    const wrongType = await fetch(`${daemon.endpoint.consoleOrigin}/_kojo/session`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: daemon.endpoint.consoleOrigin },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const accepted = await exchange(daemon, secret);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect((await exchange(daemon, secret)).status).toBe(401);
  });

  it("authorizes one tab session for 12 hours and rejects cross-origin mutations", async () => {
    let time = Date.UTC(2026, 8, 1, 12);
    const daemon = start(paths(), { now: () => time });
    const accepted = await exchange(daemon, await grant(daemon));
    const session = (await accepted.json()) as BrowserSessionResponse;

    const read = () =>
      fetch(`${daemon.endpoint.consoleOrigin}/api/v1/daemon`, {
        headers: { authorization: `Bearer ${session.credential}` },
      });
    const details = await read();
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      instanceId: daemon.endpoint.instanceId,
      projectCount: 0,
      releaseId: "kojo-test",
    });

    const crossOriginRead = await fetch(`${daemon.endpoint.consoleOrigin}/api/v1/daemon`, {
      headers: {
        authorization: `Bearer ${session.credential}`,
        origin: "http://127.0.0.1:1",
      },
    });
    expect(crossOriginRead.status).toBe(403);

    const missingMutationOrigin = await fetch(`${daemon.endpoint.consoleOrigin}/api/v1/unknown`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.credential}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(missingMutationOrigin.status).toBe(403);

    const invalidMutation = await fetch(`${daemon.endpoint.consoleOrigin}/api/v1/unknown`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.credential}`,
        "content-type": "application/json",
        origin: daemon.endpoint.consoleOrigin,
      },
      body: "not json",
    });
    expect(invalidMutation.status).toBe(400);

    time += browserSessionLifetimeMs;
    expect((await read()).status).toBe(401);
  });

  it("expires a grant after 60 seconds", async () => {
    let time = Date.UTC(2026, 8, 1, 12);
    const daemon = start(paths(), { now: () => time });
    const secret = await grant(daemon);
    time += 60_000;
    expect((await exchange(daemon, secret)).status).toBe(401);
  });

  it("revokes old grants and sessions when a replacement reuses the port", async () => {
    const hostPaths = paths();
    const first = start(hostPaths);
    const port = Number(new URL(first.endpoint.consoleOrigin).port);
    const oldGrant = await grant(first);
    const accepted = await exchange(first, await grant(first));
    const oldSession = (await accepted.json()) as BrowserSessionResponse;
    await Effect.runPromise(first.stop);
    daemons.splice(daemons.indexOf(first), 1);

    const replacement = start(hostPaths, { consolePort: port });
    expect(replacement.endpoint.instanceId).not.toBe(first.endpoint.instanceId);
    expect((await exchange(replacement, oldGrant)).status).toBe(401);
    const oldRead = await fetch(`${replacement.endpoint.consoleOrigin}/api/v1/daemon`, {
      headers: { authorization: `Bearer ${oldSession.credential}` },
    });
    expect(oldRead.status).toBe(401);
  });
});
