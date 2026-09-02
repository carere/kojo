import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
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
        "docs/release-notes",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status, result.stdout || result.stderr).toBe(1);
  });

  it("keeps public guidance and package entry points on the one-Daemon release", () => {
    const root = new URL("../../../../../", import.meta.url);
    const globalPackage = manifest(new URL("packages/kojo/package.json", root));
    const runtimePackage = manifest(new URL("packages/kojo-runtime/package.json", root));
    const runtimeManifest = readFileSync(
      new URL("packages/kojo-runtime/runtime-manifest.json", root),
      "utf8",
    );
    const guidance = [
      readFileSync(new URL("README.md", root), "utf8"),
      readFileSync(new URL(".kojo/README.md", root), "utf8"),
      readFileSync(new URL("docs/design/typescript-effect.md", root), "utf8"),
      readFileSync(new URL("docs/release-notes/daemon-cutover.md", root), "utf8"),
      readFileSync(
        new URL("packages/kojo/src/contexts/scaffold/templates/support.ts", root),
        "utf8",
      ),
      readFileSync(
        new URL("packages/kojo/src/contexts/scaffold/templates/skills.ts", root),
        "utf8",
      ),
    ].join("\n");
    const releaseWorkflow = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");

    expect(globalPackage.bin).toEqual({ kojo: "./src/main.ts" });
    expect(globalPackage.files).toEqual(["console", "managed-release.json", "src"]);
    expect(runtimePackage.files).toEqual(["LICENSE", "runtime-manifest.json", "src"]);
    expect(runtimePackage.exports).toMatchObject({
      "./runner/main": "./src/runner/main.ts",
      "./validator/main": "./src/validator/main.ts",
    });
    expect(runtimeManifest).toContain('"hosts": ["darwin", "linux"]');
    expect(releaseWorkflow).toContain("complete-breaking-release-evidence");
    expect(releaseWorkflow).toContain("verify-complete");
    for (const command of [
      "kojo init",
      "kojo doctor",
      "kojo daemon install",
      "kojo project register .",
      "kojo workflow list --project <project-id>",
      "kojo workflow start <project-id>",
      "kojo run status <run-id>",
      "kojo gate list",
      "kojo gate answer <token>",
      "kojo ui",
    ]) {
      expect(guidance).toContain(command);
    }
  });
});
