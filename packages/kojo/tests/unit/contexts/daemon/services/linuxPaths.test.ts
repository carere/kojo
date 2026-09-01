import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleError } from "../../../../../src/contexts/daemon/models/LifecycleError.ts";
import { linuxPaths } from "../../../../../src/contexts/daemon/services/linuxPaths.ts";

describe("Linux Daemon paths", () => {
  it("uses the private Kojo child of each XDG base directory", () => {
    const paths = linuxPaths(
      { runtimeRoot: "/run/user/1200/kojo" },
      {
        HOME: "/home/example",
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_STATE_HOME: "/xdg/state",
        XDG_CACHE_HOME: "/xdg/cache",
      },
    );

    expect(paths).toMatchObject({
      installationRoot: "/xdg/data/kojo",
      dataRoot: "/xdg/state/kojo",
      configurationRoot: "/xdg/config/kojo",
      cacheRoot: "/xdg/cache/kojo",
      runtimeRoot: "/run/user/1200/kojo",
      serviceDefinition: "/xdg/config/systemd/user/kojo.service",
    });
  });

  it("refuses a session with no XDG runtime directory", () => {
    const resolve = () =>
      linuxPaths({ installationRoot: "/test/installation" }, { HOME: "/home/example" });
    expect(resolve).toThrowError(LifecycleError);
    expect(resolve).toThrow("XDG_RUNTIME_DIR");
  });

  it("refuses relative XDG roots", () => {
    expect(() =>
      linuxPaths(
        { runtimeRoot: "/run/user/1200/kojo" },
        { HOME: "/home/example", XDG_STATE_HOME: "relative" },
      ),
    ).toThrow("XDG_STATE_HOME must be an absolute path");
  });

  it("refuses an XDG runtime directory that another OS user can access", () => {
    const runtime = mkdtempSync(join(tmpdir(), "kojo-xdg-runtime-"));
    chmodSync(runtime, 0o755);
    try {
      expect(() =>
        linuxPaths(
          { installationRoot: "/test/installation" },
          { HOME: "/home/example", XDG_RUNTIME_DIR: runtime },
        ),
      ).toThrow("must be a private directory");
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
