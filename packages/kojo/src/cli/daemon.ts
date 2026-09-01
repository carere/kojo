import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Console, Duration, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FileLifecycleJournalRepository } from "../contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import {
  SocketDaemonLifecycleControl,
  SocketDaemonUpgradeControl,
} from "../contexts/daemon/adapters/LifecycleControlTransport.ts";
import { macLaunchAgent } from "../contexts/daemon/adapters/MacLaunchAgent.ts";
import {
  type DaemonSupervisionStatus,
  ManagedDaemonSupervision,
} from "../contexts/daemon/adapters/ManagedDaemonSupervision.ts";
import {
  managedReleaseSelection,
  readCheckedManagedRelease,
  stageManagedRelease,
} from "../contexts/daemon/adapters/ManagedInstallation.ts";
import { systemdUserService } from "../contexts/daemon/adapters/SystemdUserService.ts";
import type {
  ConfigurationApplyResult,
  ConfigurationCheck,
  ConfigurationStatus,
} from "../contexts/daemon/models/Configuration.ts";
import type { DaemonPaths } from "../contexts/daemon/models/DaemonPaths.ts";
import type { DaemonStatus } from "../contexts/daemon/models/DaemonStatus.ts";
import { LifecycleError } from "../contexts/daemon/models/LifecycleError.ts";
import type {
  LifecycleOperationKind,
  LifecycleOperationStatus,
} from "../contexts/daemon/models/LifecycleOperation.ts";
import {
  decodeUpgradeCheckReport,
  decodeUpgradeCheckResult,
  type UpgradeCheckReport,
  type UpgradeCheckResult,
} from "../contexts/daemon/models/ManagedUpgrade.ts";
import type { LifecycleJournalRepository } from "../contexts/daemon/ports/LifecycleJournalRepository.ts";
import type { NativeService } from "../contexts/daemon/ports/NativeService.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { hostPaths } from "../contexts/daemon/services/hostPaths.ts";
import { LifecycleController } from "../contexts/daemon/services/LifecycleController.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { type DaemonLifecycle, manageDaemon } from "../contexts/daemon/services/manageDaemon.ts";
import { assertPrivateNode } from "../contexts/daemon/services/secureHostPath.ts";
import {
  UpgradeActivationController,
  type UpgradeActivationStatus,
} from "../contexts/daemon/services/UpgradeActivationController.ts";
import { clientExit } from "./ClientExit.ts";
import { commandFailed } from "./CommandFailed.ts";
import { timeoutMillis as parseTimeoutMillis } from "./workflow.ts";

interface ProductionController {
  readonly paths: DaemonPaths;
  readonly journal: FileLifecycleJournalRepository;
  readonly controller: LifecycleController;
}

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

const productionController = (readOnly = false): ProductionController => {
  const paths = hostPaths();
  const journal = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"), {
    readOnly,
  });
  return {
    paths,
    journal,
    controller: new LifecycleController({
      journal,
      control: new SocketDaemonLifecycleControl(paths.runtimeRoot, journal),
      nativeService: nativeService(),
      serviceDefinition: paths.serviceDefinition,
      observedDaemonInstanceId: () => readDaemonEndpoint(paths)?.instanceId,
    }),
  };
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
    }),
  };
};

const productionLifecycle = (): DaemonLifecycle => {
  if (process.platform === "darwin") {
    const paths = macPaths();
    return manageDaemon(paths, macLaunchAgent());
  }
  if (process.platform === "linux") {
    const paths = linuxPaths();
    return manageDaemon(paths, systemdUserService());
  }
  throw new LifecycleError(
    "UNSUPPORTED_HOST",
    "Kojo supports macOS or Linux with a functioning systemd user manager",
  );
};

const line = (name: string, value: string): string => `${name}: ${value}.`;

export const configurationStatusLines = (status: ConfigurationStatus): ReadonlyArray<string> => [
  line("Configuration scope", status.scope),
  ...(status.projectId === undefined ? [] : [line("Project", status.projectId)]),
  line("Configuration state version", String(status.stateVersion)),
  line("Explicit lifecycle restart required", status.restartRequired ? "yes" : "no"),
  ...status.fields.map((field) =>
    line(
      field.path,
      `effective=${JSON.stringify(field.effective)} default=${JSON.stringify(field.default)} scope=${field.scope} activation=${field.activation}${field.pending === undefined ? "" : ` pending=${JSON.stringify(field.pending)}`}`,
    ),
  ),
];

export const configurationCheckLines = (check: ConfigurationCheck): ReadonlyArray<string> => [
  ...configurationStatusLines(check.proposed),
  ...(check.plan === undefined
    ? [line("Retention plan", "not required")]
    : [
        line("Retention plan", check.plan.planId),
        line("Plan data identity", check.plan.dataIdentity),
        line("Plan request hash", check.plan.requestHash),
        line("Plan scope", check.plan.affectedScope),
        line("Plan configuration state", String(check.plan.expectedStateVersion)),
        line("Plan retained-data state", check.plan.expectedDataState),
        line("Plan issued at", check.plan.issuedAt),
        line("Plan expires at", check.plan.expiresAt),
        line("Plan changes", JSON.stringify(check.plan.changes)),
        line(
          "Runs selected for correctness collection",
          check.plan.impact.runIds.join(", ") || "none",
        ),
        line(
          "Runs selected for Trace collection",
          check.plan.impact.traceRunIds.join(", ") || "none",
        ),
        line(
          "Artifacts selected for collection",
          check.plan.impact.artifactIds.join(", ") || "none",
        ),
        line("Protected Runs", check.plan.impact.protectedRunIds.join(", ") || "none"),
      ]),
];

export const configurationApplyLines = (
  applied: ConfigurationApplyResult,
): ReadonlyArray<string> => [
  ...configurationStatusLines(applied.status),
  line("Collected Run correctness", applied.collection.runs.join(", ") || "none"),
  line("Collected Traces", applied.collection.traces.join(", ") || "none"),
  line("Collected Artifacts", applied.collection.artifacts.join(", ") || "none"),
];

const supervisionLines = (status: DaemonSupervisionStatus): ReadonlyArray<string> => [
  line("Daemon supervision", status.state),
  line("Daemon restart attempts remaining", String(status.restartAttemptsRemaining)),
  line("Daemon supervision repair required", status.repairRequired ? "yes" : "no"),
  line("Daemon restart delays", JSON.stringify(status.policy.restartDelaysMs)),
  line("Daemon healthy reset", `${status.policy.healthyResetMs} ms`),
  ...(status.lastFailure === undefined
    ? []
    : [
        line("Last Daemon failure", status.lastFailure.failedAt),
        line("Last Daemon failure detail", status.lastFailure.detail),
      ]),
  ...(status.repairPlan === undefined
    ? []
    : [
        line("Daemon repair plan", status.repairPlan.planId),
        line("Daemon repair expected state", status.repairPlan.expectedState),
        line("Daemon repair plan issued", status.repairPlan.issuedAt),
        line("Daemon repair plan expires", status.repairPlan.expiresAt),
      ]),
  ...(status.lastRepair === undefined
    ? []
    : [
        line("Last applied Daemon repair plan", status.lastRepair.planId),
        line("Last Daemon repair applied", status.lastRepair.appliedAt),
      ]),
];

export const daemonStatusLines = (status: DaemonStatus): ReadonlyArray<string> => [
  line("Installed", status.installed ? "yes" : "no"),
  line("Managed CLI", status.managedCli),
  line("Automatic start", status.automaticStart),
  line("Manager", status.manager),
  line("Process", status.process),
  line("Responsive", status.responsiveness),
  line("Ready", status.ready ? "yes" : "no"),
  line("Supported lifetime", status.loginLifetime),
  line("Keep running after logout", status.logoutPersistence),
  ...(status.detail === undefined ? [] : [line("Manager detail", status.detail)]),
];

export const lifecycleStatusLines = (status: LifecycleOperationStatus): ReadonlyArray<string> => [
  line("Lifecycle operation", status.operation.operationId),
  line("Lifecycle kind", status.operation.kind),
  line("Lifecycle outcome", status.outcome),
  line("Last lifecycle stage", status.operation.stage),
  line("Recorded Daemon owner", status.recordedOwner?.daemonInstanceId ?? "not recorded"),
  line("Recorded Runner owners", status.recordedOwner?.runnerInstanceIds.join(", ") || "none"),
  line("Observed Daemon owner", status.observedOwner.daemonInstanceId ?? "not observed"),
  line("Observed manager", status.observedOwner.manager),
  line("Observed process", status.observedOwner.process),
  line("Executing Runs in drain", String(status.progress?.executingRunIds.length ?? 0)),
  line("Next permitted action", status.nextPermittedAction),
];

export const upgradeStatusLines = (report: UpgradeCheckReport): ReadonlyArray<string> => [
  line("Managed upgrade check", report.outcome),
  line("Staged candidate", report.candidateReleaseId),
  line("Active source release", report.sourceReleaseId),
  line("Checked Daemon data", report.dataIdentity),
  line("Checked retained set", report.retainedSetHash),
  line("Checked at", report.checkedAt),
  line("Checked current Workflows", String(report.checked.currentWorkflows)),
  line("Checked retained Runs", String(report.checked.retainedRuns)),
  line("Checked terminal Runs", String(report.checked.terminalRuns)),
  line("Checked validation references", String(report.checked.validations)),
  line("Checked readers", String(report.checked.readers)),
  line("Checked Workflow Revisions", String(report.checked.revisions)),
  line("Rollback-loss approval", report.rollbackApproval),
  ...report.compatibilityFaults.map((fault) =>
    line(
      `Compatibility ${fault.code}${fault.revisionId === undefined ? "" : ` for ${fault.revisionId}`}`,
      `${fault.detail} Scope: ${fault.affectedScope.join(", ") || "none"}. Remedy: ${fault.remedy}`,
    ),
  ),
  ...report.existingFaults.map((fault) =>
    line(
      `Existing ${fault.code}${fault.revisionId === undefined ? "" : ` for ${fault.revisionId}`}`,
      `${fault.detail} Scope: ${fault.affectedScope.join(", ") || "none"}. Remedy: ${fault.remedy}`,
    ),
  ),
  ...(report.plan === undefined
    ? []
    : [
        line("No-rollback plan", report.plan.planId),
        line("Plan affected scope", report.plan.affectedScope.join(", ") || "none"),
        line("Plan state version", report.plan.expectedStateVersion),
        line(
          "Migration consequence",
          `${report.plan.migration.description}; rollback from data format ${report.plan.migration.toDataFormat} to ${report.plan.migration.fromDataFormat} is not available`,
        ),
        line("Plan expiry", report.plan.expiresAt),
      ]),
  line("Managed upgrade remedy", report.remedy),
];

const printStatus = (status: DaemonStatus): Effect.Effect<void> =>
  Effect.forEach(daemonStatusLines(status), (statusLine) => Console.log(statusLine), {
    discard: true,
  });

const printLifecycleStatus = (status: LifecycleOperationStatus): Effect.Effect<void> =>
  Effect.forEach(lifecycleStatusLines(status), (statusLine) => Console.log(statusLine), {
    discard: true,
  });

const privateDaemonRequest = <A>(
  path: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Effect.Effect<A, string> =>
  Effect.tryPromise({
    try: async () => {
      const paths = hostPaths();
      const endpoint = readDaemonEndpoint(paths);
      if (endpoint === undefined)
        throw new Error("the Daemon is not ready; run `kojo daemon status`");
      const response = await fetch(`http://localhost${path}`, {
        unix: endpoint.socketPath,
        method: options.method,
        headers: {
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      } as RequestInit & { readonly unix: string });
      const value = (await response.json()) as {
        readonly code?: string;
        readonly message?: string;
      };
      if (!response.ok)
        throw new Error(
          `${value.code ?? "configuration-refused"}: ${value.message ?? `Daemon answered ${response.status}`}`,
        );
      return value as A;
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

const readConfigurationPatch = (file: string): Effect.Effect<unknown, string> =>
  Effect.tryPromise({
    try: async () =>
      JSON.parse(file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8")) as unknown,
    catch: (cause) =>
      `configuration file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const printUpgradeStatus = (report: UpgradeCheckReport): Effect.Effect<void> =>
  Effect.forEach(upgradeStatusLines(report), (statusLine) => Console.log(statusLine), {
    discard: true,
  });

const printUpgradeActivationStatus = (status: UpgradeActivationStatus): Effect.Effect<void> =>
  Effect.forEach(
    [
      line("Managed upgrade operation", status.operation.operationId),
      line("Managed upgrade outcome", status.outcome),
      line("Managed upgrade stage", status.operation.stage),
      line("Managed upgrade next action", status.nextPermittedAction),
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
      const response = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
        unix: endpoint.socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidateReleaseId,
          ...(approvalToken === undefined ? {} : { approvalToken }),
        }),
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

const offlineDataIdentity = (paths: DaemonPaths): string => {
  const path = join(paths.dataRoot, "lifecycle", "data-identity");
  assertPrivateNode(path, "file");
  const identity = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(identity)) {
    throw new LifecycleError(
      "DAEMON_DATA_IDENTITY_UNKNOWN",
      "the durable offline Daemon data identity is invalid",
    );
  }
  return identity;
};

export const plannedLifecycleResume = (
  journal: LifecycleJournalRepository,
  kind: LifecycleOperationKind,
  pendingOperationId?: string,
) => {
  const operation =
    pendingOperationId === undefined ? journal.current() : journal.read(pendingOperationId);
  if (operation === undefined || operation.outcome !== undefined) {
    if (pendingOperationId !== undefined) {
      throw new LifecycleError(
        "LIFECYCLE_OPERATION_NOT_PENDING",
        `--pending must name a pending ${kind} operation`,
      );
    }
    return undefined;
  }
  if (operation.kind !== kind) {
    throw new LifecycleError(
      "LIFECYCLE_OPERATION_PENDING",
      `lifecycle operation ${operation.operationId} is pending as ${operation.kind}, not ${kind}`,
    );
  }
  return operation;
};

const beginLifecycle = (
  kind: LifecycleOperationKind,
  timeoutMillis: number | undefined,
  pending: Option.Option<string>,
  force: boolean,
) =>
  Effect.gen(function* () {
    const managed = yield* Effect.try({
      try: productionController,
      catch: (cause) =>
        cause instanceof LifecycleError
          ? cause
          : new LifecycleError("LIFECYCLE_FAILED", "lifecycle setup failed", cause),
    });
    let effect: Effect.Effect<LifecycleOperationStatus, LifecycleError>;
    let operationId: string;
    if (force) {
      if (Option.isNone(pending)) {
        return yield* clientExit(2, "explicit force requires --pending REQUEST_ID");
      }
      operationId = pending.value;
      const operation = yield* lifecycleTry(() => managed.journal.read(operationId));
      if (operation === undefined || operation.kind !== kind) {
        return yield* clientExit(2, `--pending must name a pending ${kind} operation`);
      }
      const authorization =
        (yield* lifecycleTry(() => managed.journal.forceAuthorizationFor(operationId))) ??
        ({
          formatVersion: 1,
          authorizationId: crypto.randomUUID(),
          pendingOperationId: operationId,
          requestHash: requestHash({ operation: "force", pendingOperationId: operationId }),
          authorizedAt: new Date().toISOString(),
        } as const);
      effect = managed.controller.force(authorization);
    } else {
      const resumable = yield* lifecycleTry(() =>
        plannedLifecycleResume(
          managed.journal,
          kind,
          Option.isSome(pending) ? pending.value : undefined,
        ),
      );
      if (resumable !== undefined) {
        operationId = resumable.operationId;
        effect = managed.controller.resume(operationId);
      } else {
        const endpoint = yield* lifecycleTry(() => readDaemonEndpoint(managed.paths));
        const process = yield* lifecycleTry(() => nativeService().inspect().process);
        if (endpoint === undefined && kind === "restart") {
          return yield* commandFailed("the Daemon endpoint is not ready; inspect daemon status");
        }
        if (
          endpoint === undefined &&
          (kind === "stop" || kind === "disable-now") &&
          process !== "stopped"
        ) {
          return yield* commandFailed(
            "the Daemon endpoint is absent and the native stopped state is not confirmed",
          );
        }
        operationId = crypto.randomUUID();
        const activeRelease = yield* Effect.try({
          try: () =>
            readFileSync(join(managed.paths.installationRoot, "active-release"), "utf8").trim(),
          catch: (cause) =>
            new LifecycleError(
              "ACTIVE_RELEASE_INVALID",
              "the active managed release cannot be read",
              cause,
            ),
        });
        effect = managed.controller.request({
          operationId,
          dataIdentity:
            endpoint?.dataIdentity ??
            (yield* lifecycleTry(() => offlineDataIdentity(managed.paths))),
          originalRequestHash: requestHash({ operation: kind }),
          kind,
          sourceReleaseId: activeRelease,
          startedAt: new Date().toISOString(),
        });
      }
    }
    const observed = yield* (
      timeoutMillis === undefined
        ? effect.pipe(Effect.map(Option.some))
        : effect.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis)))
    ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
    if (Option.isNone(observed)) {
      return yield* clientExit(
        3,
        `lifecycle operation ${operationId} is still pending; timeout did not force or cancel it`,
      );
    }
    yield* printLifecycleStatus(observed.value);
  });

const useLifecycleEffect = <A>(
  operation: (lifecycle: DaemonLifecycle) => Effect.Effect<A, LifecycleError>,
) =>
  Effect.try({
    try: productionLifecycle,
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "LIFECYCLE_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  }).pipe(
    Effect.flatMap(operation),
    Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
  );

const install = Command.make(
  "install",
  {},
  Effect.fn(function* () {
    const result = yield* useLifecycleEffect((lifecycle) => lifecycle.install);
    yield* Console.log(
      result.changed
        ? "Installed, enabled, and started one managed Daemon for this OS user."
        : "Kept the existing managed installation. Its service state did not change.",
    );
    yield* printStatus(result.status);
  }),
).pipe(
  Command.withDescription(
    "Install immutable managed Kojo and Bun content, then enable and start its native user service",
  ),
);

const status = Command.make(
  "status",
  {
    details: Flag.boolean("details"),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ details, json }) {
    const daemon = yield* useLifecycleEffect((lifecycle) => lifecycle.status);
    const paths = yield* lifecycleTry(hostPaths).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    let lifecycle: LifecycleOperationStatus | undefined;
    if (existsSync(join(paths.dataRoot, "lifecycle"))) {
      const managed = yield* lifecycleTry(() => productionController(true)).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      const current = yield* lifecycleTry(managed.journal.current).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      if (current !== undefined) {
        lifecycle = yield* managed.controller.status(current.operationId);
      }
    }
    let configuration: ConfigurationStatus | undefined;
    if (details) {
      configuration = yield* privateDaemonRequest<ConfigurationStatus>(
        "/api/v1/daemon/configuration",
      ).pipe(Effect.catch((message) => commandFailed(message)));
    }
    const upgrade = yield* latestUpgrade(paths).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    const supervision = yield* lifecycleTry(() =>
      new ManagedDaemonSupervision(paths.dataRoot, { readOnly: true }).status(),
    ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
    if (json) {
      yield* Console.log(
        JSON.stringify({
          formatVersion: 1,
          daemon,
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(configuration === undefined ? {} : { configuration }),
          ...(upgrade === undefined ? {} : { upgrade }),
          supervision,
        }),
      );
    } else {
      yield* printStatus(daemon);
      if (lifecycle !== undefined) yield* printLifecycleStatus(lifecycle);
      if (configuration !== undefined) {
        for (const statusLine of configurationStatusLines(configuration)) {
          yield* Console.log(statusLine);
        }
      }
      if (upgrade !== undefined) yield* printUpgradeStatus(upgrade);
      for (const statusLine of supervisionLines(supervision)) yield* Console.log(statusLine);
    }
  }),
).pipe(Command.withDescription("Inspect the installation and service without starting work"));

const configure = Command.make(
  "configure",
  {
    file: Flag.string("file").pipe(Flag.optional),
    check: Flag.boolean("check"),
    confirm: Flag.string("confirm").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ file, check, confirm, json }) {
    if (Option.isSome(confirm)) {
      if (Option.isSome(file) || check) {
        return yield* clientExit(2, "--confirm cannot be combined with --file or --check");
      }
      const applied = yield* privateDaemonRequest<ConfigurationApplyResult>(
        "/api/v1/daemon/actions/configure",
        { method: "POST", body: { confirm: confirm.value } },
      ).pipe(Effect.catch((message) => commandFailed(message)));
      if (json) yield* Console.log(JSON.stringify(applied));
      else
        for (const statusLine of configurationApplyLines(applied)) yield* Console.log(statusLine);
      return;
    }
    if (Option.isNone(file))
      return yield* clientExit(2, "configure requires --file FILE or --confirm PLAN_TOKEN");
    const patch = yield* readConfigurationPatch(file.value).pipe(
      Effect.catch((message) => clientExit(2, message)),
    );
    const result = yield* privateDaemonRequest<ConfigurationCheck | ConfigurationApplyResult>(
      "/api/v1/daemon/actions/configure",
      { method: "POST", body: { patch, ...(check ? { check: true } : {}) } },
    ).pipe(Effect.catch((message) => commandFailed(message)));
    if (json) yield* Console.log(JSON.stringify(result));
    else {
      const lines =
        "proposed" in result ? configurationCheckLines(result) : configurationApplyLines(result);
      for (const statusLine of lines) yield* Console.log(statusLine);
    }
  }),
).pipe(
  Command.withDescription(
    "Check or apply one atomic JSON configuration patch; retention confirmation names an exact plan",
  ),
);

const start = Command.make(
  "start",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.start));
  }),
).pipe(Command.withDescription("Start the installed Daemon without changing automatic start"));

const stop = Command.make(
  "stop",
  {
    force: Flag.boolean("force"),
    pending: Flag.string("pending").pipe(Flag.optional),
    timeout: Flag.string("timeout").pipe(Flag.withDefault("60s")),
  },
  Effect.fn(function* ({ force, pending, timeout }) {
    const milliseconds = yield* parsedTimeout(timeout);
    yield* beginLifecycle("stop", milliseconds, pending, force);
  }),
).pipe(
  Command.withDescription(
    "Drain and stop the Daemon; timeout leaves it pending and force must name that operation",
  ),
);

const restart = Command.make(
  "restart",
  {
    force: Flag.boolean("force"),
    pending: Flag.string("pending").pipe(Flag.optional),
    timeout: Flag.string("timeout").pipe(Flag.withDefault("60s")),
  },
  Effect.fn(function* ({ force, pending, timeout }) {
    const milliseconds = yield* parsedTimeout(timeout);
    yield* beginLifecycle("restart", milliseconds, pending, force);
  }),
).pipe(
  Command.withDescription(
    "Drain, stop, and confirm a replacement Daemon without changing automatic start",
  ),
);

const repair = Command.make(
  "repair",
  {
    check: Flag.boolean("check"),
    apply: Flag.string("apply").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ check, apply, json }) {
    if (check === Option.isSome(apply)) {
      return yield* clientExit(2, "repair requires exactly one of --check or --apply PLAN_TOKEN");
    }
    const paths = yield* lifecycleTry(hostPaths).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    const supervision = new ManagedDaemonSupervision(paths.dataRoot);
    const result = yield* lifecycleTry(() =>
      Option.isSome(apply) ? supervision.applyRepair(apply.value) : supervision.checkRepair(),
    ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
    if (Option.isSome(apply)) {
      const service = nativeService();
      const observed = yield* lifecycleTry(service.inspect).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      if (observed.process === "stopped") {
        yield* lifecycleTry(() => service.start(paths.serviceDefinition)).pipe(
          Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
        );
      } else if (observed.process !== "running") {
        return yield* commandFailed(
          "the native manager cannot prove the faulted managed launcher is running or stopped",
        );
      }
    }
    if (json) yield* Console.log(JSON.stringify({ formatVersion: 1, supervision: result }));
    else for (const statusLine of supervisionLines(result)) yield* Console.log(statusLine);
  }),
).pipe(
  Command.withDescription(
    "Check exhausted Daemon supervision or apply one exact plan for another bounded cycle",
  ),
);

const enable = Command.make(
  "enable",
  {},
  Effect.fn(function* () {
    yield* beginLifecycle("enable", 60_000, Option.none(), false);
  }),
).pipe(Command.withDescription("Enable automatic start without starting a stopped Daemon"));

const disable = Command.make(
  "disable",
  {
    now: Flag.boolean("now").pipe(
      Flag.withDescription("Also stop the current Daemon after disabling automatic start"),
    ),
    force: Flag.boolean("force"),
    pending: Flag.string("pending").pipe(Flag.optional),
    timeout: Flag.string("timeout").pipe(Flag.withDefault("60s")),
  },
  Effect.fn(function* ({ now, force, pending, timeout }) {
    if (!now && (force || Option.isSome(pending))) {
      return yield* clientExit(2, "--force and --pending require --now");
    }
    const milliseconds = yield* parsedTimeout(timeout);
    yield* beginLifecycle(now ? "disable-now" : "disable", milliseconds, pending, force);
  }),
).pipe(Command.withDescription("Disable automatic start and leave the current Daemon running"));

const keepRunningAfterLogout = Command.make(
  "keep-running-after-logout",
  {},
  Effect.fn(function* () {
    if (process.platform === "linux") {
      yield* Console.log(
        "This changes linger for the complete OS user. All user services can then run after logout.",
      );
    }
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.keepRunningAfterLogout));
  }),
).pipe(
  Command.withDescription(
    "Explicitly request systemd linger for the complete OS user; Kojo never disables it",
  ),
);

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

const upgrade = Command.make(
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

export const daemon = Command.make("daemon").pipe(
  Command.withDescription("Install and inspect the one managed Daemon for this OS user"),
  Command.withSubcommands([
    install,
    status,
    start,
    stop,
    restart,
    repair,
    enable,
    disable,
    configure,
    keepRunningAfterLogout,
    upgrade,
  ]),
);
