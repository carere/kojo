export type EvidenceTier =
  | "contract-runtime"
  | "kojo-unit"
  | "kojo-integration"
  | "console-browser"
  | "native-systemd"
  | "shipped-systemd"
  | "shipped-macos";

export interface LoadedTestEvidence {
  readonly tier: EvidenceTier;
  readonly testedRevision: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly loaded: number;
  readonly passed: number;
  readonly skipped: number;
  readonly namedSkips: ReadonlyArray<string>;
  readonly cacheHit: boolean;
  readonly log: string;
  readonly tests: ReadonlyArray<TestObservation>;
}

export interface TestObservation {
  readonly path: string;
  readonly name: string;
  readonly status: "failed" | "passed" | "skipped";
}

export interface RequiredObservation {
  readonly tier: EvidenceTier;
  readonly path: string;
  readonly name: string;
}

export interface RequiredReleaseCheck {
  readonly checkId: string;
  readonly stage: number;
  readonly expected: string;
  readonly testPath: string;
  readonly testName: string;
  readonly tiers: ReadonlyArray<EvidenceTier>;
  readonly observations: ReadonlyArray<RequiredObservation>;
}

export interface CompleteEvidenceInput {
  readonly testedRevision: string;
  readonly tiers: Readonly<Record<EvidenceTier, LoadedTestEvidence | undefined>>;
  readonly safetyRegression: {
    readonly expected: "protected check fails for injected regression";
    readonly actual: "failed-as-expected";
    readonly check: string;
    readonly log: string;
    readonly exitCode: number;
    readonly diagnostic: string;
  };
}

const check = (
  checkId: string,
  stage: number,
  expected: string,
  testPath: string,
  testName: string,
  tiers: ReadonlyArray<EvidenceTier>,
): RequiredReleaseCheck => {
  const coreTier: EvidenceTier | undefined = testPath.startsWith("apps/console/tests/browser/")
    ? "console-browser"
    : testPath.startsWith("packages/kojo-runtime/tests/")
      ? "contract-runtime"
      : testPath.startsWith("packages/kojo/tests/unit/")
        ? "kojo-unit"
        : testPath.startsWith("packages/kojo/tests/integration/")
          ? "kojo-integration"
          : testPath.startsWith("packages/kojo/tests/host/")
            ? "native-systemd"
            : undefined;
  const observations: ReadonlyArray<RequiredObservation> =
    checkId === "RELEASE-01"
      ? [
          { tier: "shipped-systemd", path: "evidence.json", name: "printed-fresh-install" },
          {
            tier: "shipped-macos",
            path: "RELEASE-01/evidence-manifest.json",
            name: "fresh shipped install",
          },
        ]
      : checkId === "RELEASE-02"
        ? [
            { tier: "shipped-systemd", path: "evidence.json", name: "real-daemon-records" },
            {
              tier: "shipped-macos",
              path: "RELEASE-02/evidence-manifest.json",
              name: "real persisted records",
            },
          ]
        : checkId === "RELEASE-03"
          ? [
              { tier: "shipped-systemd", path: "evidence.json", name: "global-tool-independence" },
              {
                tier: "shipped-macos",
                path: "RELEASE-03/evidence-manifest.json",
                name: "managed tools after global removal",
              },
            ]
          : coreTier === undefined
            ? []
            : [{ tier: coreTier, path: testPath, name: testName }];
  return { checkId, stage, expected, testPath, testName, tiers, observations };
};

/**
 * The names are the stable evidence allocation from spec #64. Paths and test names point at the
 * current Daemon codebase. Several original planned paths were combined when one higher-seam test
 * could prove the complete transition.
 */
export const requiredReleaseChecks: ReadonlyArray<RequiredReleaseCheck> = [
  check(
    "PKG-01",
    1,
    "all four packages are in every build graph with no Console cycle or wildcard export",
    "packages/kojo/tests/integration/contexts/daemon/packages.test.ts",
    "the daemon package graph",
    ["kojo-integration"],
  ),
  check(
    "PKG-02",
    1,
    "one exact physical Effect peer is used and a mismatch makes the Factory invalid",
    "packages/kojo-runtime/tests/integration/contexts/workflow/packageContract.test.ts",
    "the Project-local runtime package contract",
    ["contract-runtime"],
  ),
  check(
    "PKG-03",
    1,
    "standalone validation does not execute a Workflow and diagnoses a missing runtime",
    "packages/kojo/tests/integration/contexts/scaffold/validation.test.ts",
    "standalone Project validation",
    ["kojo-integration"],
  ),
  check(
    "STATE-01",
    2,
    "Run and request identity deduplicate exact input and refuse changed content or collisions",
    "packages/kojo/tests/integration/contexts/workflow/admission.test.ts",
    "SQLite Run admission",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "STATE-02",
    2,
    "request receipts and domain transitions survive interruption as one durable result",
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "durable Project registration",
    ["kojo-integration"],
  ),
  check(
    "STATE-03",
    2,
    "Claims and slots change together and fence stale authority",
    "packages/kojo/tests/integration/contexts/workflow/claims.test.ts",
    "SQLite Claim fencing",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "STATE-04",
    2,
    "Trigger acknowledgement follows durable admission and retry does not repeat execution",
    "packages/kojo/tests/integration/contexts/trigger/admission.test.ts",
    "Trigger admission",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "GATE-01",
    2,
    "Deadline races use durable recording time and preserve the absolute Deadline",
    "packages/kojo/tests/integration/contexts/gate/deadline.test.ts",
    "SQLite Gate Deadline",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "GATE-02",
    2,
    "Verdict recording stays distinct from application and preserves Asking identity",
    "packages/kojo/tests/integration/contexts/gate/application.test.ts",
    "SQLite Gate application",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "RUNNER-01",
    3,
    "the private Runner binds protocol and graph before Factory import",
    "packages/kojo-runtime/tests/integration/contexts/project/handshake.test.ts",
    "Project Runner handshake",
    ["contract-runtime"],
  ),
  check(
    "RUNNER-02",
    3,
    "fresh Runner processes execute the exact registration and separate same-name revisions",
    "packages/kojo-runtime/tests/integration/contexts/workflow/replay.test.ts",
    "fresh Project Runner replay",
    ["contract-runtime"],
  ),
  check(
    "RUNNER-03",
    3,
    "recorded Phase results replay without repeating effects or inventing success",
    "packages/kojo-runtime/tests/integration/contexts/workflow/replay.test.ts",
    "fresh Project Runner replay",
    ["contract-runtime"],
  ),
  check(
    "RUNNER-04",
    3,
    "replacement keeps the Run identity, wake-up, and original Deadline",
    "packages/kojo/tests/integration/cli/gateAndResume.test.ts",
    "answering a Gate from another process",
    ["kojo-integration"],
  ),
  check(
    "RECOVER-01",
    4,
    "an uncertain external action stays held with durable intent and actual-count evidence",
    "packages/kojo/tests/integration/contexts/workflow/uncertainAction.test.ts",
    "uncertain external actions",
    ["kojo-integration"],
  ),
  check(
    "RECOVER-02",
    4,
    "only exact uncertainty authorization can retry and no result is invented",
    "packages/kojo/tests/integration/contexts/workflow/uncertainAction.test.ts",
    "uncertain external actions",
    ["kojo-integration"],
  ),
  check(
    "RECOVER-03",
    4,
    "lost Resource acquisition and interrupted release reconcile provider truth",
    "packages/kojo/tests/integration/contexts/project/resourceDaemon.test.ts",
    "real Daemon Resource lifecycle",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "RECOVER-04",
    4,
    "unsafe worktrees and sessions are preserved and hold the Project",
    "packages/kojo/tests/integration/contexts/project/adapters/SqliteResourceLeaseRepository.test.ts",
    "SQLite Resource leases",
    ["kojo-integration"],
  ),
  check(
    "RECOVER-05",
    4,
    "old process-group stop is confirmed before replacement or slot reuse",
    "packages/kojo/tests/integration/contexts/project/runnerRecovery.test.ts",
    "real Project Runner recovery",
    ["kojo-integration", "native-systemd"],
  ),
  check(
    "CANCEL-01",
    4,
    "cancellation races preserve execution truth and wait for confirmed process stop",
    "packages/kojo/tests/integration/contexts/workflow/cancel.test.ts",
    "SQLite Run cancellation",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "CANCEL-02",
    4,
    "forced Stop targets the accepted Workflow set and recovers siblings",
    "packages/kojo/tests/integration/contexts/workflow/forcedStop.test.ts",
    "real Project Runner cancellation",
    ["kojo-integration"],
  ),
  check(
    "REV-01",
    3,
    "concurrent capture never exposes partial or different validated content",
    "packages/kojo/tests/integration/contexts/project/services/materializeRevision.test.ts",
    "materialized revision purge preparation",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "REV-02",
    4,
    "source, assets, links, resolution, and exact installed packages are retained",
    "packages/kojo/tests/integration/contexts/workflow/retainedPackages.test.ts",
    "real Workflow Revision capture",
    ["kojo-integration"],
  ),
  check(
    "REV-03",
    4,
    "retained execution does not substitute current Factory or registry content",
    "packages/kojo-runtime/tests/integration/contexts/workflow/replay.test.ts",
    "fresh Project Runner replay",
    ["contract-runtime", "kojo-integration"],
  ),
  check(
    "REV-04",
    4,
    "readers and registrations stay protected through disposal and the final-reference grace",
    "packages/kojo/tests/unit/contexts/workflow/collection.test.ts",
    "Workflow Revision collection",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "REV-05",
    4,
    "missing or corrupt exact content holds dependents and repair refuses different bytes",
    "packages/kojo/tests/integration/contexts/workflow/revisionRepair.test.ts",
    "exact Workflow Revision repair",
    ["kojo-integration"],
  ),
  check(
    "SCHED-01",
    4,
    "accepted queue and fair scheduling defaults are enforced",
    "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
    "keeps the accepted scheduling limits explicit",
    ["kojo-unit"],
  ),
  check(
    "SCHED-02",
    4,
    "package switching follows order and restores only current Trigger polling",
    "packages/kojo/tests/integration/contexts/project/packageSwitch.test.ts",
    "Project Runner package switching",
    ["kojo-integration"],
  ),
  check(
    "SCHED-03",
    4,
    "Workflow activity and idle Runner rules do not hold admitted work",
    "packages/kojo/tests/integration/contexts/workflow/activity.test.ts",
    "durable Workflow activity",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "SCHED-04",
    4,
    "Factory Refresh isolates faults and never admits stale Workflow content",
    "packages/kojo/tests/integration/contexts/workflow/discovery.test.ts",
    "independent Factory Refresh and Workflow history",
    ["kojo-integration"],
  ),
  check(
    "PROJECT-01",
    4,
    "Project location identity, relocation, archive, and restore are explicit and durable",
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "durable Project registration",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "LOAD-01",
    4,
    "malformed and slow Runner peers cannot consume reserved control capacity",
    "packages/kojo/tests/integration/contexts/project/runnerChannel.test.ts",
    "private Runner channel limits",
    ["kojo-integration"],
  ),
  check(
    "LOAD-02",
    5,
    "restart budgets persist and reset only after readiness and operation success",
    "packages/kojo/tests/integration/contexts/daemon/managedDaemonSupervision.test.ts",
    "managed Daemon supervision",
    ["kojo-integration", "native-systemd"],
  ),
  check(
    "LIFE-01",
    5,
    "native per-user lifecycle and singleton behavior pass on macOS and systemd Linux",
    "packages/kojo/tests/host/contexts/daemon/service.test.ts",
    "native systemd user Daemon lifecycle",
    ["native-systemd", "shipped-systemd", "shipped-macos"],
  ),
  check(
    "LIFE-02",
    5,
    "planned drain outlives the client wait and force stays explicit",
    "packages/kojo/tests/integration/contexts/daemon/lifecycleControlTransport.test.ts",
    "the private lifecycle control transport",
    ["kojo-integration", "shipped-systemd", "shipped-macos"],
  ),
  check(
    "LIFE-03",
    5,
    "one lifecycle controller keeps the operation through endpoint and owner loss",
    "packages/kojo/tests/integration/contexts/daemon/lifecycleControlTransport.test.ts",
    "the private lifecycle control transport",
    ["kojo-integration"],
  ),
  check(
    "LIFE-04",
    5,
    "journal and activation receipts reconcile without controller database access",
    "packages/kojo/tests/integration/contexts/daemon/lifecycleJournal.test.ts",
    "the private lifecycle journal",
    ["kojo-integration"],
  ),
  check(
    "LIFE-05",
    5,
    "incomplete or incompatible release evidence refuses activation",
    "packages/kojo/tests/integration/contexts/daemon/preflight.test.ts",
    "managed release staging",
    ["kojo-integration"],
  ),
  check(
    "LIFE-06",
    5,
    "readiness and rollback outcomes stay distinct and recoverable",
    "packages/kojo/tests/integration/contexts/daemon/activation.test.ts",
    "recoverable managed upgrade activation",
    ["kojo-integration"],
  ),
  check(
    "LIFE-07",
    5,
    "migration uses a verified backup and never erases newer accepted state",
    "packages/kojo/tests/integration/contexts/daemon/activation.test.ts",
    "recoverable managed upgrade activation",
    ["kojo-integration"],
  ),
  check(
    "LIFE-08",
    5,
    "replacement preserves data identity and renews process and browser authority",
    "packages/kojo/tests/integration/contexts/daemon/managedInstallation.test.ts",
    "the managed Daemon installation",
    ["kojo-integration", "shipped-systemd", "shipped-macos"],
  ),
  check(
    "ACCESS-01",
    6,
    "private socket ownership and stale-path behavior pass on supported Hosts",
    "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
    "one idle Daemon owns one data root",
    ["kojo-integration", "native-systemd", "shipped-macos"],
  ),
  check(
    "ACCESS-02",
    6,
    "wrong Host or Origin and unauthenticated browser access are refused",
    "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
    "instance-bound browser access",
    ["kojo-integration"],
  ),
  check(
    "ACCESS-03",
    6,
    "browser grants are one-use, bounded, and revoked on replacement",
    "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
    "instance-bound browser access",
    ["kojo-integration"],
  ),
  check(
    "ACCESS-04",
    6,
    "Artifact publication and browser display preserve safe exact bytes",
    "apps/console/tests/browser/artifact.spec.ts",
    "serves an Artifact only through authenticated bounded display and download responses",
    ["kojo-integration", "console-browser"],
  ),
  check(
    "CLIENT-01",
    6,
    "lost client replies recover the original request without a second mutation",
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "durable Project registration",
    ["kojo-integration"],
  ),
  check(
    "CLIENT-02",
    6,
    "retired request evidence cannot become fresh work and old identity blocks purge",
    "packages/kojo/tests/integration/contexts/daemon/removePurge.test.ts",
    "remove safety and exact offline purge",
    ["kojo-integration"],
  ),
  check(
    "CLIENT-03",
    6,
    "subscriptions and reconnects preserve final state without delaying execution",
    "packages/kojo/tests/integration/contexts/daemon/notifications.test.ts",
    "preserves final snapshots across reconnect and disconnects slow readers without delaying execution",
    ["kojo-integration"],
  ),
  check(
    "CLI-01",
    6,
    "supported selectors, JSON modes, waits, retries, and exit codes remain stable",
    "packages/kojo/tests/unit/cli/kojo.test.ts",
    "the kojo command",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "CLI-02",
    6,
    "maintenance plans expire and revalidate with no generic force",
    "packages/kojo/tests/integration/contexts/daemon/configurationRetention.test.ts",
    "SQLite configuration retention",
    ["kojo-unit", "kojo-integration"],
  ),
  check(
    "UI-01",
    6,
    "flat navigation and filtered Project, Workflow, Run, and Gate tables preserve links",
    "apps/console/tests/browser/projectCatalogue.spec.ts",
    "filters an authoritative Project grid",
    ["console-browser"],
  ),
  check(
    "UI-02",
    6,
    "safe Daemon actions keep stale and Recorded or Applied states distinct",
    "apps/console/tests/browser/gateVerdict.spec.ts",
    "shows Unanswered, Recorded, Applied",
    ["console-browser"],
  ),
  check(
    "UI-03",
    6,
    "the Console uses its Zaidan grids and filters at browser seams",
    "apps/console/tests/browser/workflowCatalogue.spec.ts",
    "Zaidan grid",
    ["console-browser"],
  ),
  check(
    "RELEASE-01",
    7,
    "fresh shipped installs follow printed supported commands without fixture repair",
    "packages/kojo/tests/release/freshInstall.test.ts",
    "the shipped macOS installation",
    ["shipped-systemd", "shipped-macos"],
  ),
  check(
    "RELEASE-02",
    7,
    "actual persisted records and absent optional wire fields render in the shipped Console",
    "apps/console/tests/release/shippedDaemon.spec.ts",
    "renders actual shipped Daemon records",
    ["shipped-systemd", "shipped-macos"],
  ),
  check(
    "RELEASE-03",
    7,
    "managed Daemon, Console, recovery, and CLI work after global tool removal",
    "packages/kojo/tests/release/freshInstall.test.ts",
    "the shipped macOS installation",
    ["shipped-systemd", "shipped-macos"],
  ),
  check(
    "RELEASE-04",
    7,
    "old execution, storage, and spend paths are absent and guidance matches the shipped contract",
    "packages/kojo/tests/integration/release/contractCutover.test.ts",
    "the Daemon contract cutover",
    ["kojo-integration"],
  ),
];

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export const loadedTestsFromLog = (
  tier: EvidenceTier,
  testedRevision: string,
  environment: Readonly<Record<string, string>>,
  logPath: string,
  log: string,
): LoadedTestEvidence => {
  const plain = log.replace(ansi, "");
  const tests: TestObservation[] = [];
  let loaded = 0;
  let passed = 0;
  let skipped = 0;
  for (const line of plain.split("\n")) {
    const result = line.match(/(?:^|\|)\s*([✓×↓])\s+(.+)$/);
    if (result?.[1] !== undefined && result[2] !== undefined) {
      const body = result[2].replace(/\s+\d+(?:\.\d+)?m?s\s*$/, "");
      const path = body.match(
        /((?:packages|apps)\/[^ >›:]+\.(?:test|spec)\.ts|tests\/[^ >›:]+\.(?:test|spec)\.ts)/,
      )?.[1];
      if (path !== undefined) {
        tests.push({
          path,
          name: body,
          status: result[1] === "✓" ? "passed" : result[1] === "↓" ? "skipped" : "failed",
        });
      }
    }
    if (/\bTests\b/.test(line)) {
      const total = line.match(/\((\d+)\)\s*$/)?.[1];
      if (total !== undefined) {
        loaded += Number(total);
        passed += Number(line.match(/(\d+)\s+passed/)?.[1] ?? 0);
        skipped += Number(line.match(/(\d+)\s+skipped/)?.[1] ?? 0);
      }
    }
  }
  if (loaded === 0 && tier === "console-browser") {
    passed = Number(plain.match(/\b(\d+)\s+passed(?:\s|$)/m)?.[1] ?? 0);
    skipped = Number(plain.match(/\b(\d+)\s+skipped(?:\s|$)/m)?.[1] ?? 0);
    loaded = passed + skipped;
  }
  const namedSkips = [...plain.matchAll(/(?:^|\|)\s*↓\s+(.+)$/gm)].map(
    (match) => match[1]?.trim() ?? "",
  );
  if (loaded === 0) throw new Error(`${tier} loaded zero tests`);
  if (passed + skipped !== loaded) {
    throw new Error(
      `${tier} result count is incomplete: ${passed} passed + ${skipped} skipped != ${loaded} loaded`,
    );
  }
  if (namedSkips.length !== skipped) {
    throw new Error(`${tier} has ${skipped} skips but ${namedSkips.length} named skips`);
  }
  return {
    tier,
    testedRevision,
    environment,
    loaded,
    passed,
    skipped,
    namedSkips,
    cacheHit: false,
    log: logPath,
    tests,
  };
};

const fail = (message: string): never => {
  throw new Error(`release evidence is incomplete: ${message}`);
};

export const completeReleaseEvidence = (input: CompleteEvidenceInput) => {
  if (
    input.safetyRegression.actual !== "failed-as-expected" ||
    input.safetyRegression.exitCode === 0 ||
    input.safetyRegression.diagnostic.trim().length === 0
  ) {
    fail("the protected safety check did not detect its injected regression");
  }
  for (const tier of ["native-systemd", "shipped-systemd", "shipped-macos"] as const) {
    if (input.tiers[tier] === undefined) fail(`supported Host has no ${tier} evidence`);
  }
  const ids = new Set<string>();
  const records = requiredReleaseChecks.map((required) => {
    if (ids.has(required.checkId)) fail(`duplicate required check ${required.checkId}`);
    ids.add(required.checkId);
    if (required.observations.length === 0) fail(`${required.checkId} has no named observation`);
    const evidence = required.observations.map((observation) => {
      const receipt =
        input.tiers[observation.tier] ??
        fail(`${required.checkId} has no ${observation.tier} evidence`);
      if (receipt.testedRevision !== input.testedRevision) {
        fail(
          `${required.checkId} ${observation.tier} tested ${receipt.testedRevision}, not ${input.testedRevision}`,
        );
      }
      if (receipt.cacheHit) fail(`${required.checkId} ${observation.tier} used a cache hit`);
      if (receipt.loaded === 0) fail(`${required.checkId} ${observation.tier} loaded zero tests`);
      if (receipt.passed === 0) fail(`${required.checkId} ${observation.tier} passed zero tests`);
      if (receipt.passed + receipt.skipped !== receipt.loaded) {
        fail(`${required.checkId} ${observation.tier} has incomplete test counts`);
      }
      if (receipt.namedSkips.length !== receipt.skipped) {
        fail(`${required.checkId} ${observation.tier} does not name every skip`);
      }
      for (const property of ["os", "architecture", "bun", "moon"] as const) {
        const value = receipt.environment[property];
        if (value === undefined || value.trim().length === 0) {
          fail(`${required.checkId} ${observation.tier} has no ${property} environment fact`);
        }
      }
      const matching = receipt.tests.filter(
        (test) =>
          (test.path === observation.path || observation.path.endsWith(test.path)) &&
          test.name.includes(observation.name),
      );
      if (matching.length === 0) {
        fail(`${required.checkId} did not load named observation ${observation.name}`);
      }
      if (matching.some((test) => test.status !== "passed")) {
        fail(`${required.checkId} named observation ${observation.name} did not pass`);
      }
      return {
        tier: observation.tier,
        testedRevision: receipt.testedRevision,
        environment: receipt.environment,
        loaded: matching.length,
        passed: matching.length,
        skipped: 0,
        namedSkips: [],
        cacheHit: false,
        log: receipt.log,
        tests: matching,
      } satisfies LoadedTestEvidence;
    });
    return {
      formatVersion: 1,
      checkId: required.checkId,
      stage: required.stage,
      testedRevision: input.testedRevision,
      test: { path: required.testPath, name: required.testName },
      expected: required.expected,
      actual: evidence.every((receipt) => receipt.passed === receipt.loaded) ? "passed" : "failed",
      evidence,
      namedSkips: evidence.flatMap((receipt) => receipt.namedSkips),
    } as const;
  });
  return {
    formatVersion: 1,
    kind: "complete-breaking-release-evidence",
    testedRevision: input.testedRevision,
    requiredChecks: records.length,
    acceptedChecks: records.length,
    supportedHosts: ["darwin", "linux-systemd"],
    safetyRegression: input.safetyRegression,
    records,
  } as const;
};
