import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import { Console, Duration, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { clientExit } from "../../../cli/ClientExit.ts";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import { timeoutMillis as parseTimeoutMillis } from "../../workflow/adapters/WorkflowCommand.ts";
import { FileLifecycleJournalRepository } from "../adapters/FileLifecycleJournalRepository.ts";
import { SocketDaemonUpgradeControl } from "../adapters/LifecycleControlTransport.ts";
import { macLaunchAgent } from "../adapters/MacLaunchAgent.ts";
import {
  managedReleaseSelection,
  readCheckedManagedRelease,
  stageManagedRelease,
} from "../adapters/ManagedInstallation.ts";
import { prepareHostClientRequest } from "../adapters/prepareHostClientRequest.ts";
import { systemdUserService } from "../adapters/SystemdUserService.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import {
  decodeUpgradeCheckReport,
  decodeUpgradeCheckResult,
  type UpgradeCheckReport,
  type UpgradeCheckResult,
} from "../models/ManagedUpgrade.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { readDaemonEndpoint } from "../services/daemonStatus.ts";
import { hostPaths } from "../services/hostPaths.ts";
import { assertPrivateNode } from "../services/secureHostPath.ts";
import {
  UpgradeActivationController,
  type UpgradeActivationStatus,
} from "../services/UpgradeActivationController.ts";
import { plannedLifecycleResume } from "../use-cases/resumeLifecycleOperation.ts";
import { daemonCommandLine, upgradeStatusLines } from "./DaemonCommandPresentation.ts";

interface ProductionUpgradeController {
  readonly paths: DaemonPaths;
  readonly journal: FileLifecycleJournalRepository;
  readonly controller: UpgradeActivationController;
}

const nativeService = (): NativeService => {
  if (process.platform === "darwin") return macLaunchAgent();
  if (process.platform === "linux") return systemdUserService();
  throw new LifecycleError("UNSUPPORTED_HOST", "Kojo supports macOS and systemd Linux Hosts");
};
const productionUpgradeController = (): ProductionUpgradeController => {
  const paths = hostPaths();
  const journal = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
  return {
    paths,
    journal,
    controller: new UpgradeActivationController({
      journal,
      control: new SocketDaemonUpgradeControl(paths.runtimeRoot, journal),
      nativeService: nativeService(),
      releases: managedReleaseSelection(paths),
      serviceDefinition: paths.serviceDefinition,
      observedDaemonInstanceId: () => readDaemonEndpoint(paths)?.instanceId,
    }),
  };
};

const printUpgradeStatus = (report: UpgradeCheckReport): Effect.Effect<void> =>
  Effect.forEach(upgradeStatusLines(report), (statusLine) => Console.log(statusLine), {
    discard: true,
  });

const printUpgradeActivationStatus = (status: UpgradeActivationStatus): Effect.Effect<void> =>
  Effect.forEach(
    [
      daemonCommandLine("Managed upgrade operation", status.operation.operationId),
      daemonCommandLine("Managed upgrade outcome", status.outcome),
      daemonCommandLine("Managed upgrade stage", status.operation.stage),
      daemonCommandLine("Managed upgrade next action", status.nextPermittedAction),
    ],
    (statusLine) => Console.log(statusLine),
    { discard: true },
  );

const requestHash = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

const parsedTimeout = (text: string) =>
  Effect.try({
    try: () => parseTimeoutMillis(text),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(Effect.catch((message) => clientExit(2, message)));

const lifecycleTry = <A>(body: () => A): Effect.Effect<A, LifecycleError> =>
  Effect.try({
    try: body,
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "LIFECYCLE_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  });

const upgradeRequest = (
  paths: DaemonPaths,
  candidateReleaseId: string,
  approvalToken?: string,
): Effect.Effect<UpgradeCheckResult, LifecycleError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(paths);
      if (endpoint === undefined) {
        throw new LifecycleError(
          "DAEMON_NOT_READY",
          "the Daemon is not ready; start it before managed upgrade preflight",
        );
      }
      const mutation: MutationEnvelope = {
        mutationVersion: 1,
        requestId: crypto.randomUUID(),
        dataIdentity: endpoint.dataIdentity,
        operation: "checkDaemonUpgrade",
        target: { identityVersion: 1, kind: "daemonData", parts: [endpoint.dataIdentity] },
        arguments: {
          candidateReleaseId,
          ...(approvalToken === undefined ? {} : { approvalToken }),
        },
        preconditions: {},
      };
      prepareHostClientRequest(paths, mutation);
      const response = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
        unix: endpoint.socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation),
      } as RequestInit & { readonly unix: string });
      const value = (await response.json()) as unknown;
      if (!response.ok) {
        const fault = value as { readonly code?: unknown; readonly message?: unknown };
        throw new LifecycleError(
          typeof fault.code === "string" ? fault.code : "UPGRADE_PREFLIGHT_FAILED",
          typeof fault.message === "string" ? fault.message : "managed upgrade preflight failed",
        );
      }
      return decodeUpgradeCheckResult(value);
    },
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "UPGRADE_PREFLIGHT_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  });

const latestUpgrade = (
  paths: DaemonPaths,
): Effect.Effect<UpgradeCheckReport | undefined, LifecycleError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(paths);
      if (endpoint === undefined) return undefined;
      const response = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
        unix: endpoint.socketPath,
      } as RequestInit & { readonly unix: string });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new LifecycleError(
          "UPGRADE_STATUS_FAILED",
          "the Daemon refused the managed upgrade status read",
        );
      }
      return decodeUpgradeCheckReport(await response.json());
    },
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "UPGRADE_STATUS_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  });

const activateUpgrade = (
  version: string,
  pending: Option.Option<string>,
  force: boolean,
  timeoutMillis: number | undefined,
) =>
  Effect.gen(function* () {
    const managed = yield* lifecycleTry(productionUpgradeController).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    let operationId: string;
    let activation: Effect.Effect<UpgradeActivationStatus, LifecycleError>;
    if (force) {
      if (Option.isNone(pending)) {
        return yield* clientExit(2, "explicit force requires --pending REQUEST_ID");
      }
      operationId = pending.value;
      const operation = yield* lifecycleTry(() => managed.journal.read(operationId)).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      if (
        operation === undefined ||
        operation.kind !== "upgrade" ||
        operation.candidateReleaseId === undefined
      ) {
        return yield* clientExit(2, "--pending must name a pending upgrade operation");
      }
      const candidate = yield* lifecycleTry(() =>
        readCheckedManagedRelease(managed.paths, operation.candidateReleaseId as string),
      ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
      if (candidate.kojoVersion !== version) {
        return yield* clientExit(
          2,
          `the pending upgrade names Kojo ${candidate.kojoVersion}, not requested ${version}`,
        );
      }
      const authorization =
        (yield* lifecycleTry(() => managed.journal.forceAuthorizationFor(operationId))) ??
        ({
          formatVersion: 1,
          authorizationId: crypto.randomUUID(),
          pendingOperationId: operationId,
          requestHash: requestHash({ operation: "force-upgrade", pendingOperationId: operationId }),
          authorizedAt: new Date().toISOString(),
        } as const);
      activation = managed.controller.force(authorization);
    } else {
      const resumable = yield* lifecycleTry(() =>
        plannedLifecycleResume(
          managed.journal,
          "upgrade",
          Option.isSome(pending) ? pending.value : undefined,
        ),
      ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
      if (resumable !== undefined) {
        if (resumable.candidateReleaseId === undefined) {
          return yield* commandFailed("the pending upgrade has no candidate release");
        }
        const candidate = yield* lifecycleTry(() =>
          readCheckedManagedRelease(managed.paths, resumable.candidateReleaseId as string),
        ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
        if (candidate.kojoVersion !== version) {
          return yield* clientExit(
            2,
            `the pending upgrade names Kojo ${candidate.kojoVersion}, not requested ${version}`,
          );
        }
        operationId = resumable.operationId;
        activation = managed.controller.resume(operationId);
      } else {
        const report = yield* latestUpgrade(managed.paths).pipe(
          Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
        );
        if (report === undefined || report.outcome !== "staged") {
          return yield* commandFailed(
            "activation requires a matching staged check; use --check for this exact release",
          );
        }
        const candidate = yield* lifecycleTry(() =>
          readCheckedManagedRelease(managed.paths, report.candidateReleaseId),
        ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
        if (candidate.kojoVersion !== version) {
          return yield* commandFailed(
            `the staged check names Kojo ${candidate.kojoVersion}, not requested ${version}`,
          );
        }
        const activeReleaseId = yield* lifecycleTry(() =>
          managedReleaseSelection(managed.paths).read(),
        ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
        if (activeReleaseId !== report.sourceReleaseId) {
          return yield* commandFailed(
            "the active release changed after the staged check; repeat --check",
          );
        }
        operationId = crypto.randomUUID();
        activation = managed.controller.request({
          operationId,
          dataIdentity: report.dataIdentity,
          originalRequestHash: requestHash({
            operation: "upgrade",
            sourceReleaseId: report.sourceReleaseId,
            candidateReleaseId: report.candidateReleaseId,
            checkedRetainedSetHash: report.retainedSetHash,
          }),
          kind: "upgrade",
          sourceReleaseId: report.sourceReleaseId,
          candidateReleaseId: report.candidateReleaseId,
          checkedRetainedSetHash: report.retainedSetHash,
          startedAt: new Date().toISOString(),
        });
      }
    }
    const observed = yield* (
      timeoutMillis === undefined
        ? activation.pipe(Effect.map(Option.some))
        : activation.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis)))
    ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
    if (Option.isNone(observed)) {
      return yield* clientExit(
        3,
        `managed upgrade ${operationId} is still pending; timeout did not force or cancel it`,
      );
    }
    yield* printUpgradeActivationStatus(observed.value);
    if (observed.value.outcome !== "activated") {
      return yield* clientExit(1, `managed upgrade outcome: ${observed.value.outcome}`);
    }
  });

export const daemonUpgradeCommand = Command.make(
  "upgrade",
  {
    version: Flag.string("version"),
    check: Flag.boolean("check"),
    approveNoRollback: Flag.string("approve-no-rollback").pipe(Flag.optional),
    force: Flag.boolean("force"),
    pending: Flag.string("pending").pipe(Flag.optional),
    timeout: Flag.string("timeout").pipe(Flag.withDefault("60s")),
  },
  Effect.fn(function* ({ version, check, approveNoRollback, force, pending, timeout }) {
    if (!check) {
      if (Option.isSome(approveNoRollback)) {
        return yield* clientExit(2, "--approve-no-rollback requires --check");
      }
      const milliseconds = yield* parsedTimeout(timeout);
      return yield* activateUpgrade(version, pending, force, milliseconds);
    }
    if (force || Option.isSome(pending)) {
      return yield* clientExit(2, "--force and --pending apply to activation, not --check");
    }
    const paths = yield* lifecycleTry(hostPaths).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    let candidateReleaseId: string;
    if (Option.isSome(approveNoRollback)) {
      const recorded = yield* latestUpgrade(paths).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      if (
        recorded === undefined ||
        recorded.plan === undefined ||
        (recorded.outcome !== "approval-required" &&
          !(recorded.outcome === "staged" && recorded.rollbackApproval === "approved"))
      ) {
        return yield* commandFailed(
          "no recorded no-rollback plan is waiting; repeat --check for the exact candidate",
        );
      }
      const retained = yield* lifecycleTry(() =>
        readCheckedManagedRelease(paths, recorded.candidateReleaseId),
      ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
      if (retained.kojoVersion !== version) {
        return yield* commandFailed(
          `the approval plan names Kojo ${retained.kojoVersion}, not requested ${version}`,
        );
      }
      candidateReleaseId = retained.releaseId;
    } else {
      const activePath = join(paths.installationRoot, "active-release");
      const sourceReleaseId = yield* lifecycleTry(() => {
        assertPrivateNode(activePath, "file");
        return readFileSync(activePath, "utf8").trim();
      }).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
      const candidate = yield* stageManagedRelease({ paths, expectedVersion: version }).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      const activeAfterStage = yield* lifecycleTry(() => readFileSync(activePath, "utf8").trim());
      if (activeAfterStage !== sourceReleaseId) {
        return yield* commandFailed(
          "the active release changed while staging; repeat the check against the new source release",
        );
      }
      candidateReleaseId = candidate.releaseId;
    }
    const result = yield* upgradeRequest(
      paths,
      candidateReleaseId,
      Option.isSome(approveNoRollback) ? approveNoRollback.value : undefined,
    ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
    yield* printUpgradeStatus(result.report);
    if (result.approvalToken !== undefined) {
      yield* Console.log(
        `Approval token: ${result.approvalToken}. Use --approve-no-rollback with this exact candidate only after review.`,
      );
    }
    if (result.report.outcome !== "staged") {
      return yield* clientExit(1, `managed upgrade check outcome: ${result.report.outcome}`);
    }
  }),
).pipe(
  Command.withDescription(
    "Stage and check one exact managed release without drain, download, package change, or Workflow execution",
  ),
);
