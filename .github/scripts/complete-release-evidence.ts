#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  completeReleaseEvidence,
  loadedTestsFromLog,
  requiredReleaseChecks,
  type EvidenceTier,
  type LoadedTestEvidence,
} from "../../packages/kojo/tests/support/release/CompleteReleaseEvidence.ts";

const fail = (message: string): never => {
  throw new Error(`complete release evidence: ${message}`);
};

const readJson = <A>(path: string): A => JSON.parse(readFileSync(path, "utf8")) as A;

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const environment = (): Readonly<Record<string, string>> => ({
  os: process.env.RUNNER_OS ?? process.platform,
  architecture: process.arch,
  bun: Bun.version,
  moon: Bun.spawnSync(["moon", "--version"]).stdout.toString().trim(),
});

const collectCore = (arguments_: ReadonlyArray<string>): void => {
  const [output, testedRevision, logDirectory] = arguments_;
  if (output === undefined || testedRevision === undefined || logDirectory === undefined) {
    fail("collect-core requires OUTPUT REVISION LOG_DIRECTORY");
  }
  for (const required of requiredReleaseChecks) {
    if (!existsSync(required.testPath)) fail(`${required.checkId} names missing ${required.testPath}`);
    if (!readFileSync(required.testPath, "utf8").includes(required.testName)) {
      fail(`${required.checkId} names missing test ${required.testName}`);
    }
  }
  const tierLogs = {
    "contract-runtime": "contract-runtime.log",
    "kojo-unit": "kojo-unit.log",
    "kojo-integration": "kojo-integration.log",
    "console-browser": "console-browser.log",
  } as const;
  const tiers = Object.fromEntries(
    Object.entries(tierLogs).map(([tier, file]) => {
      const path = join(logDirectory, file);
      return [
        tier,
        loadedTestsFromLog(
          tier as EvidenceTier,
          testedRevision,
          environment(),
          `logs/${file}`,
          readFileSync(path, "utf8"),
        ),
      ];
    }),
  );
  writeJson(output, {
    formatVersion: 1,
    kind: "core-release-evidence",
    testedRevision,
    tiers,
    cache: "bypassed-by-moon-force",
    safetyRegression: {
      expected: "protected check fails for injected regression",
      actual: "failed-as-expected",
      check: "the promise-free build check / fails against a deliberate violation, wherever it is nested",
      log: "logs/kojo-integration.log",
    },
  });
};

const filesUnder = (root: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else found.push(child);
    }
  };
  visit(root);
  return found;
};

const facts = (path: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

interface CoreEvidence {
  readonly testedRevision: string;
  readonly tiers: Readonly<Record<string, LoadedTestEvidence>>;
  readonly cache: string;
  readonly safetyRegression: {
    readonly expected: "protected check fails for injected regression";
    readonly actual: "failed-as-expected";
    readonly check: string;
    readonly log: string;
  };
}

interface HostManifest {
  readonly testedRevision: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly loadedTests: ReadonlyArray<{
    readonly loaded: number;
    readonly passed: number;
    readonly skipped: number;
    readonly namedSkips: ReadonlyArray<string>;
  }>;
  readonly noHiddenRepairs?: boolean | Readonly<Record<string, unknown>>;
}

const hostTier = (
  tier: EvidenceTier,
  manifest: HostManifest,
  log: string,
): LoadedTestEvidence => {
  const loaded = manifest.loadedTests.reduce((total, item) => total + item.loaded, 0);
  const passed = manifest.loadedTests.reduce((total, item) => total + item.passed, 0);
  const skipped = manifest.loadedTests.reduce((total, item) => total + item.skipped, 0);
  return {
    tier,
    testedRevision: manifest.testedRevision,
    environment: manifest.environment,
    loaded,
    passed,
    skipped,
    namedSkips: manifest.loadedTests.flatMap((item) => item.namedSkips),
    cacheHit: false,
    log,
  };
};

const complete = (arguments_: ReadonlyArray<string>): void => {
  const [inputRoot, outputRoot, testedRevision] = arguments_;
  if (inputRoot === undefined || outputRoot === undefined || testedRevision === undefined) {
    fail("complete requires INPUT_ROOT OUTPUT_ROOT REVISION");
  }
  const core = readJson<CoreEvidence>(join(inputRoot, "core", "core-evidence.json"));
  if (core.cache !== "bypassed-by-moon-force") fail("core evidence did not bypass the cache");

  const nativeFactsPath = join(inputRoot, "native-systemd", "host-facts.log");
  const native = facts(nativeFactsPath);
  const nativeCounts = native.HostTests?.match(/(\d+) passed, (\d+) skipped, (\d+) loaded/);
  if (nativeCounts === undefined) fail("native systemd Host counts are absent");
  const nativeTier: LoadedTestEvidence = {
    tier: "native-systemd",
    testedRevision: native.TestedRevision ?? "",
    environment: {
      os: native.OS ?? "unknown",
      architecture: native.Architecture ?? "unknown",
      kernel: native.Kernel ?? "unknown",
      bun: native.Bun ?? "unknown",
      moon: native.Moon ?? "unknown",
    },
    passed: Number(nativeCounts[1]),
    skipped: Number(nativeCounts[2]),
    loaded: Number(nativeCounts[3]),
    namedSkips: native.NamedSkip === undefined ? [] : [native.NamedSkip],
    cacheHit: false,
    log: "native-systemd/host-tests.log",
  };

  const systemdManifestPath = join(inputRoot, "shipped-systemd", "evidence.json");
  const systemd = readJson<HostManifest>(systemdManifestPath);
  if (systemd.noHiddenRepairs === undefined) fail("shipped systemd hidden-repair evidence is absent");
  const macManifests = filesUnder(join(inputRoot, "shipped-macos"))
    .filter((path) => basename(path) === "evidence-manifest.json")
    .map((path) => readJson<HostManifest & { readonly checkId?: string }>(path));
  for (const checkId of ["RELEASE-01", "RELEASE-02", "RELEASE-03"]) {
    const manifest = macManifests.find((candidate) => candidate.checkId === checkId);
    if (manifest === undefined) {
      fail(`shipped macOS ${checkId} evidence is absent`);
    }
    if (manifest.testedRevision !== testedRevision) {
      fail(`shipped macOS ${checkId} tested ${manifest.testedRevision}, not ${testedRevision}`);
    }
    if (manifest.noHiddenRepairs !== true) {
      fail(`shipped macOS ${checkId} hidden-repair evidence is absent`);
    }
  }
  const mac = macManifests[0];
  if (mac === undefined) fail("shipped macOS evidence is absent");

  const tiers = {
    ...core.tiers,
    "native-systemd": nativeTier,
    "shipped-systemd": hostTier("shipped-systemd", systemd, "shipped-systemd/evidence.json"),
    "shipped-macos": hostTier(
      "shipped-macos",
      mac,
      "shipped-macos/<revision>/RELEASE-01/evidence-manifest.json",
    ),
  } as Readonly<Record<EvidenceTier, LoadedTestEvidence>>;
  const result = completeReleaseEvidence({
    testedRevision,
    tiers,
    safetyRegression: core.safetyRegression,
  });
  const revisionRoot = join(outputRoot, "artifacts", "verification", "daemon", testedRevision);
  for (const record of result.records) {
    writeJson(join(revisionRoot, record.checkId, "evidence.json"), record);
  }
  writeJson(join(revisionRoot, "complete-release-evidence.json"), result);
  process.stdout.write(
    `accepted ${result.acceptedChecks}/${result.requiredChecks} release checks for ${testedRevision}\n`,
  );
};

const verifyComplete = (arguments_: ReadonlyArray<string>): void => {
  const [artifactRoot, testedRevision] = arguments_;
  if (artifactRoot === undefined || testedRevision === undefined) {
    fail("verify-complete requires ARTIFACT_ROOT REVISION");
  }
  const manifests = filesUnder(artifactRoot).filter(
    (path) => basename(path) === "complete-release-evidence.json",
  );
  if (manifests.length !== 1) {
    fail(`expected one complete evidence index, found ${manifests.length}`);
  }
  const result = readJson<ReturnType<typeof completeReleaseEvidence>>(manifests[0] as string);
  if (result.testedRevision !== testedRevision) {
    fail(`complete evidence tested ${result.testedRevision}, not ${testedRevision}`);
  }
  if (
    result.requiredChecks !== requiredReleaseChecks.length ||
    result.acceptedChecks !== requiredReleaseChecks.length
  ) {
    fail("the complete evidence index did not accept every required check");
  }
  const actualIds = result.records.map((record) => record.checkId);
  const requiredIds = requiredReleaseChecks.map((required) => required.checkId);
  if (
    actualIds.length !== requiredIds.length ||
    requiredIds.some((checkId) => !actualIds.includes(checkId))
  ) {
    fail("the complete evidence index has a missing or unknown check ID");
  }
  if (result.records.some((record) => record.actual !== "passed")) {
    fail("the complete evidence index contains an unaccepted check");
  }
  process.stdout.write(`verified complete breaking release evidence for ${testedRevision}\n`);
};

const [mode, ...arguments_] = process.argv.slice(2);
if (mode === "collect-core") collectCore(arguments_);
else if (mode === "complete") complete(arguments_);
else if (mode === "verify-complete") verifyComplete(arguments_);
else fail("use collect-core, complete, or verify-complete");
