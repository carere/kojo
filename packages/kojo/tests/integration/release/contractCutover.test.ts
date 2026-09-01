import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly exports?: Readonly<Record<string, string>>;
}

const manifest = (url: URL): PackageManifest =>
  JSON.parse(readFileSync(url, "utf8")) as PackageManifest;

describe("the Daemon contract cutover", () => {
  it("leaves the global package with no authoring compatibility exports", () => {
    const globalPackage = manifest(new URL("../../../package.json", import.meta.url));
    expect(globalPackage.exports).toEqual({});
  });

  it("removes execution ownership helpers from the authoring runtime", () => {
    const runtime = manifest(
      new URL("../../../../kojo-runtime/package.json", import.meta.url),
    ).exports;
    const removed = [
      ["./contexts/workflow/ports/", "Run", "Lock"].join(""),
      ["./contexts/workflow/services/", "one", "Runner"].join(""),
      ["./contexts/gate/services/", "answer", "Gate"].join(""),
      ["./contexts/trigger/services/", "wat", "ch"].join(""),
    ];

    for (const key of removed) expect(runtime).not.toHaveProperty(key);
  });
});
