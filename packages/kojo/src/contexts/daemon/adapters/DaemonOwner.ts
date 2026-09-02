import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import type {
  BrowserSessionRequest,
  BrowserSessionResponse,
  DaemonDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import type { RecordVerdictRequest } from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import {
  decodeJsonValue,
  type JsonValue,
} from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Cause, Effect, Option } from "effect";
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
import { RunApi, type RunnerMutationFault } from "../../workflow/services/RunApi.ts";
import { refreshFactory } from "../../workflow/services/refreshFactory.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { DaemonLifecycleControl } from "../ports/DaemonLifecycleControl.ts";
import type { DaemonUpgradeControl } from "../ports/DaemonUpgradeControl.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { activeConsoleRelease } from "../services/activeConsoleRelease.ts";
import { browserAuthority } from "../services/browserAuthority.ts";
import { ConfigurationApi } from "../services/ConfigurationApi.ts";
import { DaemonLifecycleApi } from "../services/DaemonLifecycleApi.ts";
import { DaemonMutationGate } from "../services/DaemonMutationGate.ts";
import { DaemonUpgradeApi, type UpgradeMigration } from "../services/DaemonUpgradeApi.ts";
import { ManagedUpgradePreflight } from "../services/ManagedUpgradePreflight.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
  removeOwnedPlainFile,
  removeOwnedSocket,
} from "../services/secureHostPath.ts";
import { acquireDaemonStartGate } from "./DaemonDataPurger.ts";
import { FileLifecycleJournalRepository } from "./FileLifecycleJournalRepository.ts";
import { HostClientRequestJournal } from "./HostClientRequestJournal.ts";
import {
  type LifecycleControlServer,
  startLifecycleControlServer,
} from "./LifecycleControlTransport.ts";
import { readCheckedManagedRelease } from "./ManagedInstallation.ts";
import { ensurePurgeRecoveryCapsule, readPurgeRecoveryCapsule } from "./PurgeRecoveryCapsule.ts";
import { consumePurgeSafetyRecoveryAuthorization } from "./PurgeSafetyRecovery.ts";
import { SqliteConfigurationRepository } from "./SqliteConfigurationRepository.ts";
import { SqliteDaemonLifecycleReceiptRepository } from "./SqliteDaemonLifecycleReceiptRepository.ts";
import { SqlitePurgeSafetyRepository } from "./SqlitePurgeSafetyRepository.ts";
import { SqliteRetentionRepository } from "./SqliteRetentionRepository.ts";
import { SqliteUpgradeActivationReceiptRepository } from "./SqliteUpgradeActivationReceiptRepository.ts";
import { SqliteUpgradePreflightRepository } from "./SqliteUpgradePreflightRepository.ts";

interface LockHandle {
  readonly unlock: () => void;
}

const acquireLock = (path: string): LockHandle => {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(descriptor, 0o600);
  const stat = fstatSync(descriptor);
  if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile()) {
    closeSync(descriptor);
    throw new LifecycleError("UNSAFE_SINGLETON", "the singleton lock has unsafe ownership");
  }

  const lockLibrary =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : undefined;
  if (lockLibrary === undefined) {
    closeSync(descriptor);
    throw new LifecycleError("UNSUPPORTED_HOST", "the Host has no supported advisory file lock");
  }
  const library = dlopen(lockLibrary, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const locked = library.symbols.flock(descriptor, 2 | 4);
  if (locked !== 0) {
    library.close();
    closeSync(descriptor);
    throw new LifecycleError("DAEMON_ALREADY_RUNNING", "another Daemon owns this data root");
  }
  return {
    unlock: () => {
      library.symbols.flock(descriptor, 8);
      library.close();
      closeSync(descriptor);
    },
  };
};

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
  readonly runRestore?: (runs: RunApi) => Effect.Effect<void, LifecycleError>;
  readonly managedSupervision?: {
    readonly recordReady: (policy: {
      readonly restartDelaysMs: ReadonlyArray<number>;
      readonly healthyResetMs: number;
    }) => void;
    readonly recordPlannedStop: () => void;
    readonly activatePolicy: (policy: {
      readonly restartDelaysMs: ReadonlyArray<number>;
      readonly healthyResetMs: number;
    }) => void;
  };
}

/**
 * Run only the sole-owner purge safety seal. This surface starts no Run restoration,
 * background work, ordinary transport, or Project Runner.
 */
export const recoverPurgeSafety = async (
  paths: DaemonPaths,
  operationId: string,
  planToken: string,
  capability: string,
  nativeService: NativeService,
  now: () => number = Date.now,
): Promise<void> => {
  if (!/^[A-Za-z0-9_-]+$/.test(operationId)) {
    throw new LifecycleError(
      "PURGE_RECOVERY_OPERATION_INVALID",
      "the restricted purge recovery operation identity is invalid",
    );
  }
  const assertStoppedDisabled = (): void => {
    const observed = nativeService.inspect();
    if (observed.process !== "stopped" || observed.automaticStart !== "disabled") {
      throw new LifecycleError(
        "PURGE_RECOVERY_SERVICE_UNSAFE",
        "restricted purge recovery requires stopped ownership and disabled automatic start",
      );
    }
  };
  assertStoppedDisabled();
  const plan = consumePurgeSafetyRecoveryAuthorization(
    paths,
    planToken,
    operationId,
    capability,
    now(),
  );
  assertPrivateNode(paths.dataRoot, "directory");
  const gate = acquireDaemonStartGate(paths);
  let lock: LockHandle | undefined;
  let database: Database | undefined;
  try {
    assertStoppedDisabled();
    lock = acquireLock(join(paths.dataRoot, "daemon.lock"));
    const databasePath = join(paths.dataRoot, "kojo.db");
    assertPrivateNode(databasePath, "file");
    database = new Database(databasePath, { create: false, strict: true });
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA synchronous = FULL");
    const dataIdentity = database
      .query<{ readonly value: string }, []>(
        "SELECT value FROM daemon_metadata WHERE name = 'data_identity'",
      )
      .get()?.value;
    if (dataIdentity === undefined || dataIdentity.length === 0) {
      throw new LifecycleError(
        "DAEMON_DATA_IDENTITY_DAMAGED",
        "the retained database has no Daemon data identity",
      );
    }
    const capsule = readPurgeRecoveryCapsule(paths, dataIdentity);
    if (capsule.sourceReleaseId !== plan.sourceReleaseId) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the restricted recovery capsule changed after the exact check",
      );
    }
    const journal = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
    const operation = journal.read(operationId);
    if (
      operation === undefined ||
      journal.current()?.operationId !== operationId ||
      operation.outcome !== undefined ||
      operation.dataIdentity !== dataIdentity ||
      operation.sourceReleaseId !== plan.sourceReleaseId ||
      !(
        (operation.kind === "remove" && operation.stage === "prepared") ||
        (operation.kind === "purge-recovery" && operation.stage === "prepared")
      )
    ) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the exact lifecycle operation changed before restricted recovery",
      );
    }
    const identityPath = join(paths.dataRoot, "lifecycle", "data-identity");
    assertPrivateNode(identityPath, "file");
    if (readFileSync(identityPath, "utf8").trim() !== dataIdentity) {
      throw new LifecycleError(
        "DAEMON_DATA_IDENTITY_CONFLICT",
        "the retained offline identity does not match the sole-owner database",
      );
    }
    const issuedAt = new Date(now()).toISOString();
    await Effect.runPromise(
      new SqlitePurgeSafetyRepository(
        database,
        dataIdentity,
        paths.dataRoot,
        paths.configurationRoot,
        () => discardMaterializedRevisionCacheForPurge(join(paths.dataRoot, "runner-materialized")),
      ).seal(
        operationId,
        {
          daemonInstanceId: `purge-recovery-${crypto.randomUUID()}`,
          runnerInstanceIds: [],
          recordedAt: issuedAt,
        },
        issuedAt,
        new Date(now() + 10 * 60_000).toISOString(),
      ),
    );
    database.close(false);
    database = undefined;
  } finally {
    database?.close(false);
    lock?.unlock();
    gate.release();
  }
};

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

const noStoreJson = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

const problem = (status: number, code: string, message: string): Response =>
  noStoreJson({ code, message }, status);

const isJson = (request: Request): boolean =>
  request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
  "application/json";

const requestJson = async (request: Request): Promise<unknown> => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 1_048_576) {
    throw new LifecycleError("REQUEST_TOO_LARGE", "the request body is too large");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

const withOrdinaryMutation = async (
  gate: DaemonMutationGate,
  request: Request,
  body: () => Promise<Response>,
): Promise<Response> => {
  if (request.method === "GET" || request.method === "HEAD") return body();
  const release = gate.enter();
  if (release === undefined) {
    return problem(
      409,
      "daemon-mutations-held",
      "ordinary mutations are held by the current Daemon lifecycle operation",
    );
  }
  try {
    return await body();
  } finally {
    release();
  }
};

const contentType = (path: string): string => {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
};

const consoleAsset = async (assets: string, pathname: string): Promise<Response> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return problem(400, "invalid-path", "the requested path is invalid");
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return problem(400, "invalid-path", "the requested path is invalid");
  }
  const requested = segments.length === 0 ? "index.html" : join(...segments);
  const selected = extname(requested).length === 0 ? "index.html" : requested;
  const file = Bun.file(join(assets, selected));
  if (!(await file.exists())) return problem(404, "not-found", "the requested asset was not found");
  return new Response(file, {
    headers: {
      "content-type": contentType(selected),
      "x-content-type-options": "nosniff",
    },
  });
};

export const startDaemon = (
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
  let lock: LockHandle;
  try {
    ensurePrivateDirectory(paths.dataRoot);
    for (const directory of retainedDirectories)
      ensurePrivateDirectory(join(paths.dataRoot, directory));
    lock = acquireLock(join(paths.dataRoot, "daemon.lock"));
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
    const runApi = new RunApi({
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
    });
    const projectApi = new ProjectApi({
      dataIdentity,
      instanceId,
      journal: new HostClientRequestJournal(join(paths.dataRoot, "client-requests")),
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
    const ownerDatabase = database;
    const configurationResponse = async (
      request: Request,
      url: URL,
      allowMaintenance: boolean,
    ): Promise<Response | undefined> => {
      const daemonStatus = url.pathname === "/api/v1/daemon/configuration";
      const daemonAction = url.pathname === "/api/v1/daemon/actions/configure";
      const projectStatus = url.pathname.match(
        /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/configuration$/,
      );
      const projectAction = url.pathname.match(
        /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/configure$/,
      );
      if (!daemonStatus && !daemonAction && projectStatus === null && projectAction === null) {
        return undefined;
      }
      if (!allowMaintenance) {
        return problem(
          405,
          "cli-maintenance-required",
          "configuration and retention status and changes are available only through the private CLI",
        );
      }
      const projectId = projectStatus?.[1] ?? projectAction?.[1];
      if (
        projectId !== undefined &&
        ownerDatabase
          .query<{ readonly found: number }, [string]>(
            "SELECT 1 AS found FROM projects WHERE project_id = ?",
          )
          .get(projectId) === null
      ) {
        return problem(404, "project-not-found", "the selected Project was not found");
      }
      const target =
        projectId === undefined
          ? ({ scope: "daemon" } as const)
          : ({ scope: "project", projectId } as const);
      const isAction = daemonAction || projectAction !== null;
      if (request.method === "GET" && !isAction) {
        return noStoreJson(await Effect.runPromise(configurationApi.status(target)));
      }
      if (request.method !== "POST" || !isAction) {
        return problem(405, "method-not-allowed", "the configuration action requires POST");
      }
      if (!isJson(request)) {
        return problem(415, "json-required", "the configuration action requires JSON");
      }
      try {
        const body = await requestJson(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return problem(
            400,
            "invalid-configuration",
            "the configuration request must be an object",
          );
        }
        const record = body as Record<string, unknown>;
        if (typeof record.confirm === "string") {
          if (
            target.scope !== "daemon" ||
            Object.keys(record).length !== 1 ||
            record.confirm.length === 0
          ) {
            return problem(
              400,
              "invalid-configuration-confirmation",
              "confirmation must name one exact Daemon retention plan",
            );
          }
          return noStoreJson(await Effect.runPromise(configurationApi.confirm(record.confirm)));
        }
        if (
          Object.keys(record).some((key) => key !== "patch" && key !== "check") ||
          !("patch" in record) ||
          (record.check !== undefined && typeof record.check !== "boolean")
        ) {
          return problem(
            400,
            "invalid-configuration",
            "configure accepts only patch and optional check",
          );
        }
        const result =
          record.check === true
            ? await Effect.runPromise(configurationApi.check(target, record.patch))
            : await Effect.runPromise(configurationApi.apply(target, record.patch));
        return noStoreJson(result, record.check === true ? 200 : 202);
      } catch (cause) {
        const configuration = cause as { readonly code?: string; readonly message?: string };
        const invalid = configuration.code === "INVALID_CONFIGURATION_PATCH";
        return problem(
          invalid ? 400 : 409,
          configuration.code ?? "configuration-refused",
          configuration.message ?? "the configuration change was refused",
        );
      }
    };
    const upgradeResponse = async (request: Request, url: URL): Promise<Response | undefined> => {
      if (url.pathname !== "/api/v1/daemon/upgrade-check") return undefined;
      try {
        if (request.method === "GET") {
          const latest = await Effect.runPromise(upgradePreflight.latest);
          return latest === undefined
            ? problem(404, "upgrade-check-not-found", "no managed upgrade check is recorded")
            : noStoreJson(latest);
        }
        if (request.method !== "POST") {
          return problem(405, "method-not-allowed", "managed upgrade check supports GET and POST");
        }
        if (!isJson(request)) {
          return problem(415, "json-required", "managed upgrade check requires JSON");
        }
        const value = await requestJson(request);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return problem(400, "invalid-upgrade-check", "the managed upgrade check body is invalid");
        }
        const body = value as Record<string, unknown>;
        if (
          Object.keys(body).some(
            (key) => key !== "candidateReleaseId" && key !== "approvalToken",
          ) ||
          typeof body.candidateReleaseId !== "string" ||
          !/^[A-Za-z0-9._-]+$/.test(body.candidateReleaseId) ||
          (body.approvalToken !== undefined &&
            (typeof body.approvalToken !== "string" || body.approvalToken.length === 0))
        ) {
          return problem(400, "invalid-upgrade-check", "the managed upgrade check body is invalid");
        }
        const selectedSource = activeConsoleRelease(paths);
        if (
          selectedSource.releaseId !== release.releaseId ||
          readFileSync(sourceManifestPath, "utf8") !== sourceManifest
        ) {
          throw new LifecycleError(
            "ACTIVE_RELEASE_CHANGED",
            "the active managed release changed after this Daemon became its owner",
          );
        }
        const sourceFormat = (JSON.parse(sourceManifest) as { readonly formatVersion?: unknown })
          .formatVersion;
        if (sourceFormat === 2) readCheckedManagedRelease(paths, release.releaseId);
        const candidate = readCheckedManagedRelease(paths, body.candidateReleaseId);
        return noStoreJson(
          await Effect.runPromise(
            upgradePreflight.check({
              candidate,
              sourceReleaseId: release.releaseId,
              ...(body.approvalToken === undefined
                ? {}
                : { approvalToken: body.approvalToken as string }),
            }),
          ),
        );
      } catch (cause) {
        const fault =
          cause instanceof LifecycleError
            ? cause
            : new LifecycleError(
                "UPGRADE_PREFLIGHT_FAILED",
                cause instanceof Error ? cause.message : String(cause),
                cause,
              );
        return problem(409, fault.code, fault.message);
      }
    };
    const revisionResponse = async (
      request: Request,
      url: URL,
      allowMaintenance: boolean,
    ): Promise<Response | undefined> => {
      const matched = url.pathname.match(
        /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})(\/actions\/(repair|collect))?$/,
      );
      if (matched === null) return undefined;
      const projectId = matched[1] ?? "invalid";
      const revisionId = matched[2] ?? "invalid";
      const registered = ownerDatabase
        .query<{ readonly found: number }, [string, string]>(
          `SELECT 1 AS found FROM workflow_revision_registrations
            WHERE project_id = ? AND revision_id = ? LIMIT 1`,
        )
        .get(projectId, revisionId);
      if (registered === null) {
        return problem(404, "revision-not-found", "the selected Workflow Revision was not found");
      }
      try {
        if (request.method === "GET" && matched[3] === undefined) {
          return noStoreJson(
            await Effect.runPromise(
              revisionRepository.details(revisionId, new Date(now()).toISOString()),
            ),
          );
        }
        if (!allowMaintenance) {
          return problem(
            405,
            "cli-maintenance-required",
            "exact-content repair and collection are available only through the private CLI",
          );
        }
        if (request.method === "POST" && matched[4] === "repair") {
          const body = await requestJson(request);
          if (
            body === null ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            typeof (body as { readonly from?: unknown }).from !== "string"
          ) {
            return problem(400, "invalid-repair", "exact revision repair requires one source path");
          }
          return noStoreJson(
            await Effect.runPromise(
              revisionRepository.repairExact(
                revisionId,
                (body as { readonly from: string }).from,
                new Date(now()).toISOString(),
              ),
            ),
          );
        }
        if (request.method === "POST" && matched[4] === "collect") {
          return noStoreJson(
            await Effect.runPromise(
              revisionRepository.collect(revisionId, new Date(now()).toISOString()),
            ),
          );
        }
        return problem(405, "method-not-allowed", "the revision action does not allow this method");
      } catch (cause) {
        return problem(
          409,
          "revision-maintenance-refused",
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    };
    const gateSnapshot = async (projectId?: string): Promise<Response> =>
      noStoreJson(await Effect.runPromise(gateApi.snapshot(projectId)));
    const recordGateAnswer = async (
      request: Request,
      clientSuppliesAnswerer: boolean,
    ): Promise<Response> => {
      let input: RecordVerdictRequest;
      try {
        const value = await requestJson(request);
        if (value === null || typeof value !== "object" || Array.isArray(value))
          return problem(400, "invalid-verdict", "the Verdict request must be a JSON object");
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) =>
              key !== "requestId" &&
              key !== "dataIdentity" &&
              key !== "token" &&
              key !== "choice" &&
              key !== "reason" &&
              key !== "answerer",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string" ||
          typeof record.token !== "string" ||
          typeof record.choice !== "string" ||
          typeof record.reason !== "string" ||
          (record.answerer !== undefined && typeof record.answerer !== "string")
        ) {
          return problem(400, "invalid-verdict", "the Verdict request has invalid fields");
        }
        input = {
          requestId: record.requestId,
          dataIdentity: record.dataIdentity,
          token: record.token,
          choice: record.choice,
          reason: record.reason,
          ...(clientSuppliesAnswerer && typeof record.answerer === "string"
            ? { answerer: record.answerer }
            : {}),
        };
      } catch {
        return problem(400, "invalid-json", "the Verdict request body is invalid");
      }
      const result = await Effect.runPromiseExit(gateApi.record(input));
      if (result._tag === "Success") return noStoreJson(result.value);
      const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause)) as
        | { readonly code?: string; readonly message?: string }
        | undefined;
      if (failure?.code === "DEADLINE_PASSED")
        return problem(409, "deadline-passed", "the Verdict was not recorded before the Deadline");
      if (failure?.code === "ASKING_NOT_FOUND")
        return problem(404, "asking-not-found", "the Gate token was not found");
      return problem(409, "verdict-refused", failure?.message ?? Cause.pretty(result.cause));
    };
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
    const startRun = async (
      request: Request,
      projectId: string,
      workflowName: string,
    ): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-start", "the Start request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) => key !== "requestId" && key !== "dataIdentity" && key !== "payload",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string"
        ) {
          return problem(400, "invalid-start", "the Start request has invalid fields");
        }
        let payloadValue: JsonValue | undefined;
        if ("payload" in record) {
          const payload = decodeJsonValue(record.payload);
          if (!payload.ok) return problem(400, "invalid-payload", "the payload is not JSON");
          payloadValue = payload.value;
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.startWorkflow({
              projectId,
              workflowName,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
              ...(payloadValue === undefined ? {} : { payload: payloadValue }),
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "start-refused",
          cause instanceof Error ? cause.message : "the Run was not admitted",
        );
      }
    };
    const stopWorkflow = async (
      request: Request,
      projectId: string,
      workflowName: string,
    ): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-stop", "the Stop request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) => key !== "requestId" && key !== "dataIdentity" && key !== "force",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string" ||
          ("force" in record && typeof record.force !== "boolean")
        ) {
          return problem(400, "invalid-stop", "the Stop request has invalid fields");
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.stopWorkflow({
              projectId,
              workflowName,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
              ...(record.force === true ? { force: true } : {}),
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "stop-refused",
          cause instanceof Error ? cause.message : "the Workflow was not stopped",
        );
      }
    };
    const cancelRun = async (request: Request, runId: string): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-cancel", "the cancellation request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => key !== "requestId" && key !== "dataIdentity") ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string"
        ) {
          return problem(400, "invalid-cancel", "the cancellation request has invalid fields");
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.cancelRun({
              runId,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "cancel-refused",
          cause instanceof Error ? cause.message : "the Run cancellation was refused",
        );
      }
    };
    const retryUncertainAction = async (request: Request, runId: string): Promise<Response> => {
      try {
        const input = await requestJson(request);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          return problem(400, "invalid-uncertain-retry", "the retry request must be a JSON object");
        }
        const record = input as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) =>
              key !== "requestId" &&
              key !== "dataIdentity" &&
              key !== "actionId" &&
              key !== "reason" &&
              key !== "possibleDuplicationAcknowledged",
          ) ||
          typeof record.requestId !== "string" ||
          typeof record.dataIdentity !== "string" ||
          typeof record.actionId !== "string" ||
          typeof record.reason !== "string" ||
          record.reason.trim() === "" ||
          record.possibleDuplicationAcknowledged !== true
        ) {
          return problem(
            400,
            "invalid-uncertain-retry",
            "retry requires the exact action ID, a reason, and possible-duplication acknowledgement",
          );
        }
        return noStoreJson(
          await Effect.runPromise(
            runApi.retryUncertainAction({
              runId,
              requestId: record.requestId,
              dataIdentity: record.dataIdentity,
              actionId: record.actionId,
              reason: record.reason,
              possibleDuplicationAcknowledged: true,
            }),
          ),
          202,
        );
      } catch (cause) {
        return problem(
          409,
          "uncertain-retry-refused",
          cause instanceof Error ? cause.message : "the uncertain retry was refused",
        );
      }
    };
    const repairProjectRunner = async (projectId: string): Promise<Response> => {
      const project = (await Effect.runPromise(projectRepository.projects)).find(
        (candidate) => candidate.projectId === projectId,
      );
      if (project === undefined) {
        return problem(404, "project-not-found", "the selected Project was not found");
      }
      try {
        return noStoreJson(await Effect.runPromise(runApi.repairProject(projectId)), 202);
      } catch (cause) {
        return problem(
          409,
          "project-repair-refused",
          cause instanceof Error ? cause.message : "Project repair was refused",
        );
      }
    };
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
    consoleServer = Bun.serve({
      hostname: "127.0.0.1",
      port: options.consolePort ?? 0,
      async fetch(request) {
        return withOrdinaryMutation(mutationGate, request, async () => {
          const expectedHost = `127.0.0.1:${consoleServer?.port ?? 0}`;
          const origin = `http://${expectedHost}`;
          if (request.headers.get("host") !== expectedHost) {
            return problem(421, "wrong-host", "the request Host does not match this Console");
          }

          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname === "/_kojo/compat") {
            const body: BootstrapResponse = {
              bootstrapVersion: 1,
              instanceId,
              dataIdentity,
              clientApiVersions: [1],
              features: [
                "browser-session",
                "project-catalogue",
                "workflow-revisions",
                "no-trigger-runs",
                "trigger-scheduling",
                "gate-verdicts",
                "client-request-journal",
              ],
              packageVersion: release.packageVersion,
            };
            return noStoreJson(body);
          }

          if (url.pathname === "/_kojo/session") {
            if (request.method !== "POST") {
              return problem(405, "method-not-allowed", "the session exchange requires POST");
            }
            if (request.headers.get("origin") !== origin) {
              return problem(403, "wrong-origin", "the request Origin does not match this Console");
            }
            if (!isJson(request)) {
              return problem(415, "json-required", "the session exchange requires JSON");
            }
            let body: BrowserSessionRequest;
            try {
              const bytes = new Uint8Array(await request.arrayBuffer());
              if (bytes.byteLength > 4_096) {
                return problem(413, "request-too-large", "the session exchange is too large");
              }
              const input = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
              if (
                Object.keys(input).length !== 1 ||
                typeof input.grant !== "string" ||
                input.grant.length === 0
              ) {
                throw new Error("invalid grant request");
              }
              body = { grant: input.grant };
            } catch {
              return problem(400, "invalid-json", "the session exchange body is invalid");
            }
            const session = authority.exchange(body.grant, origin);
            if (session === undefined) {
              return problem(401, "grant-refused", "the launch grant is invalid or expired");
            }
            const response: BrowserSessionResponse = {
              formatVersion: 1,
              credential: session.secret,
              expiresAt: new Date(session.expiresAt).toISOString(),
              instanceId,
            };
            return noStoreJson(response);
          }

          if (url.pathname.startsWith("/api/v1/")) {
            const requestOrigin = request.headers.get("origin");
            if (requestOrigin !== null && requestOrigin !== origin) {
              return problem(403, "wrong-origin", "the request Origin does not match this Console");
            }
            if (request.method !== "GET" && request.method !== "HEAD") {
              if (requestOrigin !== origin) {
                return problem(403, "origin-required", "a mutation requires this Console Origin");
              }
              if (!isJson(request)) {
                return problem(415, "json-required", "a mutation requires JSON");
              }
              if (Number(request.headers.get("content-length") ?? "0") > 1_048_576) {
                return problem(413, "request-too-large", "the mutation body is too large");
              }
              try {
                const bytes = new Uint8Array(await request.clone().arrayBuffer());
                if (bytes.byteLength > 1_048_576) {
                  return problem(413, "request-too-large", "the mutation body is too large");
                }
                JSON.parse(new TextDecoder().decode(bytes));
              } catch {
                return problem(400, "invalid-json", "the mutation body is invalid");
              }
            }
            const session = authority.authenticate(request.headers.get("authorization"));
            if (session === undefined) {
              return problem(401, "session-refused", "Console access is invalid or expired");
            }
            if (request.method === "GET" && url.pathname === "/api/v1/daemon") {
              const projects = await Effect.runPromise(projectRepository.projects);
              const body: DaemonDocument = {
                formatVersion: 1,
                instanceId,
                dataIdentity,
                releaseId: release.releaseId,
                packageVersion: release.packageVersion,
                bunVersion: release.bunVersion,
                platform: process.platform,
                architecture: process.arch,
                startedAt,
                accessExpiresAt: new Date(session.expiresAt).toISOString(),
                projectCount: projects.length,
              };
              return noStoreJson(body);
            }
            const revision = await revisionResponse(request, url, false);
            if (revision !== undefined) return revision;
            const configuration = await configurationResponse(request, url, false);
            if (configuration !== undefined) return configuration;
            if (request.method === "GET" && url.pathname === "/api/v1/projects") {
              return Effect.runPromise(projectApi.snapshot());
            }
            if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
              return Effect.runPromise(projectApi.workflowSnapshot());
            }
            if (request.method === "GET" && url.pathname === "/api/v1/runs") {
              return noStoreJson(await Effect.runPromise(runApi.snapshot()));
            }
            if (request.method === "GET" && url.pathname === "/api/v1/askings") {
              return gateSnapshot();
            }
            if (request.method === "POST" && url.pathname === "/api/v1/gate-answers") {
              return recordGateAnswer(request, false);
            }
            const cancelOneRun = url.pathname.match(
              /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/cancel$/,
            );
            if (request.method === "POST" && cancelOneRun !== null) {
              return cancelRun(request, cancelOneRun[1] ?? "invalid");
            }
            const changeProjectLocation = url.pathname.match(
              /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/(relocate|archive|restore)$/,
            );
            if (request.method === "POST" && changeProjectLocation !== null) {
              return Effect.runPromise(
                projectApi.locationChange(
                  changeProjectLocation[1] ?? "invalid",
                  changeProjectLocation[2] as "relocate" | "archive" | "restore",
                  await requestJson(request),
                ),
              );
            }
            const retryOneUncertainAction = url.pathname.match(
              /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/retry-uncertain$/,
            );
            if (request.method === "POST" && retryOneUncertainAction !== null) {
              return retryUncertainAction(request, retryOneUncertainAction[1] ?? "invalid");
            }
            const repairOneProject = url.pathname.match(
              /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/repair$/,
            );
            if (request.method === "POST" && repairOneProject !== null) {
              return repairProjectRunner(repairOneProject[1] ?? "invalid");
            }
            const projectAskings = url.pathname.match(
              /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/askings$/,
            );
            if (request.method === "GET" && projectAskings !== null) {
              return gateSnapshot(projectAskings[1]);
            }
            const oneRun = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)$/);
            if (request.method === "GET" && oneRun !== null) {
              const run = await Effect.runPromise(runApi.run(oneRun[1] ?? "invalid"));
              return run === undefined
                ? problem(404, "run-not-found", "the selected Run was not found")
                : noStoreJson(run);
            }
            const oneArtifact = url.pathname.match(
              /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/artifacts\/([A-Za-z0-9_-]+)$/,
            );
            if (request.method === "GET" && oneArtifact !== null) {
              const artifact = artifactRepository.read(
                oneArtifact[1] ?? "invalid",
                oneArtifact[2] ?? "invalid",
              );
              if (artifact === undefined)
                return problem(404, "artifact-not-found", "the selected Artifact was not found");
              const content = readFileSync(artifact.path);
              if (url.searchParams.get("download") !== "1") {
                return noStoreJson({
                  artifactId: artifact.artifactId,
                  name: artifact.name,
                  mediaType: artifact.mediaType,
                  content: new TextDecoder().decode(content),
                });
              }
              const safeName = artifact.name.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact.txt";
              return new Response(content, {
                headers: {
                  "cache-control": "no-store",
                  "content-disposition": `attachment; filename="${safeName}"`,
                  "content-security-policy": "sandbox; default-src 'none'",
                  "content-type": "application/octet-stream",
                  "x-content-type-options": "nosniff",
                },
              });
            }
            const projectRuns = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/runs$/);
            if (request.method === "GET" && projectRuns !== null) {
              return noStoreJson(await Effect.runPromise(runApi.snapshot(projectRuns[1])));
            }
            const workflowStart = url.pathname.match(
              /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/start$/,
            );
            if (request.method === "POST" && workflowStart !== null) {
              return startRun(
                request,
                workflowStart[1] ?? "invalid",
                decodeURIComponent(workflowStart[2] ?? "invalid"),
              );
            }
            const workflowStop = url.pathname.match(
              /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/stop$/,
            );
            if (request.method === "POST" && workflowStop !== null) {
              return stopWorkflow(
                request,
                workflowStop[1] ?? "invalid",
                decodeURIComponent(workflowStop[2] ?? "invalid"),
              );
            }
            const projectWorkflows = url.pathname.match(
              /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows$/,
            );
            if (request.method === "GET" && projectWorkflows !== null) {
              return Effect.runPromise(projectApi.workflowSnapshot(projectWorkflows[1]));
            }
            const clientRequest = url.pathname.match(
              /^\/api\/v1\/client-requests\/([A-Za-z0-9_-]+)(\/retry)?$/,
            );
            if (clientRequest !== null) {
              const requestId = clientRequest[1] ?? "invalid";
              if (request.method === "GET" && clientRequest[2] === undefined) {
                return Effect.runPromise(projectApi.lookup(requestId));
              }
              if (request.method === "PUT" && clientRequest[2] === undefined) {
                try {
                  return Effect.runPromise(
                    projectApi.prepare(requestId, await requestJson(request)),
                  );
                } catch {
                  return problem(400, "invalid-json", "the mutation body is invalid");
                }
              }
              if (request.method === "POST" && clientRequest[2] === "/retry") {
                return Effect.runPromise(projectApi.retry(requestId));
              }
            }
            return problem(404, "not-found", "the requested API resource was not found");
          }

          if (request.method !== "GET" && request.method !== "HEAD") {
            return problem(405, "method-not-allowed", "static Console content is read-only");
          }
          return consoleAsset(release.assets, url.pathname);
        });
      },
    });
    const consoleOrigin = `http://127.0.0.1:${consoleServer.port}`;
    const endpoint: DaemonEndpoint = {
      formatVersion: 1,
      consoleOrigin,
      dataIdentity,
      instanceId,
      socketPath,
      ready: true,
    };
    socketServer = Bun.serve({
      unix: socketPath,
      async fetch(request) {
        return withOrdinaryMutation(mutationGate, request, async () => {
          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname === "/ready") {
            return Response.json(endpoint);
          }
          if (request.method === "POST" && url.pathname === "/ui-grants") {
            const grant = authority.issue(consoleOrigin);
            return noStoreJson({
              expiresAt: new Date(grant.expiresAt).toISOString(),
              launchUrl: `${consoleOrigin}/daemon#grant=${encodeURIComponent(grant.secret)}`,
            });
          }
          const revision = await revisionResponse(request, url, true);
          if (revision !== undefined) return revision;
          const upgrade = await upgradeResponse(request, url);
          if (upgrade !== undefined) return upgrade;
          const configuration = await configurationResponse(request, url, true);
          if (configuration !== undefined) return configuration;
          if (request.method === "GET" && url.pathname === "/api/v1/projects") {
            return Effect.runPromise(projectApi.snapshot());
          }
          if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
            return Effect.runPromise(projectApi.workflowSnapshot());
          }
          if (request.method === "GET" && url.pathname === "/api/v1/runs") {
            return noStoreJson(await Effect.runPromise(runApi.snapshot()));
          }
          if (request.method === "GET" && url.pathname === "/api/v1/askings") {
            return gateSnapshot();
          }
          if (request.method === "POST" && url.pathname === "/api/v1/gate-answers") {
            if (!isJson(request)) return problem(415, "json-required", "Gate answer requires JSON");
            return recordGateAnswer(request, true);
          }
          const cancelOneRun = url.pathname.match(
            /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/cancel$/,
          );
          if (request.method === "POST" && cancelOneRun !== null) {
            if (!isJson(request)) return problem(415, "json-required", "Cancel requires JSON");
            return cancelRun(request, cancelOneRun[1] ?? "invalid");
          }
          const changeProjectLocation = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/(relocate|archive|restore)$/,
          );
          if (request.method === "POST" && changeProjectLocation !== null) {
            if (!isJson(request))
              return problem(415, "json-required", "Project location change requires JSON");
            return Effect.runPromise(
              projectApi.locationChange(
                changeProjectLocation[1] ?? "invalid",
                changeProjectLocation[2] as "relocate" | "archive" | "restore",
                await requestJson(request),
              ),
            );
          }
          const retryOneUncertainAction = url.pathname.match(
            /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/retry-uncertain$/,
          );
          if (request.method === "POST" && retryOneUncertainAction !== null) {
            if (!isJson(request))
              return problem(415, "json-required", "Uncertain action retry requires JSON");
            return retryUncertainAction(request, retryOneUncertainAction[1] ?? "invalid");
          }
          const repairOneProject = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/repair$/,
          );
          if (request.method === "POST" && repairOneProject !== null) {
            if (!isJson(request)) return problem(415, "json-required", "Repair requires JSON");
            return repairProjectRunner(repairOneProject[1] ?? "invalid");
          }
          const projectAskings = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/askings$/,
          );
          if (request.method === "GET" && projectAskings !== null) {
            return gateSnapshot(projectAskings[1]);
          }
          const oneRun = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)$/);
          if (request.method === "GET" && oneRun !== null) {
            const run = await Effect.runPromise(runApi.run(oneRun[1] ?? "invalid"));
            return run === undefined
              ? problem(404, "run-not-found", "the selected Run was not found")
              : noStoreJson(run);
          }
          const projectRuns = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/runs$/);
          if (request.method === "GET" && projectRuns !== null) {
            return noStoreJson(await Effect.runPromise(runApi.snapshot(projectRuns[1])));
          }
          const workflowStart = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/start$/,
          );
          if (request.method === "POST" && workflowStart !== null) {
            if (!isJson(request)) return problem(415, "json-required", "Start requires JSON");
            return startRun(
              request,
              workflowStart[1] ?? "invalid",
              decodeURIComponent(workflowStart[2] ?? "invalid"),
            );
          }
          const workflowStop = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/stop$/,
          );
          if (request.method === "POST" && workflowStop !== null) {
            if (!isJson(request)) return problem(415, "json-required", "Stop requires JSON");
            return stopWorkflow(
              request,
              workflowStop[1] ?? "invalid",
              decodeURIComponent(workflowStop[2] ?? "invalid"),
            );
          }
          const projectWorkflows = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows$/,
          );
          if (request.method === "GET" && projectWorkflows !== null) {
            return Effect.runPromise(projectApi.workflowSnapshot(projectWorkflows[1]));
          }
          const clientRequest = url.pathname.match(
            /^\/api\/v1\/client-requests\/([A-Za-z0-9_-]+)(\/retry)?$/,
          );
          if (clientRequest !== null) {
            const requestId = clientRequest[1] ?? "invalid";
            if (request.method === "GET" && clientRequest[2] === undefined) {
              return Effect.runPromise(projectApi.lookup(requestId));
            }
            if (request.method === "PUT" && clientRequest[2] === undefined) {
              if (!isJson(request))
                return problem(415, "json-required", "the request requires JSON");
              try {
                return Effect.runPromise(projectApi.prepare(requestId, await requestJson(request)));
              } catch {
                return problem(400, "invalid-json", "the mutation body is invalid");
              }
            }
            if (request.method === "POST" && clientRequest[2] === "/retry") {
              return Effect.runPromise(projectApi.retry(requestId));
            }
          }
          return new Response("not found", { status: 404 });
        });
      },
    });
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
    database?.close(false);
    lock.unlock();
    startGate.release();
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError("DAEMON_START_FAILED", "the Daemon could not become ready", cause);
  }
};
