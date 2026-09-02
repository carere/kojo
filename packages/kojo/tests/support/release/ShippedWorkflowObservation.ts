import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_INPUT_SCAN_INTERVAL_MILLIS } from "../../../src/contexts/workflow/models/FactoryRefresh.ts";

export interface ShippedWorkflowObservation {
  readonly ready: boolean;
  readonly diagnostic: string;
  readonly snapshot?: Record<string, unknown>;
  readonly candidate?: {
    readonly instanceId: string;
    readonly dataIdentity: string;
    readonly revisionId: string;
    readonly packageGraphId: string;
    readonly refreshAfterMillis: number;
  };
}

export interface ShippedWorkflowStability {
  readonly identity?: {
    readonly instanceId: string;
    readonly dataIdentity: string;
    readonly revisionId: string;
    readonly packageGraphId: string;
  };
  readonly currentSinceMillis?: number;
  readonly consecutiveCurrent: number;
  readonly stableForMillis: number;
  readonly requiredStableMillis: number;
  readonly accepted: boolean;
  readonly fact: "not-current" | "candidate-started" | "candidate-continuing" | "unavailable";
}

interface BoundedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMillis: number;
  readonly terminationSent: boolean;
  readonly hardKillSent: boolean;
}

export interface ObserveShippedWorkflowOptions {
  readonly command: ReadonlyArray<string>;
  readonly evidenceDirectory: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly timeoutMillis: number;
  readonly commandTimeoutMillis?: number;
  readonly hardKillAfterMillis?: number;
  readonly finalizationReserveMillis?: number;
  readonly delayMillis?: number;
  readonly stabilityWindowMillis?: number;
}

export interface ObserveShippedWorkflowResult {
  readonly ready: boolean;
  readonly attempts: number;
  readonly elapsedMillis: number;
}

export interface FailedShippedWorkflowObservation {
  readonly evidenceDirectory: string;
  readonly readiness: string;
  readonly observerExitCode: number;
}

export const shippedWorkflowObservationBounds = {
  internalTimeoutMillis: 110_000,
  observerTerminateAfterSeconds: 114,
  observerKillAfterSeconds: 1,
  classifierTerminateAfterSeconds: 4,
  classifierKillAfterSeconds: 1,
  totalBoundMillis: 120_000,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);

const unavailableShippedWorkflowStability = (): ShippedWorkflowStability => ({
  consecutiveCurrent: 0,
  stableForMillis: 0,
  requiredStableMillis: FACTORY_INPUT_SCAN_INTERVAL_MILLIS,
  accepted: false,
  fact: "unavailable",
});

export const replaceFailedShippedWorkflowObservation = (
  failure: FailedShippedWorkflowObservation,
): void => {
  const finalPath = join(
    failure.evidenceDirectory,
    "bounded-factory-refresh-observation-final.json",
  );
  const partialFinalPath = join(
    failure.evidenceDirectory,
    "bounded-factory-refresh-observer-partial-final.json",
  );
  const summaryPath = join(failure.evidenceDirectory, "bounded-factory-refresh-observation.log");
  let partialFinal: unknown;
  if (existsSync(finalPath)) {
    const raw = readFileSync(finalPath, "utf8");
    writeFileSync(partialFinalPath, raw);
    try {
      partialFinal = JSON.parse(raw);
    } catch {
      partialFinal = { invalidJson: raw };
    }
  }
  const stability =
    isRecord(partialFinal) && isRecord(partialFinal.stability)
      ? partialFinal.stability
      : unavailableShippedWorkflowStability();
  writeJson(finalPath, {
    kind: "bounded-read-only-factory-refresh",
    readiness: failure.readiness,
    strictOperationBoundMillis: 120_000,
    observerExitCode: failure.observerExitCode,
    noRepairReregisterRestartOrStart: true,
    stability,
    partialFinal,
  });
  writeFileSync(
    summaryPath,
    [
      "FactoryRefreshObservation=bounded-read-only",
      `FactoryRefreshReadiness=${failure.readiness}`,
      "StrictOperationBoundMillis=120000",
      `ObserverExitCode=${failure.observerExitCode}`,
      "NoRepairReregisterRestartOrStart=yes",
      `FinalEvidence=${finalPath}`,
      partialFinal === undefined ? undefined : `PartialFinalEvidence=${partialFinalPath}`,
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
};

export const shippedWorkflowObservation = (
  output: string,
  projectId: string,
  workflowName: string,
): ShippedWorkflowObservation => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch (cause) {
    return {
      ready: false,
      diagnostic: `Workflow observation is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.workflows)) {
    return { ready: false, diagnostic: "Workflow observation has no Workflow collection" };
  }
  const matches = decoded.workflows.filter(
    (workflow): workflow is Record<string, unknown> =>
      isRecord(workflow) &&
      workflow.projectId === projectId &&
      workflow.workflowName === workflowName,
  );
  const workflow = matches[0];
  if (matches.length !== 1 || workflow === undefined) {
    return {
      ready: false,
      diagnostic: `expected one ${workflowName} Workflow for Project ${projectId}; observed ${matches.length}`,
      snapshot: decoded,
    };
  }
  const diagnostic = [
    `Project ${String(workflow.projectState)}`,
    `Factory ${String(workflow.factoryState)}`,
    `Factory Refresh ${String(workflow.refreshState)}`,
    `Workflow ${String(workflow.availability)}`,
  ].join(", ");
  const candidate =
    nonEmptyString(decoded.instanceId) &&
    nonEmptyString(decoded.dataIdentity) &&
    Number.isSafeInteger(decoded.refreshAfterMillis) &&
    Number(decoded.refreshAfterMillis) > 0 &&
    nonEmptyString(workflow.currentRevisionId) &&
    nonEmptyString(workflow.currentPackageGraphId)
      ? {
          instanceId: decoded.instanceId,
          dataIdentity: decoded.dataIdentity,
          revisionId: workflow.currentRevisionId,
          packageGraphId: workflow.currentPackageGraphId,
          refreshAfterMillis: Number(decoded.refreshAfterMillis),
        }
      : undefined;
  return {
    ready:
      workflow.projectState === "available" &&
      workflow.factoryState === "available" &&
      workflow.refreshState === "current" &&
      workflow.availability === "available" &&
      candidate !== undefined,
    diagnostic,
    snapshot: decoded,
    ...(candidate === undefined ? {} : { candidate }),
  };
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const candidateIdentity = (
  candidate: NonNullable<ShippedWorkflowObservation["candidate"]>,
): NonNullable<ShippedWorkflowStability["identity"]> => ({
  instanceId: candidate.instanceId,
  dataIdentity: candidate.dataIdentity,
  revisionId: candidate.revisionId,
  packageGraphId: candidate.packageGraphId,
});

const sameCandidate = (
  left: ShippedWorkflowStability["identity"],
  right: NonNullable<ShippedWorkflowStability["identity"]>,
): boolean =>
  left?.instanceId === right.instanceId &&
  left.dataIdentity === right.dataIdentity &&
  left.revisionId === right.revisionId &&
  left.packageGraphId === right.packageGraphId;

export const advanceShippedWorkflowStability = (
  prior: ShippedWorkflowStability | undefined,
  observation: ShippedWorkflowObservation,
  observedAtMillis: number,
  requiredStableMillis = FACTORY_INPUT_SCAN_INTERVAL_MILLIS +
    (observation.candidate?.refreshAfterMillis ?? 0),
): ShippedWorkflowStability => {
  if (!observation.ready || observation.candidate === undefined) {
    return {
      consecutiveCurrent: 0,
      stableForMillis: 0,
      requiredStableMillis,
      accepted: false,
      fact: "not-current",
    };
  }
  const identity = candidateIdentity(observation.candidate);
  const continuing =
    sameCandidate(prior?.identity, identity) && prior?.currentSinceMillis !== undefined;
  const currentSinceMillis = continuing ? prior.currentSinceMillis : observedAtMillis;
  const consecutiveCurrent = continuing ? prior.consecutiveCurrent + 1 : 1;
  const stableForMillis = Math.max(0, observedAtMillis - currentSinceMillis);
  return {
    identity,
    currentSinceMillis,
    consecutiveCurrent,
    stableForMillis,
    requiredStableMillis,
    accepted: consecutiveCurrent >= 2 && stableForMillis >= requiredStableMillis,
    fact: continuing ? "candidate-continuing" : "candidate-started",
  };
};

const runBoundedCommand = async (
  command: ReadonlyArray<string>,
  terminateAfterMillis: number,
  hardKillAfterMillis: number,
): Promise<BoundedCommandResult> => {
  const startedAt = Date.now();
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let terminationSent = false;
  let hardKillSent = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminationTimer = setTimeout(() => {
    terminationSent = true;
    child.kill("SIGTERM");
    hardKillTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      hardKillSent = true;
      child.kill("SIGKILL");
    }, hardKillAfterMillis);
  }, terminateAfterMillis);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(terminationTimer);
  if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
  return {
    exitCode,
    stdout,
    stderr,
    elapsedMillis: Date.now() - startedAt,
    terminationSent,
    hardKillSent,
  };
};

export const observeShippedWorkflow = async (
  options: ObserveShippedWorkflowOptions,
): Promise<ObserveShippedWorkflowResult> => {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMillis;
  const commandTimeoutMillis = options.commandTimeoutMillis ?? 10_000;
  const hardKillAfterMillis = options.hardKillAfterMillis ?? 1_000;
  const finalizationReserveMillis = options.finalizationReserveMillis ?? 500;
  const observations = join(options.evidenceDirectory, "bounded-factory-refresh-observations");
  const finalPath = join(
    options.evidenceDirectory,
    "bounded-factory-refresh-observation-final.json",
  );
  const summaryPath = join(options.evidenceDirectory, "bounded-factory-refresh-observation.log");
  mkdirSync(observations, { recursive: true });
  let attempts = 0;
  let lastAttempt: Record<string, unknown> | undefined;
  let lastSnapshotPath: string | undefined;
  let stability: ShippedWorkflowStability | undefined;

  while (Date.now() + hardKillAfterMillis + finalizationReserveMillis < deadline) {
    attempts += 1;
    const attemptName = String(attempts).padStart(3, "0");
    const snapshotPath = join(observations, `${attemptName}-workflow-list.json`);
    const stderrPath = join(observations, `${attemptName}-workflow-list.stderr.log`);
    const decodedPath = join(observations, `${attemptName}-decoded.json`);
    const attemptPath = join(observations, `${attemptName}-attempt.json`);
    const remainingMillis = deadline - Date.now();
    const terminateAfterMillis = Math.max(
      1,
      Math.min(
        commandTimeoutMillis,
        remainingMillis - hardKillAfterMillis - finalizationReserveMillis,
      ),
    );
    const command = [
      ...options.command,
      "workflow",
      "list",
      "--project",
      options.projectId,
      "--json",
    ];
    const result = await runBoundedCommand(command, terminateAfterMillis, hardKillAfterMillis);
    const readiness =
      result.exitCode === 0
        ? shippedWorkflowObservation(result.stdout, options.projectId, options.workflowName)
        : {
            ready: false,
            diagnostic: result.hardKillSent
              ? "Workflow observation ignored TERM and received KILL"
              : `workflow list exited ${result.exitCode}: ${result.stderr.trim()}`,
          };
    stability = advanceShippedWorkflowStability(
      stability,
      readiness,
      Date.now(),
      options.stabilityWindowMillis ??
        FACTORY_INPUT_SCAN_INTERVAL_MILLIS + (readiness.candidate?.refreshAfterMillis ?? 0),
    );
    writeFileSync(snapshotPath, result.stdout);
    writeFileSync(stderrPath, result.stderr);
    writeJson(decodedPath, readiness);
    lastAttempt = {
      observation: attempts,
      kind: "bounded-read-only-factory-refresh",
      command,
      exitCode: result.exitCode,
      commandTimeoutMillis: terminateAfterMillis,
      hardKillAfterMillis,
      elapsedMillis: result.elapsedMillis,
      terminationSent: result.terminationSent,
      hardKillSent: result.hardKillSent,
      noRepairReregisterRestartOrStart: true,
      readiness,
      stability,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    writeJson(attemptPath, lastAttempt);
    lastSnapshotPath = snapshotPath;
    if (
      result.exitCode === 0 &&
      readiness.ready &&
      readiness.snapshot !== undefined &&
      stability.accepted
    ) {
      writeJson(finalPath, {
        kind: "bounded-read-only-factory-refresh",
        readiness: "current",
        timeoutMillis: options.timeoutMillis,
        attempts,
        noRepairReregisterRestartOrStart: true,
        finalAttempt: lastAttempt,
        stability,
      });
      copyFileSync(snapshotPath, join(options.evidenceDirectory, "workflow-list.json"));
      writeFileSync(
        summaryPath,
        [
          "FactoryRefreshObservation=bounded-read-only",
          "FactoryRefreshReadiness=current",
          `TimeoutMillis=${options.timeoutMillis}`,
          `Attempts=${attempts}`,
          `ConsecutiveCurrent=${stability.consecutiveCurrent}`,
          `StableForMillis=${stability.stableForMillis}`,
          `RequiredStableMillis=${stability.requiredStableMillis}`,
          "NoRepairReregisterRestartOrStart=yes",
          `FinalEvidence=${finalPath}`,
          "",
        ].join("\n"),
      );
      return { ready: true, attempts, elapsedMillis: Date.now() - startedAt };
    }
    const delay = Math.min(
      options.delayMillis ?? readiness.candidate?.refreshAfterMillis ?? 1_000,
      Math.max(0, deadline - Date.now() - hardKillAfterMillis - finalizationReserveMillis),
    );
    if (delay > 0) await Bun.sleep(delay);
  }

  writeJson(finalPath, {
    kind: "bounded-read-only-factory-refresh",
    readiness: "timed-out",
    timeoutMillis: options.timeoutMillis,
    attempts,
    noRepairReregisterRestartOrStart: true,
    lastAttempt,
    stability: stability ?? unavailableShippedWorkflowStability(),
  });
  if (lastSnapshotPath !== undefined) {
    copyFileSync(lastSnapshotPath, join(options.evidenceDirectory, "workflow-list.json"));
  }
  writeFileSync(
    summaryPath,
    [
      "FactoryRefreshObservation=bounded-read-only",
      "FactoryRefreshReadiness=timed-out",
      `TimeoutMillis=${options.timeoutMillis}`,
      `Attempts=${attempts}`,
      "NoRepairReregisterRestartOrStart=yes",
      `FinalEvidence=${finalPath}`,
      "",
    ].join("\n"),
  );
  return { ready: false, attempts, elapsedMillis: Date.now() - startedAt };
};

if (import.meta.main) {
  const operation = process.argv[2];
  if (operation === "bounds") {
    process.stdout.write(`${JSON.stringify(shippedWorkflowObservationBounds)}\n`);
    process.exit(0);
  }
  if (operation === "classify-failure") {
    const evidenceDirectory = process.argv[3];
    const readiness = process.argv[4];
    const observerExitCode = Number(process.argv[5]);
    if (
      evidenceDirectory === undefined ||
      readiness === undefined ||
      !Number.isSafeInteger(observerExitCode)
    ) {
      throw new Error(
        "usage: ShippedWorkflowObservation.ts classify-failure EVIDENCE_DIRECTORY READINESS OBSERVER_EXIT_CODE",
      );
    }
    replaceFailedShippedWorkflowObservation({
      evidenceDirectory,
      readiness,
      observerExitCode,
    });
    process.exit(0);
  }
  const command = process.argv[3];
  const evidenceDirectory = process.argv[4];
  const projectId = process.argv[5];
  const workflowName = process.argv[6];
  const timeoutMillis = Number(process.argv[7]);
  if (
    operation !== "observe" ||
    command === undefined ||
    evidenceDirectory === undefined ||
    projectId === undefined ||
    workflowName === undefined ||
    !Number.isSafeInteger(timeoutMillis) ||
    timeoutMillis <= 0
  ) {
    throw new Error(
      "usage: ShippedWorkflowObservation.ts observe KOJO EVIDENCE_DIRECTORY PROJECT_ID WORKFLOW_NAME TIMEOUT_MILLIS",
    );
  }
  const result = await observeShippedWorkflow({
    command: [command],
    evidenceDirectory,
    projectId,
    workflowName,
    timeoutMillis,
  });
  process.exitCode = result.ready ? 0 : 1;
}
