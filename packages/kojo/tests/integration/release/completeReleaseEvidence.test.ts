import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EvidenceTier,
  requiredReleaseChecks,
} from "../../support/release/CompleteReleaseEvidence.ts";

const roots: Array<string> = [];
const revision = "a".repeat(40);
const repository = new URL("../../../../../", import.meta.url).pathname;

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
};

const loaded = (tier: EvidenceTier) => {
  const tests = [
    ...new Map(
      requiredReleaseChecks
        .flatMap((check) => check.observations)
        .filter((observation) => observation.tier === tier)
        .map((observation) => [`${observation.path}\0${observation.name}`, observation]),
    ).values(),
  ].map((observation) => ({ ...observation, status: "passed" as const }));
  return {
    tier,
    testedRevision: revision,
    environment: { os: "controlled", architecture: "arm64", bun: "1.4.0", moon: "2.5.0" },
    loaded: tests.length,
    passed: tests.length,
    skipped: 0,
    namedSkips: [],
    cacheHit: false,
    log: `${tier}.log`,
    tests,
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the complete breaking release evidence executable", () => {
  it("joins core, native systemd, shipped systemd, and shipped macOS evidence by revision", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-complete-release-"));
    roots.push(root);
    const input = join(root, "input");
    const output = join(root, "output");
    writeJson(join(input, "core", "core-evidence.json"), {
      testedRevision: revision,
      cache: "bypassed-by-moon-force",
      tiers: {
        "contract-runtime": loaded("contract-runtime"),
        "kojo-unit": loaded("kojo-unit"),
        "kojo-integration": loaded("kojo-integration"),
        "console-browser": loaded("console-browser"),
      },
      safetyRegression: {
        expected: "protected check fails for injected regression",
        actual: "failed-as-expected",
        check: "deliberate Promise leak",
        log: "kojo-integration.log",
        exitCode: 1,
        diagnostic: "deliberateLeak.d.ts:1",
      },
    });
    mkdirSync(join(input, "native-systemd"), { recursive: true });
    writeFileSync(
      join(input, "native-systemd", "host-facts.log"),
      [
        "OS=controlled Linux",
        "Architecture=x86_64",
        "Kernel=controlled",
        "Bun=1.4.0",
        "Moon=2.5.0",
        `TestedRevision=${revision}`,
        "HostTests=1 passed, 1 skipped, 2 loaded",
        "NamedSkip=the native macOS Daemon lifecycle",
      ].join("\n"),
    );
    writeFileSync(
      join(input, "native-systemd", "host-tests.log"),
      [
        " ✓ packages/kojo/tests/host/contexts/daemon/service.test.ts > uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
        " ↓ packages/kojo/tests/host/contexts/daemon/service.test.ts > the native macOS Daemon lifecycle",
        " Tests  1 passed | 1 skipped (2)",
      ].join("\n"),
    );
    writeJson(join(input, "shipped-systemd", "evidence.json"), {
      testedRevision: revision,
      environment: {
        os: "controlled Linux",
        architecture: "x86_64",
        bun: "1.4.0",
        moon: "2.5.0",
      },
      loadedTests: [
        { loaded: 2, passed: 1, skipped: 1, namedSkips: ["macOS Host test"] },
        { loaded: 1, passed: 1, skipped: 0, namedSkips: [] },
      ],
      noHiddenRepairs: { actual: true },
      checks: [
        { name: "printed-fresh-install", expected: "fresh", actual: "passed", evidence: "log" },
        { name: "real-daemon-records", expected: "records", actual: "passed", evidence: "log" },
        {
          name: "global-tool-independence",
          expected: "managed",
          actual: "passed",
          evidence: "log",
        },
        {
          name: "replacement-and-access",
          expected: "replacement",
          actual: "passed",
          evidence: "log",
        },
        { name: "shipped-managed-content", expected: "managed", actual: "passed", evidence: "log" },
      ],
    });
    for (const checkId of ["RELEASE-01", "RELEASE-02", "RELEASE-03"]) {
      const name =
        checkId === "RELEASE-01"
          ? "fresh shipped install"
          : checkId === "RELEASE-02"
            ? "real persisted records"
            : "managed tools after global removal";
      const actual =
        checkId === "RELEASE-01"
          ? "installed"
          : checkId === "RELEASE-02"
            ? "rendered through authenticated Console"
            : "usable";
      writeJson(join(input, "shipped-macos", revision, checkId, "evidence-manifest.json"), {
        checkId,
        testedRevision: revision,
        environment: {
          os: "controlled macOS",
          architecture: "arm64",
          bun: "1.4.0",
          moon: "2.5.0",
        },
        loadedTests: [{ loaded: 1, passed: 1, skipped: 0, namedSkips: [] }],
        noHiddenRepairs: true,
        checks: [
          { name, expected: "required", actual, evidence: "record" },
          ...(checkId === "RELEASE-01"
            ? [
                {
                  name: "native lifecycle",
                  expected: "required",
                  actual: "recorded",
                  evidence: "record",
                },
              ]
            : []),
        ],
      });
    }

    const result = Bun.spawnSync(
      ["bun", ".github/scripts/complete-release-evidence.ts", "complete", input, output, revision],
      { cwd: repository },
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const index = JSON.parse(
      readFileSync(
        join(
          output,
          "artifacts",
          "verification",
          "daemon",
          revision,
          "complete-release-evidence.json",
        ),
        "utf8",
      ),
    ) as { readonly acceptedChecks: number };
    expect(index.acceptedChecks).toBe(56);
    expect(
      JSON.parse(
        readFileSync(
          join(
            output,
            "artifacts",
            "verification",
            "daemon",
            revision,
            "RELEASE-04",
            "evidence.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ checkId: "RELEASE-04", actual: "passed" });

    const verified = Bun.spawnSync(
      [
        "bun",
        ".github/scripts/complete-release-evidence.ts",
        "verify-complete",
        join(output, "artifacts", "verification", "daemon"),
        revision,
      ],
      { cwd: repository },
    );
    expect(verified.exitCode, verified.stderr.toString()).toBe(0);
  });
});
