import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqliteDaemonGateRepository } from "../../gate/adapters/SqliteDaemonGateRepository.ts";
import { GateApi } from "../../gate/services/GateApi.ts";
import { SqliteProjectRecoveryRepository } from "../../project/adapters/SqliteProjectRecoveryRepository.ts";
import { SqliteProjectRepository } from "../../project/adapters/SqliteProjectRepository.ts";
import { SqliteResourceLeaseRepository } from "../../project/adapters/SqliteResourceLeaseRepository.ts";
import { discardMaterializedRevisionCacheForPurge } from "../../project/services/materializeRevision.ts";
import { ProjectApi } from "../../project/services/ProjectApi.ts";
import { AtomicArtifactRepository } from "../../trace/adapters/AtomicArtifactRepository.ts";
import { SqliteTraceRepository } from "../../trace/adapters/SqliteTraceRepository.ts";
import { SqliteTriggerRepository } from "../../trigger/adapters/SqliteTriggerRepository.ts";
import { SqliteExternalActionRepository } from "../../workflow/adapters/SqliteExternalActionRepository.ts";
import { SqliteRevisionRepository } from "../../workflow/adapters/SqliteRevisionRepository.ts";
import { SqliteRunRepository } from "../../workflow/adapters/SqliteRunRepository.ts";
import { FACTORY_INPUT_SCAN_INTERVAL_MILLIS } from "../../workflow/models/FactoryRefresh.ts";
import { RevisionCaptureError } from "../../workflow/models/RevisionCaptureError.ts";
import type { RunnerMutationFault } from "../../workflow/models/RunnerMutationFault.ts";
import { RunCoordinator } from "../../workflow/services/RunCoordinator.ts";
import { refreshFactory } from "../../workflow/services/refreshFactory.ts";
import { acquireDaemonStartGate } from "../adapters/DaemonDataPurger.ts";
import { startDaemonHttpApplication } from "../adapters/DaemonHttpApplication.ts";
import { FileLifecycleJournalRepository } from "../adapters/FileLifecycleJournalRepository.ts";
import { HostClientRequestRepository } from "../adapters/HostClientRequestRepository.ts";
import {
  type LifecycleControlServer,
  startLifecycleControlServer,
} from "../adapters/LifecycleControlTransport.ts";
import { hostManagedInstallation } from "../adapters/ManagedInstallation.ts";
import { ensurePurgeRecoveryCapsule } from "../adapters/PurgeRecoveryCapsule.ts";
import { SqliteConfigurationRepository } from "../adapters/SqliteConfigurationRepository.ts";
import { SqliteDaemonLifecycleReceiptRepository } from "../adapters/SqliteDaemonLifecycleReceiptRepository.ts";
import { SqlitePurgeSafetyRepository } from "../adapters/SqlitePurgeSafetyRepository.ts";
import { SqliteRetentionRepository } from "../adapters/SqliteRetentionRepository.ts";
import { SqliteUpgradeActivationReceiptRepository } from "../adapters/SqliteUpgradeActivationReceiptRepository.ts";
import { SqliteUpgradePreflightRepository } from "../adapters/SqliteUpgradePreflightRepository.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { DaemonLifecycleControl } from "../ports/DaemonLifecycleControl.ts";
import type { DaemonUpgradeControl } from "../ports/DaemonUpgradeControl.ts";
import { activeConsoleRelease } from "./activeConsoleRelease.ts";
import { browserAuthority } from "./browserAuthority.ts";
import { ConfigurationApi } from "./ConfigurationApi.ts";
import { DaemonLifecycleApi } from "./DaemonLifecycleApi.ts";
import { DaemonMutationGate } from "./DaemonMutationGate.ts";
import { DaemonNotifications } from "./DaemonNotifications.ts";
import { acquireDaemonSingletonLock, type DaemonSingletonLock } from "./DaemonSingletonLock.ts";
import { DaemonUpgradeApi, type UpgradeMigration } from "./DaemonUpgradeApi.ts";
import { ManagedUpgradePreflight } from "./ManagedUpgradePreflight.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
  removeOwnedPlainFile,
  removeOwnedSocket,
} from "./secureHostPath.ts";

export interface RunningDaemon {
  readonly endpoint: DaemonEndpoint;
  readonly lifecycleControl: DaemonLifecycleControl;
  readonly upgradeControl: DaemonUpgradeControl;
  readonly ready: Effect.Effect<void, LifecycleError>;
  readonly stopped: Effect.Effect<void, LifecycleError>;
  readonly stop: Effect.Effect<void, LifecycleError>;
}

export interface StartDaemonOptions {
  readonly consolePort?: number;
  readonly now?: () => number;
  readonly automaticRefresh?: boolean;
  readonly runnerIdleMillis?: number;
  readonly runnerCleanupMillis?: number;
  readonly resourceMutationFault?:
    | ((mutation: RunnerMutationFault) => "before-commit" | "after-commit" | undefined)
    | undefined;
  readonly resourceRecoveryBoundary?: (() => Effect.Effect<void>) | undefined;
  readonly upgradeMigration?: UpgradeMigration;
  readonly runRestore?: (runs: RunCoordinator) => Effect.Effect<void, LifecycleError>;
  readonly managedSupervision?: {
    readonly recordReady: (policy: {
      readonly restartDelaysMs: ReadonlyArray<number>;
      readonly healthyResetMs: number;
    }) => void;
    readonly recordOperationSuccess: () => void;
    readonly recordPlannedStop: () => void;
    readonly activatePolicy: (policy: {
      readonly restartDelaysMs: ReadonlyArray<number>;
      readonly healthyResetMs: number;
    }) => void;
  };
}

const retainedDirectories = [
  "revisions",
  "objects",
  "staging",
  "artifacts",
  "sessions",
  "worktrees",
  "client-requests",
  "lifecycle",
  "launcher-supervision",
] as const;

const currentEndpointIs = (path: string, instanceId: string): boolean => {
  try {
    assertPrivateNode(path, "file");
    return (
      (JSON.parse(readFileSync(path, "utf8")) as { readonly instanceId?: string }).instanceId ===
      instanceId
    );
  } catch {
    return false;
  }
};

export const startDaemonComposition = (
  paths: DaemonPaths,
  options: StartDaemonOptions = {},
): RunningDaemon => {
  const release = activeConsoleRelease(paths);
  const sourceManifestPath = join(
    paths.installationRoot,
    "releases",
    release.releaseId,
    "release.json",
  );
  const sourceManifest = readFileSync(sourceManifestPath, "utf8");
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const startGate = acquireDaemonStartGate(paths);
  let lock: DaemonSingletonLock;
  try {
    ensurePrivateDirectory(paths.dataRoot);
    for (const directory of retainedDirectories)
      ensurePrivateDirectory(join(paths.dataRoot, directory));
    lock = acquireDaemonSingletonLock(join(paths.dataRoot, "daemon.lock"));
  } catch (cause) {
    startGate.release();
    throw cause;
  }
  const databasePath = join(paths.dataRoot, "kojo.db");
  const runtimeEndpoint = join(paths.runtimeRoot, "endpoint.json");
  const socketPath = join(paths.runtimeRoot, "daemon.sock");
  const lifecycleSocketPath = join(paths.runtimeRoot, "lifecycle-control.sock");
  let database: Database | undefined;
  let socketServer: Bun.Server<unknown> | undefined;
  let consoleServer: Bun.Server<unknown> | undefined;
  let lifecycleServer: LifecycleControlServer | undefined;
  let retentionCollectionTimer: ReturnType<typeof setInterval> | undefined;
  let notificationTimer: ReturnType<typeof setInterval> | undefined;
  const notifications = new DaemonNotifications();

  try {
    if (existsSync(databasePath)) assertPrivateNode(databasePath, "file");
    database = new Database(databasePath, { create: true, strict: true });
    chmodSync(databasePath, 0o600);
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
    database.run(
      "CREATE TABLE IF NOT EXISTS daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    );
    const existing = database
      .query<{ readonly value: string }, []>(
        "SELECT value FROM daemon_metadata WHERE name = 'data_identity'",
      )
      .get();
    const dataIdentity = existing?.value ?? crypto.randomUUID();
    if (existing === null) {
      database.run("INSERT INTO daemon_metadata (name, value) VALUES ('data_identity', ?)", [
        dataIdentity,
      ]);
    }
    const lifecycleIdentityPath = join(paths.dataRoot, "lifecycle", "data-identity");
    if (existsSync(lifecycleIdentityPath)) {
      assertPrivateNode(lifecycleIdentityPath, "file");
      if (readFileSync(lifecycleIdentityPath, "utf8").trim() !== dataIdentity) {
        throw new LifecycleError(
          "DAEMON_DATA_IDENTITY_CONFLICT",
          "the offline lifecycle identity does not match the sole Daemon owner",
        );
      }
    } else {
      atomicPrivateFile(lifecycleIdentityPath, `${dataIdentity}\n`);
    }
    try {
      ensurePurgeRecoveryCapsule(paths, dataIdentity, release.releaseId);
    } catch {
      // A minimal or damaged active release can still start for inspection. Removal will refuse
      // before managed content is deleted unless the sole owner can build and seal this capsule.
    }

    ensurePrivateDirectory(paths.runtimeRoot);
    removeOwnedPlainFile(runtimeEndpoint);
    removeOwnedSocket(socketPath);
    removeOwnedSocket(lifecycleSocketPath);

    const instanceId = crypto.randomUUID();
    const authority = browserAuthority({ now });
    const configurationRepository = new SqliteConfigurationRepository(database);
    const retentionRepository = new SqliteRetentionRepository(database, paths.dataRoot);
    retentionRepository.finishFileCleanup();
    const configurationApi = new ConfigurationApi({
      dataIdentity,
      now,
      configuration: configurationRepository,
      retention: retentionRepository,
    });
    const projectRepository = new SqliteProjectRepository(database);
    const projectRecoveryRepository = new SqliteProjectRecoveryRepository(database, {
      settings: () => {
        const runner = configurationRepository.daemonConfiguration().runner;
        return {
          replacementDelaysMillis: runner.restartDelaysMs,
          healthyResetMillis: runner.healthyResetMs,
        };
      },
    });
    const runRepository = new SqliteRunRepository(database, {
      enforceProjectEligibility: true,
      limits: {
        daemon: () => configurationRepository.daemonConfiguration().limits,
        project: (projectId) => configurationRepository.projectConfiguration(projectId).limits,
      },
    });
    const actionRepository = new SqliteExternalActionRepository(database);
    const resourceRepository = new SqliteResourceLeaseRepository(database);
    const traceRepository = new SqliteTraceRepository(database);
    const revisionRepository = new SqliteRevisionRepository(database, paths.dataRoot);
    const triggerRepository = new SqliteTriggerRepository(database);
    const gateRepository = new SqliteDaemonGateRepository(database);
    const lifecycleReceipts = new SqliteDaemonLifecycleReceiptRepository(database);
    const upgradeReceipts = new SqliteUpgradeActivationReceiptRepository(database);
    const retainedUpgrade = Effect.runSync(upgradeReceipts.active);
    const restrictedUpgrade =
      retainedUpgrade?.dispatchHeld === true &&
      [
        "mutations-held",
        "final-preflight-refused",
        "final-preflight-accepted",
        "handoff-prepared",
        "controller-accepted",
        "backup-verified",
        "source-execution-stopped",
        "candidate-ready",
        "activation-authorized",
        "rollback-ready",
        "rolled-back",
      ].includes(retainedUpgrade.stage);
    const mutationGate = new DaemonMutationGate(
      retainedUpgrade?.mutationsHeld === true ? retainedUpgrade.operationId : undefined,
    );
    const backgroundWriterActivators: Array<() => void> = [];
    const upgradePreflight = new ManagedUpgradePreflight(
      new SqliteUpgradePreflightRepository(database, dataIdentity, revisionRepository),
      now,
    );
    const artifactRepository = new AtomicArtifactRepository(database, paths.dataRoot);
    const runApi = new RunCoordinator({
      dataIdentity,
      instanceId,
      dataRoot: paths.dataRoot,
      now,
      projects: projectRepository,
      projectRecovery: projectRecoveryRepository,
      runs: runRepository,
      actions: actionRepository,
      revisions: revisionRepository,
      triggers: triggerRepository,
      gates: gateRepository,
      resources: resourceRepository,
      trace: traceRepository,
      artifacts: artifactRepository,
      runnerSettings: () => {
        const configured = configurationRepository.daemonConfiguration().runner;
        return {
          ...configured,
          ...(options.runnerIdleMillis === undefined ? {} : { idleMs: options.runnerIdleMillis }),
          ...(options.runnerCleanupMillis === undefined
            ? {}
            : { cleanupMs: options.runnerCleanupMillis }),
        };
      },
      ...(options.resourceMutationFault === undefined
        ? {}
        : { resourceMutationFault: options.resourceMutationFault }),
      ...(options.resourceRecoveryBoundary === undefined
        ? {}
        : { resourceRecoveryBoundary: options.resourceRecoveryBoundary }),
      daemonDispatchHeld: lifecycleReceipts.activeDrainHeld() || upgradeReceipts.activeHold(),
    });
    let retentionCollection: Promise<void> | undefined;
    const collectRetainedEvidence = (): void => {
      if (retentionCollection !== undefined) return;
      const leave = mutationGate.enter();
      if (leave === undefined) return;
      const retention = configurationRepository.daemonConfiguration().retention;
      if (Object.values(retention).every((duration) => duration === "indefinite")) {
        leave();
        return;
      }
      const observedAt = new Date(now()).toISOString();
      retentionCollection = Effect.runPromise(
        retentionRepository
          .inspect(retention, observedAt)
          .pipe(
            Effect.flatMap((impact) => retentionRepository.collect(impact, retention, observedAt)),
          ),
      )
        .then(() => retentionRepository.finishFileCleanup())
        .catch(() => undefined)
        .finally(() => {
          retentionCollection = undefined;
          leave();
        });
    };
    const startRetentionCollectionTimer = (): void => {
      if (retentionCollectionTimer !== undefined) return;
      collectRetainedEvidence();
      retentionCollectionTimer = setInterval(collectRetainedEvidence, 60_000);
    };
    backgroundWriterActivators.push(startRetentionCollectionTimer);
    if (!restrictedUpgrade) startRetentionCollectionTimer();
    let restoreFailure: unknown;
    let restorePromise: Promise<void> | undefined;
    const daemonSupervisionPolicy = () => {
      const daemon = configurationRepository.daemonConfiguration().daemon;
      return {
        restartDelaysMs: daemon.restartDelaysMs,
        healthyResetMs: daemon.healthyResetMs,
      };
    };
    const restore = (): Promise<void> => {
      const restoration =
        options.runRestore?.(runApi) ??
        runApi
          .restore()
          .pipe(
            Effect.mapError(
              (cause) => new LifecycleError("DAEMON_RESTORE_FAILED", cause.message, cause),
            ),
          );
      restorePromise ??= Effect.runPromise(restoration)
        .then(() => options.managedSupervision?.recordReady(daemonSupervisionPolicy()))
        .catch((cause: unknown) => {
          restoreFailure = cause;
        });
      return restorePromise;
    };
    if (!restrictedUpgrade) void restore();
    const ready = Effect.tryPromise({
      try: async () => {
        if (restrictedUpgrade) return;
        const readinessMs = configurationRepository.daemonConfiguration().daemon.readinessMs;
        await Promise.race([
          restore(),
          Bun.sleep(readinessMs).then(() => {
            throw new Error(`Daemon readiness exceeded ${readinessMs} milliseconds`);
          }),
        ]);
        if (restoreFailure !== undefined) throw restoreFailure;
      },
      catch: (cause) =>
        new LifecycleError(
          "DAEMON_RESTORE_FAILED",
          cause instanceof Error ? cause.message : String(cause),
          cause,
        ),
    });
    const activatePendingConfiguration = configurationRepository.activatePendingDaemon().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          options.managedSupervision?.activatePolicy(daemonSupervisionPolicy());
        }),
      ),
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new LifecycleError("DAEMON_CONFIGURATION_ACTIVATION_FAILED", cause.message, cause),
      ),
    );
    const resumeRuntime = Effect.tryPromise({
      try: async () => {
        await restore();
        if (restoreFailure !== undefined) throw restoreFailure;
        for (const activateWriters of backgroundWriterActivators) activateWriters();
      },
      catch: (cause) =>
        new LifecycleError(
          "DAEMON_RESTORE_FAILED",
          cause instanceof Error ? cause.message : String(cause),
          cause,
        ),
    });
    const lifecycleControl = new DaemonLifecycleApi({
      dataIdentity,
      runs: runApi,
      receipts: lifecycleReceipts,
      ready,
      activatePendingConfiguration,
      recordPlannedStop: Effect.try({
        try: () => options.managedSupervision?.recordPlannedStop(),
        catch: (cause) =>
          new LifecycleError(
            "DAEMON_SUPERVISION_RECORD_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
      }),
      cleanupMillis: () => configurationRepository.daemonConfiguration().daemon.cleanupMs,
      purgeSafety: new SqlitePurgeSafetyRepository(
        database,
        dataIdentity,
        paths.dataRoot,
        paths.configurationRoot,
        () => {
          ensurePurgeRecoveryCapsule(paths, dataIdentity, release.releaseId);
          discardMaterializedRevisionCacheForPurge(join(paths.dataRoot, "runner-materialized"));
        },
      ),
      now,
    });
    const upgradeControl = new DaemonUpgradeApi({
      database,
      paths,
      dataIdentity,
      activeReleaseId: () => activeConsoleRelease(paths).releaseId,
      runs: runApi,
      receipts: upgradeReceipts,
      mutations: mutationGate,
      preflight: upgradePreflight,
      transportsReady: () =>
        socketServer !== undefined && consoleServer !== undefined && lifecycleServer !== undefined,
      restricted: restrictedUpgrade,
      recordRestrictedReady: () =>
        options.managedSupervision?.recordReady(daemonSupervisionPolicy()),
      resume: resumeRuntime,
      activate: resumeRuntime.pipe(Effect.andThen(activatePendingConfiguration)),
      ...(options.upgradeMigration === undefined ? {} : { migration: options.upgradeMigration }),
      now,
      installation: hostManagedInstallation,
    });
    const projectApi = new ProjectApi({
      dataIdentity,
      instanceId,
      journal: new HostClientRequestRepository(
        join(paths.dataRoot, "client-requests"),
        dataIdentity,
      ),
      now,
      repository: projectRepository,
      dataRoot: paths.dataRoot,
      runs: runApi,
    });
    const gateApi = new GateApi({
      dataIdentity,
      instanceId,
      now,
      repository: gateRepository,
      runs: runApi,
    });
    const expireDue = async (): Promise<void> => {
      const leave = mutationGate.enter();
      if (leave === undefined) return;
      try {
        await Effect.runPromise(gateApi.expireDue());
      } finally {
        leave();
      }
    };
    let gateDeadlineTimer: ReturnType<typeof setInterval> | undefined;
    const startGateDeadlineTimer = (): void => {
      if (gateDeadlineTimer !== undefined) return;
      void expireDue().catch(() => undefined);
      gateDeadlineTimer = setInterval(() => {
        void expireDue().catch(() => undefined);
      }, 100);
    };
    backgroundWriterActivators.push(startGateDeadlineTimer);
    if (!restrictedUpgrade) startGateDeadlineTimer();
    let refreshCoordinatorStopped = false;
    const refreshFingerprints = new Map<string, string>();
    const projectRefreshes = new Map<string, Promise<void>>();
    const inventoryFingerprint = (location: string): string => {
      const hasher = new Bun.CryptoHasher("sha256");
      const visit = (directory: string): void => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          const path = join(directory, entry.name);
          const stat = statSync(path);
          hasher.update(`${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\n`);
          if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
        }
      };
      visit(join(location, ".kojo"));
      for (const name of ["package.json", "bun.lock", "bun.lockb"]) {
        const path = join(location, name);
        if (existsSync(path)) {
          const stat = statSync(path);
          hasher.update(`${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\n`);
        }
      }
      return hasher.digest("hex");
    };
    const refreshProject = (project: {
      readonly projectId: string;
      readonly location: string;
    }): Promise<void> => {
      const current = projectRefreshes.get(project.projectId);
      if (current !== undefined) return current;
      const running = (async () => {
        const leave = mutationGate.enter();
        if (leave === undefined) return;
        try {
          await Effect.runPromise(projectRepository.markRefreshPending(project.projectId));
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (refreshCoordinatorStopped) return;
          try {
            const refreshed = await Effect.runPromise(
              refreshFactory({
                project: project.location,
                dataRoot: paths.dataRoot,
              }),
            );
            await Effect.runPromise(
              projectRepository.refresh(
                project.projectId,
                refreshed,
                "current",
                new Date(now()).toISOString(),
              ),
            );
            refreshFingerprints.set(project.projectId, inventoryFingerprint(project.location));
          } catch (cause) {
            const error =
              cause instanceof RevisionCaptureError
                ? cause
                : new RevisionCaptureError({
                    code: "CAPTURE_FAILED",
                    message: cause instanceof Error ? cause.message : String(cause),
                    remedy: "Repair the operational fault, then retry Factory Refresh.",
                    cause,
                  });
            await Effect.runPromise(
              projectRepository.refresh(
                project.projectId,
                {
                  factoryState: existsSync(join(project.location, ".kojo"))
                    ? "available"
                    : "missing",
                  workflows: [],
                  fault: error.message,
                  remedy: error.remedy,
                },
                error.code === "REFRESH_UNSTABLE" ? "pending" : "failed",
                new Date(now()).toISOString(),
              ),
            );
          }
        } finally {
          leave();
        }
      })().finally(() => projectRefreshes.delete(project.projectId));
      projectRefreshes.set(project.projectId, running);
      return running;
    };
    const inspectProjectInventories = async (force: boolean): Promise<void> => {
      const projects = await Effect.runPromise(projectRepository.activeProjects);
      await Promise.all(
        projects.map(async (project) => {
          let fingerprint: string;
          try {
            fingerprint = inventoryFingerprint(project.location);
          } catch {
            fingerprint = "unreadable";
          }
          if (force || refreshFingerprints.get(project.projectId) !== fingerprint) {
            await refreshProject(project);
          }
        }),
      );
    };
    let refreshInventoryTimer: ReturnType<typeof setInterval> | undefined;
    const startRefreshInventoryTimer = (): void => {
      if (refreshInventoryTimer !== undefined || options.automaticRefresh === false) return;
      void inspectProjectInventories(true);
      refreshInventoryTimer = setInterval(() => {
        if (!refreshCoordinatorStopped) void inspectProjectInventories(false);
      }, FACTORY_INPUT_SCAN_INTERVAL_MILLIS);
    };
    backgroundWriterActivators.push(startRefreshInventoryTimer);
    if (!restrictedUpgrade) startRefreshInventoryTimer();
    let observedDatabaseChanges =
      database.query<{ totalChanges: number }, []>("SELECT total_changes() AS totalChanges").get()
        ?.totalChanges ?? 0;
    notificationTimer = setInterval(() => {
      const currentDatabaseChanges =
        database
          ?.query<{ totalChanges: number }, []>("SELECT total_changes() AS totalChanges")
          .get()?.totalChanges ?? observedDatabaseChanges;
      if (currentDatabaseChanges === observedDatabaseChanges) return;
      observedDatabaseChanges = currentDatabaseChanges;
      notifications.publish(["daemon", "projects", "workflows", "runs", "askings"]);
    }, 250);
    const httpApplication = startDaemonHttpApplication({
      artifactRepository,
      authority,
      configurationApi,
      ...(options.consolePort === undefined ? {} : { consolePort: options.consolePort }),
      dataIdentity,
      database,
      gateApi,
      instanceId,
      mutationGate,
      notifications,
      now,
      paths,
      projectApi,
      projectRepository,
      release,
      revisionRepository,
      runApi,
      socketPath,
      sourceManifest,
      sourceManifestPath,
      startedAt,
      upgradePreflight,
      recordOperationSuccess: () => options.managedSupervision?.recordOperationSuccess(),
    });
    consoleServer = httpApplication.consoleServer;
    socketServer = httpApplication.socketServer;
    const endpoint = httpApplication.endpoint;
    chmodSync(socketPath, 0o600);
    atomicPrivateFile(runtimeEndpoint, `${JSON.stringify(endpoint)}\n`);
    lifecycleServer = startLifecycleControlServer({
      socketPath: lifecycleSocketPath,
      control: lifecycleControl,
      upgradeControl,
      journal: new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle")),
    });

    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let stopping: Promise<void> | undefined;
    const stopPromise = (): Promise<void> => {
      if (stopping !== undefined) return stopping;
      stopping = Promise.resolve().then(async () => {
        refreshCoordinatorStopped = true;
        if (refreshInventoryTimer !== undefined) clearInterval(refreshInventoryTimer);
        if (gateDeadlineTimer !== undefined) clearInterval(gateDeadlineTimer);
        if (retentionCollectionTimer !== undefined) clearInterval(retentionCollectionTimer);
        if (notificationTimer !== undefined) clearInterval(notificationTimer);
        notifications.close();
        socketServer?.stop(true);
        consoleServer?.stop(true);
        lifecycleServer?.stop();
        await Promise.allSettled([
          ...projectRefreshes.values(),
          ...(retentionCollection === undefined ? [] : [retentionCollection]),
        ]);
        await Effect.runPromise(runApi.shutdown());
        database?.close(false);
        if (currentEndpointIs(runtimeEndpoint, endpoint.instanceId)) {
          removeOwnedPlainFile(runtimeEndpoint);
          removeOwnedSocket(socketPath);
        }
        lock.unlock();
        startGate.release();
        resolveStopped?.();
      });
      return stopping;
    };
    const surfaceFailure = (cause: unknown): LifecycleError =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "DAEMON_STOP_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          );
    return {
      endpoint,
      lifecycleControl,
      upgradeControl,
      ready,
      stopped: Effect.tryPromise({ try: () => stopped, catch: surfaceFailure }),
      stop: Effect.tryPromise({ try: stopPromise, catch: surfaceFailure }),
    };
  } catch (cause) {
    socketServer?.stop(true);
    consoleServer?.stop(true);
    lifecycleServer?.stop();
    if (retentionCollectionTimer !== undefined) clearInterval(retentionCollectionTimer);
    if (notificationTimer !== undefined) clearInterval(notificationTimer);
    notifications.close();
    database?.close(false);
    lock.unlock();
    startGate.release();
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError("DAEMON_START_FAILED", "the Daemon could not become ready", cause);
  }
};
