import { spawnSync } from "node:child_process";
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

  it("ships no legacy execution path or client fallback", () => {
    const forbidden = [
      ["KOJO", "AGENT", "SPEND"].join("_"),
      ["Agent", "Spend"].join(""),
      ["may", "Spawn"].join(""),
      ["no", "terminal", "on", "stdin"].join(" "),
      ["guard", "is", "not", "relying"].join(" "),
      ["@carere/kojo", "contexts"].join("/"),
      ["File", "Run", "Lock"].join(""),
      ["Single", "Node", "Engine"].join(""),
      ["engine", "Package"].join(""),
      ["default", "Database"].join(""),
      ["--", "data", "base"].join(""),
      ["kojo", "watch"].join(" "),
      ["kojo run", "<workflow>"].join(" "),
      ["/api", "health"].join("/"),
      ["/api", "runs"].join("/"),
      ["/api", "gates"].join("/"),
      ["answer", "Gate"].join(""),
      ["one", "Runner"].join(""),
      ["Terminal", "Gate"].join(""),
      ["Recording", "Gate"].join(""),
      ["run", "Own", "Paths"].join(""),
      [".kojo", "data"].join("/"),
      ["skip", "image"].join("-"),
    ].join("|");
    const root = new URL("../../../../../", import.meta.url).pathname;
    const result = spawnSync(
      "git",
      [
        "grep",
        "-n",
        "-I",
        "-E",
        forbidden,
        "--",
        "README.md",
        ".agents",
        ".kojo",
        ".github/workflows",
        "apps/console/src",
        "apps/console/vite.config.ts",
        "packages/kojo/src",
        "packages/kojo/package.json",
        "packages/kojo-runtime/src",
        "packages/kojo-runtime/package.json",
        "docs/adr",
        "docs/design",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status, result.stdout || result.stderr).toBe(1);
  });
});
