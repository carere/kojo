import { describe, expect, it } from "vitest";
import {
  type CompleteEvidenceInput,
  completeReleaseEvidence,
  type EvidenceTier,
  type LoadedTestEvidence,
  loadedTestsFromLog,
  requiredReleaseChecks,
} from "../../../support/release/CompleteReleaseEvidence.ts";
import { issue64RequiredTierAllocation } from "../../../support/release/Issue64TierAllocation.ts";
import { hostMutationOwnerEvidence } from "../../../support/release/MutationOwnerEvidence.ts";

const revision = "a".repeat(40);
const tierNames: ReadonlyArray<EvidenceTier> = [
  "contract-runtime",
  "kojo-unit",
  "kojo-integration",
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
  it("creates one accepted revision-bound record for every active release check", () => {
    const result = completeReleaseEvidence(input());

    expect(result.requiredChecks).toBe(52);
    expect(result.acceptedChecks).toBe(52);
    expect(new Set(result.records.map((record) => record.checkId)).size).toBe(52);
    expect(result.records.map((record) => record.checkId)).toEqual(
      requiredReleaseChecks.map((required) => required.checkId),
    );
    expect(result.supportedHosts).toEqual(["darwin", "linux-systemd"]);
  });

  it("accepts matching cached test observations", () => {
    const subject = input();
    const result = completeReleaseEvidence({
      ...subject,
      tiers: {
        ...subject.tiers,
        "kojo-integration": { ...tier("kojo-integration"), cacheHit: true },
      },
    });
    expect(result.records).toHaveLength(requiredReleaseChecks.length);
  });

  it.each([
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

  it("refuses a broad substring and keeps the issue allocation immutable", () => {
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

    expect(Object.isFrozen(issue64RequiredTierAllocation)).toBe(true);
    for (const allocation of Object.values(issue64RequiredTierAllocation)) {
      expect(Object.isFrozen(allocation)).toBe(true);
    }
  });

  it("requires both exact Host mutation-owner leaves for CLIENT-01", () => {
    const required = requiredReleaseChecks.find((check) => check.checkId === "CLIENT-01");
    expect(required).toBeDefined();
    expect(
      required?.observations.filter(({ operation, owner }) => operation && owner),
    ).toHaveLength(18);
    const accepted = completeReleaseEvidence(input()).records.find(
      (record) => record.checkId === "CLIENT-01",
    );
    expect(accepted?.evidence.filter(({ operation, owner }) => operation && owner)).toHaveLength(
      18,
    );
    for (const host of hostMutationOwnerEvidence) {
      expect(required?.observations).toContainEqual(
        expect.objectContaining({
          operation: host.operation,
          owner: host.owner,
          path: host.path,
          name: host.name,
        }),
      );
      const subject = input();
      const integration = subject.tiers["kojo-integration"] as LoadedTestEvidence;
      const withoutHostOwner = integration.tests.filter(
        (test) => test.path !== host.path || test.name !== host.name,
      );
      expect(() =>
        completeReleaseEvidence({
          ...subject,
          tiers: {
            ...subject.tiers,
            "kojo-integration": { ...integration, tests: withoutHostOwner },
          },
        }),
      ).toThrow(`did not load named observation ${host.name}`);
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

  it("records a Moon cache hit and retains the replayed named results", () => {
    const result = loadedTestsFromLog(
      "kojo-unit",
      revision,
      { os: "linux" },
      "unit.log",
      [
        "kojo:test | ✓ tests/unit/example.test.ts > current behavior 2ms",
        "kojo:test | Tests 1 passed (1)",
        "▮▮▮▮ kojo:test (cached, 12345678)",
      ].join("\n"),
    );
    expect(result.cacheHit).toBe(true);
    expect(result.tests).toEqual([
      { path: "tests/unit/example.test.ts", name: "current behavior", status: "passed" },
    ]);
    expect(result.loaded).toBe(1);
  });

  it("rejects zero-test output", () => {
    expect(() =>
      loadedTestsFromLog("kojo-unit", revision, { os: "linux" }, "unit.log", "No test files found"),
    ).toThrow("loaded zero tests");
  });
});
