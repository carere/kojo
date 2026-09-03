import {
  type Issue64CheckId,
  type Issue64Tier,
  issue64RequiredTierAllocation,
} from "./Issue64TierAllocation.ts";
import { hostMutationOwnerEvidence, sqliteMutationOwnerEvidence } from "./MutationOwnerEvidence.ts";

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
  readonly operation?: string;
  readonly owner?: string;
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
  readonly issueTiers?: ReadonlyArray<Issue64Tier>;
  readonly operation?: string;
  readonly owner?: string;
}

export interface RequiredReleaseCheck {
  readonly checkId: Issue64CheckId;
  readonly stage: number;
  readonly expected: string;
  readonly testPath: string;
  readonly testName: string;
  /** Log receipts needed to load the exact leaves. This is not issue #64's U/I/H/B/R allocation. */
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
  checkId: Issue64CheckId,
  stage: number,
  expected: string,
  testPath: string,
  testName: string,
  tiers: ReadonlyArray<EvidenceTier>,
  additionalObservations: ReadonlyArray<RequiredObservation> = [],
  primaryOwner?: { readonly operation: string; readonly owner: string },
): RequiredReleaseCheck => {
  const allocatedTiers = issue64RequiredTierAllocation[checkId];
  if (allocatedTiers === undefined) throw new Error(`${checkId} has no issue #64 tier allocation`);
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
          {
            tier: "shipped-systemd",
            path: "evidence.json",
            name: "printed-fresh-install",
            issueTiers: ["R", "H"],
          },
          {
            tier: "shipped-macos",
            path: "RELEASE-01/evidence-manifest.json",
            name: "fresh shipped install",
            issueTiers: ["R", "H"],
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
              {
                tier: "shipped-systemd",
                path: "evidence.json",
                name: "global-tool-independence",
                issueTiers: ["R", "H"],
              },
              {
                tier: "shipped-macos",
                path: "RELEASE-03/evidence-manifest.json",
                name: "managed tools after global removal",
                issueTiers: ["R", "H"],
              },
            ]
          : checkId === "RELEASE-04" && coreTier !== undefined
            ? [
                { tier: coreTier, path: testPath, name: testName },
                {
                  tier: "shipped-systemd",
                  path: "evidence.json",
                  name: "printed-fresh-install",
                  issueTiers: ["R"],
                },
                ...additionalObservations,
              ]
            : coreTier === undefined
              ? additionalObservations
              : [
                  {
                    tier: coreTier,
                    path: testPath,
                    name: testName,
                    ...(primaryOwner ?? {}),
                  },
                  ...additionalObservations,
                ];
  return { checkId, stage, expected, testPath, testName, tiers, observations };
};

const issueTiersForObservation = (observation: RequiredObservation): ReadonlyArray<Issue64Tier> => {
  if (observation.issueTiers !== undefined) return observation.issueTiers;
  if (observation.path.includes("/tests/unit/")) return ["U"];
  if (observation.path.includes("/tests/integration/")) return ["I"];
  if (observation.path.includes("/tests/browser/")) return ["B"];
  if (observation.path.includes("/tests/host/")) return ["H"];
  if (observation.tier === "shipped-systemd" || observation.tier === "shipped-macos") return ["R"];
  return [];
};

/**
 * The names are the stable evidence allocation from spec #64. Paths and test names point at the
 * current Daemon codebase. Each observation is an exact leaf test that exercises the stated
 * behavior. A check can require several observations from one tier when one leaf cannot prove all
 * parts of the acceptance statement.
 */
export const requiredReleaseChecks: ReadonlyArray<RequiredReleaseCheck> = [
  check(
    "PKG-01",
    1,
    "all four packages are in every build graph with no Console cycle or wildcard export",
    "packages/kojo/tests/integration/contexts/daemon/packages.test.ts",
    "loads every package and rejects dependency or output drift",
    ["kojo-integration"],
  ),
  check(
    "PKG-02",
    1,
    "one exact physical Effect peer is used and a mismatch makes the Factory invalid",
    "packages/kojo-runtime/tests/integration/contexts/workflow/packageContract.test.ts",
    "has one exact physical Effect peer",
    ["contract-runtime", "kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/scaffold/validation.test.ts",
        name: "marks the Factory Invalid when authored code resolves a second physical Effect",
      },
    ],
  ),
  check(
    "PKG-03",
    1,
    "standalone validation does not execute a Workflow and diagnoses a missing runtime",
    "packages/kojo/tests/integration/contexts/scaffold/validation.test.ts",
    "returns plain diagnostics without executing a Workflow",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/scaffold/validation.test.ts",
        name: "diagnoses a missing Project runtime without a Daemon",
      },
    ],
  ),
  check(
    "STATE-01",
    2,
    "Run and request identity deduplicate exact input and refuse changed content or collisions",
    "packages/kojo/tests/integration/contexts/workflow/admission.test.ts",
    "commits the pinned Run, queue entry, and receipt in one durable transaction",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/admission.test.ts",
        name: "keeps every JSON shape and deduplicates across revisions",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/ClientMutationBoundary.test.ts",
        name: "refuses replacement operation, target, arguments, or preconditions for one prepared ID",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/admission.test.ts",
        name: "refuses a Run-tuple collision without admitting a second Run",
      },
    ],
  ),
  check(
    "STATE-02",
    2,
    "request receipts and domain transitions survive interruption as one durable result",
    "packages/kojo/tests/integration/contexts/daemon/atomicReceipts.test.ts",
    "kills before commit and reopens with neither a receipt nor a Run transition",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/atomicReceipts.test.ts",
        name: "kills after commit but before reply and reopens the receipt with its full Run transition",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/atomicReceipts.test.ts",
        name: "kills after reply and reopens the same atomic receipt and Run transition",
      },
    ],
  ),
  check(
    "STATE-03",
    2,
    "Claims and slots change together and fence stale authority",
    "packages/kojo/tests/integration/contexts/workflow/claims.test.ts",
    "rejects a stale holder before a Phase result is stored",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/claims.test.ts",
        name: "allocates a Claim and Project slot together and fences stale writers",
      },
    ],
  ),
  check(
    "STATE-04",
    2,
    "Trigger acknowledgement follows durable admission and retry does not repeat execution",
    "packages/kojo/tests/integration/contexts/trigger/admission.test.ts",
    "records acknowledgement only with durable admission or duplicate detection",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/trigger/retryCycle.test.ts",
        name: "uses one bounded five-delay cycle and resets after source progress",
      },
    ],
  ),
  check(
    "GATE-01",
    2,
    "Deadline races use durable recording time and preserve the absolute Deadline",
    "packages/kojo/tests/integration/contexts/gate/deadline.test.ts",
    "keeps the absolute Deadline through restart and refuses an answer at it",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/gate/deadline.test.ts",
        name: "before the Deadline: records the Verdict and keeps it valid",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/gate/deadline.test.ts",
        name: "refuses exactly at the Deadline and schedules the declared expiry",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/gate/deadline.test.ts",
        name: "refuses after the Deadline and schedules the declared expiry",
      },
    ],
  ),
  check(
    "GATE-02",
    2,
    "Verdict recording stays distinct from application and preserves Asking identity",
    "packages/kojo/tests/integration/contexts/gate/application.test.ts",
    "keeps an on-time Verdict Recorded until a later fenced Runner marks it Applied",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/gate/application.test.ts",
        name: "keeps Recorded distinct, fences Applied, and makes repeated application idempotent",
      },
    ],
  ),
  check(
    "RUNNER-01",
    3,
    "the private Runner binds protocol and graph before Factory import",
    "packages/kojo-runtime/tests/integration/contexts/project/handshake.test.ts",
    "does not import Factory code before the Project and graph binding agrees",
    ["contract-runtime"],
    [
      {
        tier: "contract-runtime",
        path: "packages/kojo-runtime/tests/integration/contexts/project/handshake.test.ts",
        name: "refuses wrong protocol, graph, and scope before any Factory import",
      },
    ],
  ),
  check(
    "RUNNER-02",
    3,
    "fresh Runner processes execute the exact registration and separate same-name revisions",
    "packages/kojo-runtime/tests/integration/contexts/workflow/replay.test.ts",
    "routes same-name revisions exactly after it disposes one registration",
    ["contract-runtime"],
  ),
  check(
    "RUNNER-03",
    3,
    "recorded Phase results replay without repeating effects or inventing success",
    "packages/kojo-runtime/tests/integration/contexts/workflow/replay.test.ts",
    "keeps the Daemon Run ID and does not repeat a committed code Phase",
    ["contract-runtime"],
    [
      {
        tier: "contract-runtime",
        path: "packages/kojo-runtime/tests/unit/contexts/workflow/services/sandboxed.test.ts",
        name: "replays past the phases it already ran, and only rebuilds the sandbox",
      },
    ],
  ),
  check(
    "RUNNER-04",
    3,
    "replacement keeps the Run identity, wake-up, and original Deadline",
    "packages/kojo/tests/integration/cli/gateAndResume.test.ts",
    "resumes the same Run where it stopped, and re-runs nothing",
    ["contract-runtime", "kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/project/runnerRecovery.test.ts",
        name: "keeps the absolute replacement delay when a fresh Daemon owner restores the Run",
      },
      {
        tier: "contract-runtime",
        path: "packages/kojo-runtime/tests/integration/contexts/workflow/replay.test.ts",
        name: "replays an Applied Deferred after owner loss before Run completion without repeating work",
      },
    ],
  ),
  check(
    "RECOVER-01",
    4,
    "an uncertain external action stays held with durable intent and actual-count evidence",
    "packages/kojo/tests/integration/contexts/workflow/uncertainAction.test.ts",
    "holds an arbitrary action after its effect result is lost and consumes one exact retry authorization",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/project/recovery.test.ts",
        name: "does not let repair convert uncertain termination into safe evidence",
      },
    ],
  ),
  check(
    "RECOVER-02",
    4,
    "only exact uncertainty authorization can retry and no result is invented",
    "packages/kojo/tests/integration/contexts/workflow/uncertainAction.test.ts",
    "uses accepted result or not-performed evidence without duplicating the controlled effect",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/adapters/RunStatusCommand.test.ts",
        name: "requires the exact action ID, reason, and possible-duplication acknowledgement",
      },
    ],
  ),
  check(
    "RECOVER-03",
    4,
    "lost Resource acquisition and interrupted release reconcile provider truth",
    "packages/kojo/tests/integration/contexts/project/resourceDaemon.test.ts",
    "runs one controlled sandbox and agent through the private Runner after a lost acquisition-intent reply",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/project/adapters/InMemoryResourceLeaseRepository.test.ts",
        name: "keeps the acquisition identity inspectable after a lost reply",
        issueTiers: [],
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/project/resourceDaemon.test.ts",
        name: "runs one controlled sandbox and agent through the private Runner after a lost acquired-provider reply",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/project/resourceDaemon.test.ts",
        name: "runs one controlled sandbox and agent through the private Runner after a lost release reply",
      },
    ],
  ),
  check(
    "RECOVER-04",
    4,
    "unsafe worktrees and sessions are preserved and hold the Project",
    "packages/kojo/tests/integration/contexts/project/adapters/SqliteResourceLeaseRepository.test.ts",
    "fences a stale holder and preserves dirty and unresolved Resources",
    ["kojo-integration", "native-systemd"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/project/adapters/SqliteResourceLeaseRepository.test.ts",
        name: "requires the exact durable termination proof before bounded recovery",
      },
      {
        tier: "native-systemd",
        path: "packages/kojo/tests/host/contexts/daemon/service.test.ts",
        name: "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
      },
    ],
  ),
  check(
    "RECOVER-05",
    4,
    "old process-group stop is confirmed before replacement or slot reuse",
    "packages/kojo/tests/integration/contexts/project/runnerRecovery.test.ts",
    "confirms the crashed group stopped and continues the same Run in one replacement",
    ["kojo-integration", "native-systemd"],
    [
      {
        tier: "native-systemd",
        path: "packages/kojo/tests/host/contexts/daemon/service.test.ts",
        name: "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
      },
    ],
  ),
  check(
    "CANCEL-01",
    4,
    "cancellation races preserve execution truth and wait for confirmed process stop",
    "packages/kojo/tests/integration/contexts/workflow/cancel.test.ts",
    "lets the first durable terminal decision win the cancellation race",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/cancel.test.ts",
        name: "keeps cancellation intent distinct until the executing authority has stopped",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/cancel.test.ts",
        name: "cancels queued and suspended Runs without another Workflow execution",
      },
    ],
  ),
  check(
    "CANCEL-02",
    4,
    "forced Stop targets the accepted Workflow set and recovers siblings",
    "packages/kojo/tests/integration/contexts/workflow/forcedStop.test.ts",
    "force-stops the owned process group after the cooperative deadline and confirms before reply",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/cancel.test.ts",
        name: "freezes the forced Stop target set before a later Start",
        issueTiers: [],
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/cancel.test.ts",
        name: "cancels the target, recovers an interrupted sibling, and fences old writes",
      },
    ],
  ),
  check(
    "REV-01",
    3,
    "concurrent capture never exposes partial or different validated content",
    "packages/kojo/tests/integration/contexts/workflow/retainedPackages.test.ts",
    "publishes one complete identical Revision under concurrent capture",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/capture.test.ts",
        name: "uses sorted canonical objects, preserved arrays, and full SHA-256 identities",
      },
    ],
  ),
  check(
    "REV-02",
    4,
    "source, assets, links, resolution, and exact installed packages are retained",
    "packages/kojo/tests/integration/contexts/workflow/retainedPackages.test.ts",
    "materializes exact source, assets, packages, links, resolution, and Effect evidence",
    ["kojo-integration"],
  ),
  check(
    "REV-03",
    4,
    "retained execution does not substitute current Factory or registry content",
    "packages/kojo/tests/integration/contexts/workflow/runApi.test.ts",
    "executes one retained effect with the current Factory and packages removed and the registry unavailable",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/retainedPackages.test.ts",
        name: "materializes exact source, assets, packages, links, resolution, and Effect evidence",
      },
    ],
  ),
  check(
    "REV-04",
    4,
    "readers and registrations stay protected through disposal and the final-reference grace",
    "packages/kojo/tests/unit/contexts/workflow/collection.test.ts",
    "keeps a loaded registration protected until disposal evidence",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/revisionRepair.test.ts",
        name: "excludes new readers atomically, waits 24 hours, and keeps shared objects",
      },
    ],
  ),
  check(
    "REV-05",
    4,
    "missing or corrupt exact content holds dependents and repair refuses different bytes",
    "packages/kojo/tests/integration/contexts/workflow/revisionRepair.test.ts",
    "refuses identity or package substitution and restores only verified exact bytes",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/revisionRepair.test.ts",
        name: "keeps one damaged shared object fault local to dependent revisions",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
        name: "holds only the Run that needs damaged pinned content",
      },
    ],
  ),
  check(
    "SCHED-01",
    4,
    "accepted queue and fair scheduling defaults are enforced",
    "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
    "rotates Projects and enforces four Daemon and one Project execution slots",
    ["kojo-unit"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
        name: "keeps the accepted scheduling limits explicit",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
        name: "serves three oldest continuations and then one oldest new Run",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
        name: "releases the Project slot when a Run suspends",
      },
    ],
  ),
  check(
    "SCHED-02",
    4,
    "package switching follows order and restores only current Trigger polling",
    "packages/kojo/tests/integration/contexts/project/packageSwitch.test.ts",
    "stops polling and confirms the old process before it loads the selected graph",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/scheduling.test.ts",
        name: "keeps the older graph-switch Run ahead of newer matching-graph work",
        issueTiers: [],
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/runApi.test.ts",
        name: "stops all current Trigger polling before historical import and restores all checkpoints in one Runner",
      },
    ],
  ),
  check(
    "SCHED-03",
    4,
    "Workflow activity and idle Runner rules do not hold admitted work",
    "packages/kojo/tests/integration/contexts/workflow/activity.test.ts",
    "starts one Trigger poller without an immediate Run and repeats by receipt",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/project/services/runnerIdle.test.ts",
        name: "keeps execution, refresh, recovery, wake-up, and current Trigger polling busy",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/workflow/activity.test.ts",
        name: "ordinary Stop closes the poller and keeps an admitted Run eligible",
      },
    ],
  ),
  check(
    "SCHED-04",
    4,
    "Factory Refresh isolates faults and never admits stale Workflow content",
    "packages/kojo/tests/integration/contexts/workflow/discovery.test.ts",
    "isolates invalid siblings, holds admission, and keeps Removed revision history",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/shippedLinuxWorkflowObservation.test.ts",
        name: "waits while the controlled Workflow Factory Refresh is pending",
      },
    ],
  ),
  check(
    "PROJECT-01",
    4,
    "Project location identity, relocation, archive, and restore are explicit and durable",
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "requires explicit same-path confirmation and retains identity while locations change",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/project/services/registerProject.test.ts",
        name: "deduplicates a location and rejects changed content under one request ID",
      },
    ],
  ),
  check(
    "LOAD-01",
    4,
    "malformed and slow Runner peers cannot consume reserved control capacity",
    "packages/kojo/tests/integration/contexts/project/runnerChannel.test.ts",
    "backpressures a real slow peer while critical control keeps separate bounded capacity",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/project/runnerChannel.test.ts",
        name: "terminates only the malformed connection before oversized allocation",
      },
    ],
  ),
  check(
    "LOAD-02",
    5,
    "restart budgets persist and reset only after readiness and operation success",
    "packages/kojo/tests/integration/contexts/daemon/managedDaemonSupervision.test.ts",
    "persists five failed automatic attempts and exhaustion across launcher replacement",
    ["kojo-unit", "kojo-integration", "native-systemd"],
    [
      {
        tier: "native-systemd",
        path: "packages/kojo/tests/host/contexts/daemon/service.test.ts",
        name: "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/managedDaemonSupervision.test.ts",
        name: "resets only after readiness and an operation succeed, never from process lifetime or heartbeat",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/project/recovery.test.ts",
        name: "resets only after healthy time and a previously failed operation succeeds",
      },
    ],
  ),
  check(
    "LIFE-01",
    5,
    "native per-user lifecycle and singleton behavior pass on macOS and systemd Linux",
    "packages/kojo/tests/host/contexts/daemon/service.test.ts",
    "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
    ["native-systemd", "shipped-systemd", "shipped-macos"],
    [
      {
        tier: "shipped-systemd",
        path: "evidence.json",
        name: "replacement-and-access",
        issueTiers: [],
      },
      {
        tier: "shipped-macos",
        path: "RELEASE-01/evidence-manifest.json",
        name: "native lifecycle",
        issueTiers: [],
      },
    ],
  ),
  check(
    "LIFE-02",
    5,
    "planned drain outlives the client wait and force stays explicit",
    "packages/kojo/tests/unit/contexts/daemon/services/LifecycleController.test.ts",
    "leaves a timed-out operation pending for a replacement controller to resume",
    ["kojo-unit", "kojo-integration", "shipped-systemd", "shipped-macos"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/LifecycleController.test.ts",
        name: "uses a separate durable force identity and keeps an interrupted Run out of cancellation",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
        name: "reconnects one lifecycle operation through the production socket and observes the replacement owner",
      },
      {
        tier: "shipped-systemd",
        path: "evidence.json",
        name: "replacement-and-access",
        issueTiers: ["H"],
      },
      {
        tier: "shipped-macos",
        path: "RELEASE-01/evidence-manifest.json",
        name: "native lifecycle",
        issueTiers: ["H"],
      },
    ],
  ),
  check(
    "LIFE-03",
    5,
    "one lifecycle controller keeps the operation through endpoint and owner loss",
    "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
    "reconnects one lifecycle operation through the production socket and observes the replacement owner",
    ["kojo-integration", "native-systemd"],
    [
      {
        tier: "native-systemd",
        path: "packages/kojo/tests/host/contexts/daemon/service.test.ts",
        name: "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
      },
    ],
  ),
  check(
    "LIFE-04",
    5,
    "journal and activation receipts reconcile without controller database access",
    "packages/kojo/tests/integration/contexts/daemon/lifecycleJournal.test.ts",
    "releases runtime dispatch when replacement-ready receipt replay follows a crash",
    ["kojo-integration"],
  ),
  check(
    "LIFE-05",
    5,
    "incomplete or incompatible release evidence refuses activation",
    "packages/kojo/tests/integration/contexts/daemon/preflight.test.ts",
    "fails closed when retained candidate staging is incomplete",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/preflight.test.ts",
        name: "refuses corrupt or unknown retained evidence and a drain-time retained-set change",
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/ManagedUpgradePreflight.test.ts",
        name: "refuses a candidate protocol regression and keeps a corrupt retained fault scoped",
        issueTiers: [],
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/ManagedUpgradePreflight.test.ts",
        name: "refuses unknown evidence and recorded Bun or Host regressions",
        issueTiers: [],
      },
    ],
  ),
  check(
    "LIFE-06",
    5,
    "readiness and rollback outcomes stay distinct and recoverable",
    "packages/kojo/tests/integration/contexts/daemon/activation.test.ts",
    "holds ordinary mutations, verifies backup, migrates restricted, and activates without Workflow execution",
    ["kojo-unit", "kojo-integration", "native-systemd"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/UpgradeActivationController.test.ts",
        name: "uses one exact-source rollback before activation",
        issueTiers: [],
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/UpgradeActivationController.test.ts",
        name: "requires repair when current evidence cannot prove rollback safe",
        issueTiers: [],
      },
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/UpgradeActivationController.test.ts",
        name: "records Repair required from rollback-selected when source readiness fails",
        issueTiers: [],
      },
      {
        tier: "native-systemd",
        path: "packages/kojo/tests/host/contexts/daemon/service.test.ts",
        name: "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
      },
    ],
  ),
  check(
    "LIFE-07",
    5,
    "migration uses a verified backup and never erases newer accepted state",
    "packages/kojo/tests/integration/contexts/daemon/activation.test.ts",
    "holds ordinary mutations, verifies backup, migrates restricted, and activates without Workflow execution",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/upgradeActivationReceipt.test.ts",
        name: "commits the migration and its checkpoint in one transaction",
      },
    ],
  ),
  check(
    "LIFE-08",
    5,
    "replacement preserves data identity and renews process and browser authority",
    "packages/kojo/tests/integration/contexts/daemon/managedInstallation.test.ts",
    "retains Kojo, Bun, Console, a stable CLI, and a stable launcher without reinstall side effects",
    ["kojo-integration", "shipped-systemd", "shipped-macos"],
    [
      {
        tier: "shipped-systemd",
        path: "evidence.json",
        name: "shipped-managed-content",
        issueTiers: ["H"],
      },
      {
        tier: "shipped-macos",
        path: "RELEASE-01/evidence-manifest.json",
        name: "native lifecycle",
        issueTiers: ["H"],
      },
    ],
  ),
  check(
    "ACCESS-01",
    6,
    "private socket ownership and stale-path behavior pass on supported Hosts",
    "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
    "holds SQLite, the singleton, the Unix socket, and endpoint publication together",
    ["kojo-integration", "native-systemd", "shipped-macos"],
    [
      {
        tier: "native-systemd",
        path: "packages/kojo/tests/host/contexts/daemon/service.test.ts",
        name: "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
      },
      {
        tier: "shipped-macos",
        path: "RELEASE-01/evidence-manifest.json",
        name: "native lifecycle",
        issueTiers: [],
      },
    ],
  ),
  check(
    "ACCESS-02",
    6,
    "wrong Host or Origin and unauthenticated browser access are refused",
    "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
    "requires the exact Host, Origin, JSON body, and one-use grant",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
        name: "serves only bootstrap and active-release assets without session authority",
      },
    ],
  ),
  check(
    "ACCESS-03",
    6,
    "browser grants are one-use, bounded, and revoked on replacement",
    "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
    "authorizes one tab session for 12 hours and rejects cross-origin mutations",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
        name: "revokes old grants and sessions when a replacement reuses the port",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/browserSession.test.ts",
        name: "expires a grant after 60 seconds",
      },
    ],
  ),
  check(
    "ACCESS-04",
    6,
    "Artifact publication and browser display preserve safe exact bytes",
    "apps/console/tests/browser/artifact.spec.ts",
    "serves an Artifact only through authenticated bounded display and download responses",
    ["kojo-integration", "console-browser"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/trace/adapters/AtomicArtifactRepository.test.ts",
        name: "publishes only complete content with the declared size and digest",
      },
    ],
  ),
  check(
    "CLIENT-01",
    6,
    "lost client replies recover the original request without a second mutation",
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "retains exact requests, receipts, and Recent changes across a Daemon replacement",
    ["kojo-integration"],
    [...sqliteMutationOwnerEvidence.slice(1), ...hostMutationOwnerEvidence].map(
      ({ operation, owner, path, name }) => ({
        tier: "kojo-integration" as const,
        operation,
        owner,
        path,
        name,
      }),
    ),
    {
      operation: sqliteMutationOwnerEvidence[0]?.operation ?? "registerProject",
      owner: sqliteMutationOwnerEvidence[0]?.owner ?? "SqliteProjectRepository",
    },
  ),
  check(
    "CLIENT-02",
    6,
    "resolved full requests retain for 30 days then compact without becoming fresh work",
    "packages/kojo/tests/integration/contexts/daemon/adapters/HostClientRequestRepository.test.ts",
    "keeps full resolved content for 30 days then atomically compacts to identity and result references",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/workflow/admission.test.ts",
        name: "refuses changed content under one request identity",
      },
    ],
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
    "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
    "applies full Project selectors and JSON input while keeping output free of private payloads",
    ["kojo-integration"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
        name: "streams one versioned JSON Line per changed state through a real follow command",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
        name: "follows a request without an implicit deadline and uses text unless JSON is explicit",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
        name: "exits request follow with the in-progress code when the Daemon disconnects",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
        name: "returns exact usage, failure, wait-timeout, and success exits from real processes",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
        name: "authorizes only the exact uncertain Action through the real retry command",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/contexts/daemon/cliContract.test.ts",
        name: "returns exit 4 when Gate mutation transport fails after endpoint discovery",
      },
    ],
  ),
  check(
    "CLI-02",
    6,
    "maintenance plans expire and revalidate with no generic force",
    "packages/kojo/tests/integration/contexts/daemon/configurationRetention.test.ts",
    "revalidates concurrent state and collects only the disclosed safe evidence",
    ["kojo-unit", "kojo-integration"],
    [
      {
        tier: "kojo-unit",
        path: "packages/kojo/tests/unit/contexts/daemon/services/configuration.test.ts",
        name: "expires a data-bound retention plan after ten minutes",
      },
    ],
  ),
  check(
    "UI-01",
    6,
    "flat navigation and filtered Project, Workflow, Run, and Gate tables preserve links",
    "apps/console/tests/browser/projectCatalogue.spec.ts",
    "keeps flat resource navigation and durable links out of every Project row",
    ["console-browser"],
    [
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/projectCatalogue.spec.ts",
        name: "filters an authoritative Project grid and keeps stable URL selection",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/projectCatalogue.spec.ts",
        name: "paginates fifty filtered Projects and keeps the cursor in the URL",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/workflowCatalogue.spec.ts",
        name: "filters Workflow state and proves safe Trigger Start, Stop, force, and Run links",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/workflowCatalogue.spec.ts",
        name: "paginates the complete Workflow table and keeps its cursor in the URL",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/runConsole.spec.ts",
        name: "paginates and filters the complete Run table with durable URL state",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/gateVerdict.spec.ts",
        name: "defaults the Gate table to every status and keeps complete review links and states",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/gateVerdict.spec.ts",
        name: "paginates and filters every Gate state with durable URL state",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/gateVerdict.spec.ts",
        name: "records a Verdict with the Daemon OS user as Answerer",
      },
    ],
  ),
  check(
    "UI-02",
    6,
    "safe Daemon actions keep stale and Recorded or Applied states distinct",
    "apps/console/tests/browser/gateVerdict.spec.ts",
    "defaults the Gate table to every status and keeps complete review links and states",
    ["console-browser"],
    [
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/workflowCatalogue.spec.ts",
        name: "filters Workflow state and proves safe Trigger Start, Stop, force, and Run links",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/workflowCatalogue.spec.ts",
        name: "validates JSON before a no-Trigger Start and submits one accepted Run payload",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/reconnect.spec.ts",
        name: "bounds reconnect attempts, preserves the snapshot, and disables all mutations",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/runConsole.spec.ts",
        name: "requires acknowledgement and separates durable cancellation intent from confirmation",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/runConsole.spec.ts",
        name: "requires the exact Action ID, reason, and possible-duplication acknowledgement",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/runConsole.spec.ts",
        name: "shows an interrupted sibling as recovery and never as the cancelled target",
      },
    ],
  ),
  check(
    "UI-03",
    6,
    "the Console uses its Zaidan grids and filters at browser seams",
    "apps/console/tests/browser/daemonComponents.spec.ts",
    "uses Zaidan composition for every catalogue and keeps it keyboard-operable on narrow layouts",
    ["console-browser"],
    [
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/daemonComponents.spec.ts",
        name: "uses filtered Zaidan lists for Phases, Artifacts, and detail resources",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/daemonComponents.spec.ts",
        name: "reads Recent changes from durable Daemon history after reload and filters by request ID",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/waterfall.spec.ts",
        name: "a Phase panel shows Agent session, token, correction, and repository facts",
      },
      {
        tier: "console-browser",
        path: "apps/console/tests/browser/waterfall.spec.ts",
        name: "a Phase and its Sandbox acquisition remain one link apart",
      },
    ],
  ),
  check(
    "RELEASE-01",
    7,
    "fresh shipped installs follow printed supported commands without fixture repair",
    "packages/kojo/tests/release/freshInstall.test.ts",
    "follows the printed install and Factory path through native lifecycle and real browser evidence",
    ["shipped-systemd", "shipped-macos"],
  ),
  check(
    "RELEASE-02",
    7,
    "actual persisted records and absent optional wire fields render in the shipped Console",
    "apps/console/tests/release/shippedDaemon.spec.ts",
    "renders actual shipped Daemon records through one authenticated browser session",
    ["shipped-systemd", "shipped-macos"],
  ),
  check(
    "RELEASE-03",
    7,
    "managed Daemon, Console, recovery, and CLI work after global tool removal",
    "packages/kojo/tests/release/freshInstall.test.ts",
    "follows the printed install and Factory path through native lifecycle and real browser evidence",
    ["shipped-systemd", "shipped-macos"],
  ),
  check(
    "RELEASE-04",
    7,
    "old execution, storage, and spend paths are absent and guidance matches the shipped contract",
    "packages/kojo/tests/integration/release/contractCutover.test.ts",
    "ships no legacy execution path or client fallback",
    ["kojo-integration", "shipped-systemd"],
    [
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "keeps public guidance and package entry points on the one-Daemon release",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "fails when test support retains a legacy agent-spend policy helper",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "uses the positional Project path in every shipped or generated guidance file",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "propagates every piped CI test failure before evidence collection",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "uploads the hidden core release evidence from its exact collection path",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "uploads the hidden complete release evidence from its exact accepted path",
      },
      {
        tier: "kojo-integration",
        path: "packages/kojo/tests/integration/release/contractCutover.test.ts",
        name: "keeps Moon on the exact Bun version pinned for release evidence",
      },
    ],
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
    const result = line.match(/(?:^|\|)\s*([✓×↓])\s+(?:\d+\s+)?(.+)$/);
    if (result?.[1] !== undefined && result[2] !== undefined) {
      const body = result[2]
        .replace(/\s+\d+(?:\.\d+)?m?s\s*$/, "")
        .replace(/\s+\(\d+(?:\.\d+)?(?:ms|s|m)\)\s*$/, "");
      const path = body.match(
        /((?:packages|apps)\/[^ >›:]+\.(?:test|spec)\.ts|tests\/[^ >›:]+\.(?:test|spec)\.ts)/,
      )?.[1];
      if (path !== undefined) {
        const name = body
          .split(/\s+(?:>|›)\s+/)
          .at(-1)
          ?.trim();
        if (name === undefined || name.length === 0) continue;
        tests.push({
          path,
          name,
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
    const allocated = issue64RequiredTierAllocation[required.checkId];
    if (allocated === undefined) fail(`${required.checkId} has no immutable issue #64 allocation`);
    const declaredEvidenceTiers = new Set(required.tiers);
    const observedEvidenceTiers = new Set(
      required.observations.map((observation) => observation.tier),
    );
    if (
      declaredEvidenceTiers.size !== required.tiers.length ||
      observedEvidenceTiers.size !== declaredEvidenceTiers.size ||
      [...declaredEvidenceTiers].some((tier) => !observedEvidenceTiers.has(tier))
    ) {
      fail(`${required.checkId} does not declare exact observations for every evidence log`);
    }
    const requiredTiers = new Set<Issue64Tier>(allocated);
    const observedTiers = new Set(required.observations.flatMap(issueTiersForObservation));
    if (
      requiredTiers.size !== allocated.length ||
      observedTiers.size !== requiredTiers.size ||
      [...requiredTiers].some((tier) => !observedTiers.has(tier))
    ) {
      fail(`${required.checkId} does not declare exact observations for its issue #64 allocation`);
    }
    const observationKeys = required.observations.map(
      (observation) =>
        `${observation.tier}\0${observation.operation ?? ""}\0${observation.owner ?? ""}\0${observation.path}\0${observation.name}`,
    );
    if (new Set(observationKeys).size !== observationKeys.length) {
      fail(`${required.checkId} declares a duplicate observation`);
    }
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
          test.name === observation.name,
      );
      if (matching.length !== 1) {
        fail(`${required.checkId} did not load named observation ${observation.name}`);
      }
      if (matching.some((test) => test.status !== "passed")) {
        fail(`${required.checkId} named observation ${observation.name} did not pass`);
      }
      return {
        tier: observation.tier,
        testedRevision: receipt.testedRevision,
        environment: receipt.environment,
        loaded: 1,
        passed: matching[0]?.status === "passed" ? 1 : 0,
        skipped: matching[0]?.status === "skipped" ? 1 : 0,
        namedSkips: matching[0]?.status === "skipped" ? [matching[0].name] : [],
        cacheHit: receipt.cacheHit,
        log: receipt.log,
        tests: matching,
        ...(observation.operation === undefined ? {} : { operation: observation.operation }),
        ...(observation.owner === undefined ? {} : { owner: observation.owner }),
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
  const allocatedIds = Object.keys(issue64RequiredTierAllocation);
  if (allocatedIds.length !== ids.size || allocatedIds.some((checkId) => !ids.has(checkId))) {
    fail("the immutable issue #64 allocation and required checks differ");
  }
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
