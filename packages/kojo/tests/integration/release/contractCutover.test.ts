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

const namedWorkflowStep = (workflow: string, name: string): string => {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`workflow step '${name}' is missing`);
  const step = workflow.slice(start);
  const boundary = /\n(?: {6}- name:| {2}\S)/.exec(step);
  return step.slice(0, boundary?.index ?? step.length);
};

const namedWorkflowJob = (workflow: string, name: string): string => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`workflow job '${name}' is missing`);
  const job = workflow.slice(start);
  const boundary = /\n {2}[a-zA-Z0-9_-]+:\n/.exec(job.slice(marker.length));
  return job.slice(0, boundary === null ? job.length : marker.length + boundary.index);
};

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

  it("uses the positional Project path in every shipped or generated guidance file", () => {
    const root = new URL("../../../../../", import.meta.url);
    const removedRegisterFlag = ["project", "register", ["--", "path"].join("")].join(" ");
    const guidance = [
      { path: "README.md", positional: /kojo project register \./ },
      { path: ".agents/skills/SKILL.md", positional: /kojo project register \./ },
      { path: ".kojo/README.md", positional: /kojo project register \./ },
      {
        path: ".github/scripts/systemd-shipped-user-evidence.sh",
        positional: /project register \.\)/,
      },
      {
        path: "packages/kojo/tests/support/release/ShippedMacosEvidence.ts",
        positional: /"project",\s*"register",\s*"\."/,
      },
      {
        path: "packages/kojo/src/contexts/scaffold/templates/support.ts",
        positional: /kojo project register \./,
      },
      {
        path: "packages/kojo/src/contexts/scaffold/templates/skills.ts",
        positional: /kojo project register \./,
      },
      {
        path: "packages/kojo/src/contexts/scaffold/adapters/InitCommand.ts",
        positional: /kojo project register \./,
      },
    ] as const;

    for (const file of guidance) {
      const content = readFileSync(new URL(file.path, root), "utf8");
      expect(content, `${file.path} must show the positional Project path`).toMatch(
        file.positional,
      );
      expect(content, `${file.path} must not show the removed --path alias`).not.toContain(
        removedRegisterFlag,
      );
    }
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

  it("uploads the hidden core release evidence from its exact collection path", () => {
    const workflow = readFileSync(
      new URL("../../../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const upload = namedWorkflowStep(workflow, "Upload core release evidence");

    expect(upload).toContain("uses: actions/upload-artifact@");
    expect(upload).toContain("path: .release-evidence\n");
    expect(upload).toContain("include-hidden-files: true\n");
  });

  it("uploads the hidden complete release evidence from its exact accepted path", () => {
    const workflow = readFileSync(
      new URL("../../../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const upload = namedWorkflowStep(workflow, "Upload complete breaking release evidence");

    expect(upload).toContain("uses: actions/upload-artifact@");
    expect(upload).toContain("path: .release-evidence-output/artifacts/verification/daemon\n");
    expect(upload).toContain("include-hidden-files: true\n");
  });

  it("installs locked dependencies before it accepts complete release evidence", () => {
    const workflow = readFileSync(
      new URL("../../../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const job = namedWorkflowJob(workflow, "complete-release-evidence");
    const installName = "Install locked dependencies for evidence aggregation";
    const install = namedWorkflowStep(job, installName);

    expect(install).toContain("run: bun install --frozen-lockfile\n");
    expect(job.indexOf(`      - name: ${installName}\n`)).toBeLessThan(
      job.indexOf("      - name: Accept the complete breaking release evidence\n"),
    );
  });

  it("keeps Moon on the exact Bun version pinned for release evidence", () => {
    const root = new URL("../../../../../", import.meta.url);
    const protoTools = readFileSync(new URL(".prototools", root), "utf8");
    const moonToolchains = readFileSync(new URL(".moon/toolchains.yml", root), "utf8");
    const pinnedBun = /^bun = "([^"]+)"$/m.exec(protoTools)?.[1];
    const moonBun = /^bun:\n {2}version: "?([^"\n]+)"?$/m.exec(moonToolchains)?.[1];

    expect(pinnedBun).toMatch(/^\d+\.\d+\.\d+$/);
    expect(moonBun).toBe(pinnedBun);
  });

  it("installs the exact repository tool pins for both Linux Host evidence jobs", () => {
    const workflow = readFileSync(
      new URL("../../../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    for (const name of ["native-systemd-host", "shipped-systemd-release"]) {
      const job = namedWorkflowJob(workflow, name);
      expect(job).toContain("pinned_bun=$(sed -n");
      expect(job).toContain("pinned_moon=$(sed -n");
      expect(job).toContain(".prototools)");
      expect(job).toContain('bun_binary="$HOME/.proto/tools/bun/$pinned_bun/bun"');
      expect(job).toContain('moon_binary="$HOME/.proto/tools/moon/$pinned_moon/moon"');
      expect(job).toContain('test -x "$bun_binary"');
      expect(job).toContain('test -x "$moon_binary"');
      expect(job).toContain('test "$("$bun_binary" --version)" = "$pinned_bun"');
      expect(job).toContain('test "$("$moon_binary" --version)" = "moon $pinned_moon"');
      expect(job).not.toContain('bun_binary=$(find "$HOME/.proto/tools/bun"');
      expect(job).not.toContain('moon_binary=$(find "$HOME/.proto/tools/moon"');
    }
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
