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
const repositoryBun = /^bun = "(\d+\.\d+\.\d+)"$/m.exec(
  readFileSync(join(repository, ".prototools"), "utf8"),
)?.[1];
if (repositoryBun === undefined) throw new Error("the test repository has no exact Bun pin");
const repositoryMoon = /^moon = "(\d+\.\d+\.\d+)"$/m.exec(
  readFileSync(join(repository, ".prototools"), "utf8"),
)?.[1];
if (repositoryMoon === undefined) throw new Error("the test repository has no exact Moon pin");
const recordedMoon = `moon ${repositoryMoon}`;

interface CompleteIndex {
  readonly acceptedChecks: number;
  readonly records: ReadonlyArray<{
    readonly checkId: string;
    readonly evidence: ReadonlyArray<{
      readonly tier: EvidenceTier;
      readonly log: string;
      readonly tests: ReadonlyArray<{ readonly path: string; readonly name: string }>;
    }>;
  }>;
}

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
    environment: {
      os: "controlled",
      architecture: "arm64",
      bun: repositoryBun,
      moon: recordedMoon,
    },
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
        `Bun=${repositoryBun}`,
        `Moon=${recordedMoon}`,
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
        bun: repositoryBun,
        moon: recordedMoon,
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
          bun: repositoryBun,
          moon: recordedMoon,
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
    ) as CompleteIndex;
    expect(index.acceptedChecks).toBe(56);
    for (const required of requiredReleaseChecks) {
      for (const observation of required.observations.filter(
        (candidate) => candidate.tier === "shipped-macos",
      )) {
        const record = index.records.find((candidate) => candidate.checkId === required.checkId);
        const receipt = record?.evidence.find(
          (candidate) =>
            candidate.tier === "shipped-macos" &&
            candidate.tests.some(
              (test) => test.path === observation.path && test.name === observation.name,
            ),
        );
        expect(receipt?.log, `${required.checkId} > ${observation.name}`).toBe(
          `shipped-macos/${revision}/${observation.path}`,
        );
      }
    }
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

    const completeWith = (name: string) =>
      Bun.spawnSync(
        [
          "bun",
          ".github/scripts/complete-release-evidence.ts",
          "complete",
          input,
          join(root, name),
          revision,
        ],
        { cwd: repository },
      );
    const nativeFactsPath = join(input, "native-systemd", "host-facts.log");
    const nativeFacts = readFileSync(nativeFactsPath, "utf8");
    writeFileSync(nativeFactsPath, nativeFacts.replace(`Bun=${repositoryBun}`, "Bun=9.9.9"));
    const nativeDrift = completeWith("native-drift");
    expect(nativeDrift.exitCode).not.toBe(0);
    expect(nativeDrift.stderr.toString()).toContain(
      `native-systemd recorded Bun 9.9.9, not repository pin ${repositoryBun}`,
    );
    writeFileSync(nativeFactsPath, nativeFacts);
    writeFileSync(nativeFactsPath, nativeFacts.replace(`Moon=${recordedMoon}`, "Moon=moon 9.9.9"));
    const nativeMoonDrift = completeWith("native-moon-drift");
    expect(nativeMoonDrift.exitCode).not.toBe(0);
    expect(nativeMoonDrift.stderr.toString()).toContain(
      `native-systemd recorded Moon moon 9.9.9, not repository pin ${repositoryMoon}`,
    );
    writeFileSync(nativeFactsPath, nativeFacts);

    const systemdPath = join(input, "shipped-systemd", "evidence.json");
    const systemd = JSON.parse(readFileSync(systemdPath, "utf8")) as {
      readonly environment: Readonly<Record<string, string>>;
    } & Readonly<Record<string, unknown>>;
    writeJson(systemdPath, { ...systemd, environment: { ...systemd.environment, bun: "9.9.9" } });
    const systemdDrift = completeWith("systemd-drift");
    expect(systemdDrift.exitCode).not.toBe(0);
    expect(systemdDrift.stderr.toString()).toContain(
      `shipped-systemd recorded Bun 9.9.9, not repository pin ${repositoryBun}`,
    );
    writeJson(systemdPath, systemd);
    writeJson(systemdPath, {
      ...systemd,
      environment: { ...systemd.environment, moon: "moon 9.9.9" },
    });
    const systemdMoonDrift = completeWith("systemd-moon-drift");
    expect(systemdMoonDrift.exitCode).not.toBe(0);
    expect(systemdMoonDrift.stderr.toString()).toContain(
      `shipped-systemd recorded Moon moon 9.9.9, not repository pin ${repositoryMoon}`,
    );
    writeJson(systemdPath, systemd);

    const macPath = join(input, "shipped-macos", revision, "RELEASE-02", "evidence-manifest.json");
    const mac = JSON.parse(readFileSync(macPath, "utf8")) as {
      readonly environment: Readonly<Record<string, string>>;
    } & Readonly<Record<string, unknown>>;
    writeJson(macPath, { ...mac, environment: { ...mac.environment, bun: "9.9.9" } });
    const macDrift = completeWith("mac-drift");
    expect(macDrift.exitCode).not.toBe(0);
    expect(macDrift.stderr.toString()).toContain(
      `shipped-macos recorded Bun 9.9.9, not repository pin ${repositoryBun}`,
    );
    writeJson(macPath, mac);
    writeJson(macPath, { ...mac, environment: { ...mac.environment, moon: "moon 9.9.9" } });
    const macMoonDrift = completeWith("mac-moon-drift");
    expect(macMoonDrift.exitCode).not.toBe(0);
    expect(macMoonDrift.stderr.toString()).toContain(
      `shipped-macos recorded Moon moon 9.9.9, not repository pin ${repositoryMoon}`,
    );
  });
});
