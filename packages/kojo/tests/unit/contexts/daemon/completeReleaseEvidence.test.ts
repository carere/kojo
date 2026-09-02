import { describe, expect, it } from "vitest";
import {
  type CompleteEvidenceInput,
  completeReleaseEvidence,
  type EvidenceTier,
  type LoadedTestEvidence,
  loadedTestsFromLog,
  requiredReleaseChecks,
} from "../../../support/release/CompleteReleaseEvidence.ts";

const revision = "a".repeat(40);
const tierNames: ReadonlyArray<EvidenceTier> = [
  "contract-runtime",
  "kojo-unit",
  "kojo-integration",
  "console-browser",
  "native-systemd",
  "shipped-systemd",
  "shipped-macos",
];

const tier = (name: EvidenceTier): LoadedTestEvidence => ({
  tier: name,
  testedRevision: revision,
  environment: { os: "controlled", architecture: "arm64", bun: "1.4.0", moon: "2.5.0" },
  loaded: requiredReleaseChecks
    .flatMap((check) => check.observations)
    .filter((item) => item.tier === name).length,
  passed: requiredReleaseChecks
    .flatMap((check) => check.observations)
    .filter((item) => item.tier === name).length,
  skipped: 0,
  namedSkips: [],
  cacheHit: false,
  log: `${name}.log`,
  tests: [
    ...new Map(
      requiredReleaseChecks
        .flatMap((check) => check.observations)
        .filter((item) => item.tier === name)
        .map((item) => [`${item.path}\0${item.name}`, item]),
    ).values(),
  ].map((item) => ({ path: item.path, name: item.name, status: "passed" as const })),
});

const input = (): CompleteEvidenceInput => ({
  testedRevision: revision,
  tiers: Object.fromEntries(tierNames.map((name) => [name, tier(name)])) as Readonly<
    Record<EvidenceTier, LoadedTestEvidence>
  >,
  safetyRegression: {
    expected: "protected check fails for injected regression",
    actual: "failed-as-expected",
    check: "the promise-free build check",
    log: "kojo-integration.log",
    exitCode: 1,
    diagnostic: "deliberateLeak.d.ts:1",
  },
});

describe("complete breaking release evidence", () => {
  it("creates one accepted revision-bound record for every spec #64 check", () => {
    const result = completeReleaseEvidence(input());

    expect(result.requiredChecks).toBe(56);
    expect(result.acceptedChecks).toBe(56);
    expect(new Set(result.records.map((record) => record.checkId)).size).toBe(56);
    expect(result.records.map((record) => record.checkId)).toEqual(
      requiredReleaseChecks.map((required) => required.checkId),
    );
    expect(result.supportedHosts).toEqual(["darwin", "linux-systemd"]);
  });

  it.each([
    ["cache hit", { cacheHit: true }, "used a cache hit"],
    ["zero tests", { loaded: 0, passed: 0, skipped: 0, namedSkips: [] }, "loaded zero tests"],
    [
      "all skipped tests",
      { loaded: 1, passed: 0, skipped: 1, namedSkips: ["unsupported Host"] },
      "passed zero tests",
    ],
    [
      "unnamed skip",
      { loaded: 2, passed: 1, skipped: 1, namedSkips: [] },
      "does not name every skip",
    ],
    ["wrong revision", { testedRevision: "b".repeat(40) }, "tested"],
  ])("refuses %s", (_name, change, diagnostic) => {
    const subject = input();
    const changed = {
      ...subject,
      tiers: { ...subject.tiers, "kojo-integration": { ...tier("kojo-integration"), ...change } },
    };

    expect(() => completeReleaseEvidence(changed)).toThrow(diagnostic);
  });

  it("refuses a missing supported-Host result", () => {
    const subject = input();
    const tiers = { ...subject.tiers, "shipped-macos": undefined };

    expect(() => completeReleaseEvidence({ ...subject, tiers })).toThrow(
      "has no shipped-macos evidence",
    );
  });

  it("refuses release acceptance without a protected safety regression result", () => {
    const subject = input();

    expect(() =>
      completeReleaseEvidence({
        ...subject,
        safetyRegression: { ...subject.safetyRegression, actual: "not-detected" as never },
      }),
    ).toThrow("protected safety check did not detect");
  });

  it("refuses a missing or skipped named required observation", () => {
    const subject = input();
    const integration = subject.tiers["kojo-integration"] as LoadedTestEvidence;
    const required = requiredReleaseChecks.find((check) => check.checkId === "STATE-02");
    const named = required?.observations[0];
    expect(named).toBeDefined();
    const without = integration.tests.filter((test) => test.name !== named?.name);
    expect(() =>
      completeReleaseEvidence({
        ...subject,
        tiers: { ...subject.tiers, "kojo-integration": { ...integration, tests: without } },
      }),
    ).toThrow("did not load named observation");
    const skipped = integration.tests.map((test) =>
      test.name === named?.name ? { ...test, status: "skipped" as const } : test,
    );
    expect(() =>
      completeReleaseEvidence({
        ...subject,
        tiers: { ...subject.tiers, "kojo-integration": { ...integration, tests: skipped } },
      }),
    ).toThrow("did not pass");
  });

  it("refuses a broad substring or a missing required tier observation", () => {
    const subject = input();
    const unit = subject.tiers["kojo-unit"] as LoadedTestEvidence;
    const required = requiredReleaseChecks.find((check) => check.checkId === "STATE-01");
    const named = required?.observations.find((observation) => observation.tier === "kojo-unit");
    expect(named).toBeDefined();
    const broad = unit.tests.map((test) =>
      test.path === named?.path && test.name === named.name
        ? { ...test, name: `${test.name} with removed required behavior` }
        : test,
    );
    expect(() =>
      completeReleaseEvidence({
        ...subject,
        tiers: { ...subject.tiers, "kojo-unit": { ...unit, tests: broad } },
      }),
    ).toThrow("did not load named observation");

    for (const check of requiredReleaseChecks) {
      expect(new Set(check.observations.map((observation) => observation.tier))).toEqual(
        new Set(check.tiers),
      );
    }
  });
});

describe("loaded release tests", () => {
  it("counts each Vitest task and names every skip", () => {
    const result = loadedTestsFromLog(
      "contract-runtime",
      revision,
      { os: "linux" },
      "contract.log",
      [
        " ✓ tests/unit/example.test.ts > current passing behavior 2ms",
        " ↓ tests/unit/example.test.ts > current skipped behavior",
        " Tests  2 passed | 1 skipped (3)",
        " ✓ tests/unit/example.test.ts > another passing behavior 1ms",
        " ✓ tests/unit/example.test.ts > third passing behavior 1ms",
        " ✓ tests/unit/example.test.ts > fourth passing behavior 1ms",
        " ✓ tests/unit/example.test.ts > fifth passing behavior 1ms",
        " Tests  4 passed (4)",
      ].join("\n"),
    );

    expect(result).toMatchObject({ loaded: 7, passed: 6, skipped: 1 });
    expect(result.namedSkips).toEqual(["tests/unit/example.test.ts > current skipped behavior"]);
    expect(result.tests).toHaveLength(6);
  });

  it("counts Playwright tests and rejects zero-test output", () => {
    expect(
      loadedTestsFromLog(
        "console-browser",
        revision,
        { os: "linux" },
        "browser.log",
        "  13 passed (8.1s)\n",
      ).loaded,
    ).toBe(13);
    expect(() =>
      loadedTestsFromLog("kojo-unit", revision, { os: "linux" }, "unit.log", "No test files found"),
    ).toThrow("loaded zero tests");
  });
});
