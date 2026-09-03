import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly exports?: Readonly<Record<string, string>>;
}

const manifest = (url: URL): PackageManifest =>
  JSON.parse(readFileSync(url, "utf8")) as PackageManifest;

const cutoverPaths = [
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
] as const;

const legacySpendSupportPattern = [
  ["KOJO", "AGENT", "SPEND"].join("_"),
  ["Agent", "Spend"].join(""),
  ["may", "Spawn"].join(""),
  ["stand", "in:"].join("-"),
].join("|");

const forbiddenCutoverPattern = [
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

const scanCutoverResidue = (root: string, paths: ReadonlyArray<string> = cutoverPaths) =>
  spawnSync(
    "git",
    ["grep", "--no-index", "-n", "-I", "-E", forbiddenCutoverPattern, "--", ...paths],
    { cwd: root, encoding: "utf8" },
  );

const scanLegacySpendSupport = (
  root: string,
  paths: ReadonlyArray<string> = [
    "packages/kojo/tests/support",
    "packages/kojo-runtime/tests/support",
  ],
) =>
  spawnSync(
    "git",
    ["grep", "--no-index", "-n", "-I", "-E", legacySpendSupportPattern, "--", ...paths],
    { cwd: root, encoding: "utf8" },
  );

const temporaryRoots: Array<string> = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    const root = new URL("../../../../../", import.meta.url).pathname;
    const result = scanCutoverResidue(root);
    const supportResult = scanLegacySpendSupport(root);

    expect(result.status, result.stdout || result.stderr).toBe(1);
    expect(supportResult.status, supportResult.stdout || supportResult.stderr).toBe(1);
  });

  it("uses the positional Project path in every shipped acceptance helper", () => {
    const root = new URL("../../../../../", import.meta.url);
    const macos = readFileSync(
      new URL("packages/kojo/tests/support/release/ShippedMacosEvidence.ts", root),
      "utf8",
    );
    const systemd = readFileSync(
      new URL(".github/scripts/systemd-shipped-user-evidence.sh", root),
      "utf8",
    );
    const removedRegisterFlag = ["project", "register", ["--", "path"].join("")].join(" ");

    expect(macos).toMatch(/"project",\s*"register",\s*"\."/);
    expect(systemd).toContain("project register .)");
    expect(macos).not.toContain(removedRegisterFlag);
    expect(systemd).not.toContain(removedRegisterFlag);
  });

  it("propagates every piped CI test failure before evidence collection", () => {
    const workflow = readFileSync(
      new URL("../../../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const pipedRunBlocks = [...workflow.matchAll(/run: \|\n((?: {10}.*\n)+)/g)]
      .map((match) => match[1] ?? "")
      .filter((block) => block.includes("| tee"));

    expect(pipedRunBlocks).toHaveLength(5);
    for (const block of pipedRunBlocks.slice(0, 4)) expect(block).toContain("set -o pipefail");
    expect(pipedRunBlocks[4]).toContain(["status=$", "{PIPESTATUS[0]}"].join(""));
  });

  it("fails when test support retains a legacy agent-spend policy helper", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-cutover-support-"));
    temporaryRoots.push(root);
    const support = join(root, "packages/kojo-runtime/tests/support");
    mkdirSync(support, { recursive: true });
    writeFileSync(
      join(support, "legacyAgentPolicy.ts"),
      `export const flag = ${JSON.stringify(["KOJO", "AGENT", "SPEND"].join("_"))};\n` +
        `export const policy = ${JSON.stringify(["stand", "in:/tmp/agent"].join("-"))};\n`,
    );

    const result = scanLegacySpendSupport(root, ["packages/kojo-runtime/tests/support"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("legacyAgentPolicy.ts");
    expect(result.stdout).toContain(["KOJO", "AGENT", "SPEND"].join("_"));
    expect(result.stdout).toContain(["stand", "in:/tmp/agent"].join("-"));
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
