#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const repositoryBunVersion = (): string => {
  const matches = [
    ...readFileSync(resolve(process.cwd(), ".prototools"), "utf8").matchAll(
      /^bun = "(\d+\.\d+\.\d+)"$/gm,
    ),
  ];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    fail("the repository does not declare one exact Bun pin");
  }
  return matches[0][1];
};

const requirePinnedHostBun = (
  tier: "native-systemd" | "shipped-systemd" | "shipped-macos",
  recorded: string | undefined,
  pinned: string,
): void => {
  if (recorded !== pinned) {
    fail(`${tier} recorded Bun ${recorded ?? "unknown"}, not repository pin ${pinned}`);
  }
};

const collectCore = (arguments_: ReadonlyArray<string>): void => {
  const [output, testedRevision, logDirectory] = arguments_;
  if (output === undefined || testedRevision === undefined || logDirectory === undefined) {
    fail("collect-core requires OUTPUT REVISION LOG_DIRECTORY");
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
  const integration = tiers["kojo-integration"] as LoadedTestEvidence;
  for (const required of requiredReleaseChecks) {
    for (const observation of required.observations) {
      const receipt = tiers[observation.tier] as LoadedTestEvidence | undefined;
      if (receipt === undefined) continue;
      const matches = receipt.tests.filter(
        (test) =>
          (test.path === observation.path || observation.path.endsWith(test.path)) &&
          test.name === observation.name,
      );
      if (matches.length !== 1 || matches[0]?.status !== "passed") {
        fail(
          `${required.checkId} exact observation is missing, duplicated, skipped, or failed: ${observation.path} > ${observation.name}`,
        );
      }
    }
  }
  const protectedTest = integration.tests.find(
    (test) =>
      test.path.endsWith("tests/integration/contexts/sandbox/guards/promiseFreeTypes.test.ts") &&
      test.name.includes("fails against a deliberate violation, wherever it is nested"),
  );
  if (protectedTest?.status !== "passed") {
    fail("the named promise-free regression test was missing, skipped, or failed");
  }
  const regressionRoot = mkdtempSync(join(tmpdir(), "kojo-release-regression-"));
  const regressionFile = join(regressionRoot, "nested", "deliberateLeak.d.ts");
  mkdirSync(resolve(regressionFile, ".."), { recursive: true });
  writeFileSync(regressionFile, "export declare const leaked: () => Promise<string>;\n");
  const regression = Bun.spawnSync(
    [process.execPath, "packages/kojo/src/scripts/check-public-types.ts", regressionRoot],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  rmSync(regressionRoot, { recursive: true, force: true });
  const regressionDiagnostic = `${regression.stdout.toString()}${regression.stderr.toString()}`;
  if (regression.exitCode === 0 || !regressionDiagnostic.includes("deliberateLeak.d.ts:1")) {
    fail("the promise-free executable did not become red for the injected regression");
  }
  writeJson(output, {
    formatVersion: 1,
    kind: "core-release-evidence",
    testedRevision,
    tiers,
    cache: "bypassed-by-moon-force",
    safetyRegression: {
      expected: "protected check fails for injected regression",
      actual: "failed-as-expected",
      check: protectedTest.name,
      log: "logs/kojo-integration.log; injected-regression subprocess",
      exitCode: regression.exitCode,
      diagnostic: regressionDiagnostic.trim(),
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
    readonly exitCode: number;
    readonly diagnostic: string;
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
  readonly checkId?: string;
  readonly checks?: ReadonlyArray<{
    readonly name: string;
    readonly expected: string;
    readonly actual: string;
    readonly evidence: string;
  }>;
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
    tests: (manifest.checks ?? []).map((check) => ({
      path: manifest.checkId === undefined ? "evidence.json" : `${manifest.checkId}/evidence-manifest.json`,
      name: check.name,
      status: ["passed", "installed", "recorded", "usable"].includes(check.actual) ||
          check.actual.startsWith("rendered")
        ? "passed"
        : "failed",
      log,
    })),
  };
};

const complete = (arguments_: ReadonlyArray<string>): void => {
  const [inputRoot, outputRoot, testedRevision] = arguments_;
  if (inputRoot === undefined || outputRoot === undefined || testedRevision === undefined) {
    fail("complete requires INPUT_ROOT OUTPUT_ROOT REVISION");
  }
  const core = readJson<CoreEvidence>(join(inputRoot, "core", "core-evidence.json"));
  if (core.cache !== "bypassed-by-moon-force") fail("core evidence did not bypass the cache");
  const pinnedBun = repositoryBunVersion();

  const nativeFactsPath = join(inputRoot, "native-systemd", "host-facts.log");
  const native = facts(nativeFactsPath);
  const nativeCounts = native.HostTests?.match(/(\d+) passed, (\d+) skipped, (\d+) loaded/);
  if (nativeCounts === undefined) fail("native systemd Host counts are absent");
  const nativeEnvironment = {
      os: native.OS ?? "unknown",
      architecture: native.Architecture ?? "unknown",
      kernel: native.Kernel ?? "unknown",
      bun: native.Bun ?? "unknown",
      moon: native.Moon ?? "unknown",
    };
  const nativeTier = loadedTestsFromLog(
    "native-systemd",
    native.TestedRevision ?? "",
    nativeEnvironment,
    "native-systemd/host-tests.log",
    readFileSync(join(inputRoot, "native-systemd", "host-tests.log"), "utf8"),
  );
  if (
    nativeTier.passed !== Number(nativeCounts[1]) ||
    nativeTier.skipped !== Number(nativeCounts[2]) ||
    nativeTier.loaded !== Number(nativeCounts[3])
  ) fail("native systemd Host log differs from its recorded counts");
  requirePinnedHostBun("native-systemd", nativeEnvironment.bun, pinnedBun);

  const systemdManifestPath = join(inputRoot, "shipped-systemd", "evidence.json");
  const systemd = readJson<HostManifest>(systemdManifestPath);
  if (systemd.noHiddenRepairs === undefined) fail("shipped systemd hidden-repair evidence is absent");
  requirePinnedHostBun("shipped-systemd", systemd.environment.bun, pinnedBun);
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
    requirePinnedHostBun("shipped-macos", manifest.environment.bun, pinnedBun);
  }
  const mac = macManifests[0];
  if (mac === undefined) fail("shipped macOS evidence is absent");
  const macTiers = macManifests.map((manifest) =>
    hostTier(
      "shipped-macos",
      manifest,
      `shipped-macos/${manifest.testedRevision}/${manifest.checkId ?? "unknown"}/evidence-manifest.json`,
    ),
  );

  const tiers = {
    ...core.tiers,
    "native-systemd": nativeTier,
    "shipped-systemd": hostTier("shipped-systemd", systemd, "shipped-systemd/evidence.json"),
    "shipped-macos": {
      ...macTiers[0],
      log: `shipped-macos/${testedRevision}/*/evidence-manifest.json`,
      loaded: macTiers.reduce((sum, tier) => sum + tier.loaded, 0),
      passed: macTiers.reduce((sum, tier) => sum + tier.passed, 0),
      skipped: macTiers.reduce((sum, tier) => sum + tier.skipped, 0),
      namedSkips: macTiers.flatMap((tier) => tier.namedSkips),
      tests: macTiers.flatMap((tier) => tier.tests),
    },
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
