import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Console, Duration, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { clientExit } from "../../../cli/ClientExit.ts";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import { timeoutMillis as parseTimeoutMillis } from "../../../cli/workflow.ts";
import { acquireDaemonStartGate, DaemonDataPurger } from "../adapters/DaemonDataPurger.ts";
import { FileLifecycleJournalRepository } from "../adapters/FileLifecycleJournalRepository.ts";
import { SocketDaemonLifecycleControl } from "../adapters/LifecycleControlTransport.ts";
import { macLaunchAgent } from "../adapters/MacLaunchAgent.ts";
import { ManagedDaemonSupervision } from "../adapters/ManagedDaemonSupervision.ts";
import {
  hostManagedInstallation,
  removeManagedInstallation,
} from "../adapters/ManagedInstallation.ts";
import { PurgeSafetyRecovery } from "../adapters/PurgeSafetyRecovery.ts";
import { systemdUserService } from "../adapters/SystemdUserService.ts";
import type {
  ConfigurationApplyResult,
  ConfigurationCheck,
  ConfigurationStatus,
} from "../models/Configuration.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonStatus } from "../models/DaemonStatus.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleOperationKind,
  LifecycleOperationStatus,
} from "../models/LifecycleOperation.ts";
import {
  decodeUpgradeCheckReport,
  decodeUpgradeCheckResult,
  type UpgradeCheckReport,
  type UpgradeCheckResult,
} from "../models/ManagedUpgrade.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { readDaemonEndpoint } from "../services/daemonStatus.ts";
import { hostPaths } from "../services/hostPaths.ts";
import { LifecycleController } from "../services/LifecycleController.ts";
import { linuxPaths } from "../services/linuxPaths.ts";
import { macPaths } from "../services/macPaths.ts";
import { type DaemonLifecycle, manageDaemon } from "../services/manageDaemon.ts";
import { assertPrivateNode } from "../services/secureHostPath.ts";
import { plannedLifecycleResume } from "../use-cases/resumeLifecycleOperation.ts";
import {
  configurationApplyLines,
  configurationCheckLines,
  configurationStatusLines,
  daemonStatusLines,
  lifecycleStatusLines,
  supervisionLines,
  upgradeStatusLines,
} from "./DaemonCommandPresentation.ts";
import { daemonUpgradeCommand } from "./DaemonUpgradeCommand.ts";

interface ProductionController {
  readonly paths: DaemonPaths;
  readonly journal: FileLifecycleJournalRepository;
  readonly controller: LifecycleController;
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
  const service = nativeService();
  return {
    paths,
    journal,
    controller: new LifecycleController({
      journal,
      control: new SocketDaemonLifecycleControl(paths.runtimeRoot, journal),
      nativeService: service,
      serviceDefinition: paths.serviceDefinition,
      observedDaemonInstanceId: () => readDaemonEndpoint(paths)?.instanceId,
      removeManagedInstallation: () => removeManagedInstallation(paths),
      acquireRemovalGate: () => acquireDaemonStartGate(paths),
      assertRemovalSafetyEvidence: () =>
        new DaemonDataPurger({ paths, journal, nativeService: service }).check().plan.evidenceId,
    }),
  };
};
const productionLifecycle = (): DaemonLifecycle => {
  if (process.platform === "darwin") {
    const paths = macPaths();
    return manageDaemon(paths, macLaunchAgent(), hostManagedInstallation);
  }
  if (process.platform === "linux") {
    const paths = linuxPaths();
    return manageDaemon(paths, systemdUserService(), hostManagedInstallation);
  }
  throw new LifecycleError(
    "UNSUPPORTED_HOST",
    "Kojo supports macOS or Linux with a functioning systemd user manager",
  );
};

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

export const daemonStatusConfiguration = <A>(
  details: boolean,
  ready: boolean,
  request: () => Effect.Effect<A, string>,
): Effect.Effect<Option.Option<A>, string> =>
  details && ready ? request().pipe(Effect.map(Option.some)) : Effect.succeed(Option.none());

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

const lifecycleTryPromise = <A>(body: () => Promise<A>): Effect.Effect<A, LifecycleError> =>
  Effect.tryPromise({
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

const _upgradeRequest = (
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
    configuration = Option.getOrUndefined(
      yield* daemonStatusConfiguration(details, daemon.ready, () =>
        privateDaemonRequest<ConfigurationStatus>("/api/v1/daemon/configuration"),
      ).pipe(Effect.catch((message) => commandFailed(message))),
    );
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

const remove = Command.make(
  "remove",
  {
    force: Flag.boolean("force"),
    pending: Flag.string("pending").pipe(Flag.optional),
    timeout: Flag.string("timeout").pipe(Flag.withDefault("60s")),
  },
  Effect.fn(function* ({ force, pending, timeout }) {
    const milliseconds = yield* parsedTimeout(timeout);
    yield* beginLifecycle("remove", milliseconds, pending, force);
  }),
).pipe(
  Command.withDescription(
    "Drain and stop ownership, then remove native registration and managed content without Daemon data",
  ),
);

const purge = Command.make(
  "purge",
  {
    check: Flag.boolean("check"),
    confirm: Flag.string("confirm").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ check, confirm, json }) {
    if (check === Option.isSome(confirm)) {
      return yield* clientExit(2, "purge requires exactly one of --check or --confirm PLAN_TOKEN");
    }
    const paths = yield* lifecycleTry(hostPaths).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    const lifecycleRoot = join(paths.dataRoot, "lifecycle");
    const journal = existsSync(lifecycleRoot)
      ? yield* lifecycleTry(
          () => new FileLifecycleJournalRepository(lifecycleRoot, { readOnly: check }),
        ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)))
      : undefined;
    const purger = new DaemonDataPurger({
      paths,
      ...(journal === undefined ? {} : { journal }),
      nativeService: nativeService(),
    });
    if (Option.isSome(confirm)) {
      const result = yield* lifecycleTry(() => purger.confirm(confirm.value)).pipe(
        Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
      );
      if (json) yield* Console.log(JSON.stringify({ formatVersion: 1, ...result }));
      else {
        yield* Console.log(`Purged Daemon data identity: ${result.dataIdentity}.`);
        yield* Console.log(`Purge operation: ${result.operationId}.`);
      }
      return;
    }
    const result = yield* lifecycleTry(purger.check).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    const ready =
      result.plan.resourceRisks.length === 0 &&
      result.plan.observed.process === "stopped" &&
      result.plan.observed.automaticStart === "disabled";
    if (json) {
      yield* Console.log(
        JSON.stringify({ formatVersion: 1, outcome: ready ? "ready" : "refused", ...result }),
      );
    } else {
      yield* Console.log(`Purge outcome: ${ready ? "ready" : "refused"}.`);
      yield* Console.log(`Daemon data identity: ${result.plan.dataIdentity}.`);
      yield* Console.log(
        `Correctness records: ${JSON.stringify(result.plan.correctness.recordsByTable)}.`,
      );
      yield* Console.log(`Resource risks: ${result.plan.resourceRisks.length}.`);
      yield* Console.log(`Automatic start: ${result.plan.observed.automaticStart}.`);
      yield* Console.log(`Process: ${result.plan.observed.process}.`);
      yield* Console.log(`Plan expires at: ${result.plan.expiresAt}.`);
      yield* Console.log(`Plan token: ${result.planToken}.`);
    }
    if (!ready) return yield* clientExit(1, "purge prerequisites are not satisfied");
  }),
).pipe(
  Command.withDescription(
    "Inspect purge consequences or delete one exact stopped data identity with its exact plan",
  ),
);

const repair = Command.make(
  "repair",
  {
    check: Flag.boolean("check"),
    apply: Flag.string("apply").pipe(Flag.optional),
    purgeSafety: Flag.boolean("purge-safety").pipe(
      Flag.withDescription("Recover sealed purge safety with the retained restricted Daemon"),
    ),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ check, apply, purgeSafety, json }) {
    if (check === Option.isSome(apply)) {
      return yield* clientExit(2, "repair requires exactly one of --check or --apply PLAN_TOKEN");
    }
    const paths = yield* lifecycleTry(hostPaths).pipe(
      Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
    );
    if (purgeSafety) {
      const service = nativeService();
      const journal = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"), {
        readOnly: check,
      });
      const recovery = new PurgeSafetyRecovery({ paths, journal, nativeService: service });
      if (Option.isSome(apply)) {
        const result = yield* lifecycleTryPromise(() => recovery.apply(apply.value)).pipe(
          Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
        );
        if (json) yield* Console.log(JSON.stringify({ formatVersion: 1, purgeSafety: result }));
        else yield* Console.log(`Recovered purge safety evidence: ${result.evidenceId}.`);
      } else {
        const result = yield* lifecycleTry(recovery.check).pipe(
          Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)),
        );
        if (json) yield* Console.log(JSON.stringify({ formatVersion: 1, purgeSafety: result }));
        else {
          yield* Console.log(`Purge safety recovery data identity: ${result.plan.dataIdentity}.`);
          yield* Console.log(`Purge safety recovery release: ${result.plan.sourceReleaseId}.`);
          yield* Console.log(`Purge safety recovery plan expires at: ${result.plan.expiresAt}.`);
          yield* Console.log(`Purge safety recovery plan token: ${result.planToken}.`);
        }
      }
      return;
    }
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
    "Check or apply one exact Daemon supervision or purge safety repair plan",
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

export const daemon = Command.make("daemon").pipe(
  Command.withDescription("Install and inspect the one managed Daemon for this OS user"),
  Command.withSubcommands([
    install,
    status,
    start,
    stop,
    restart,
    remove,
    purge,
    repair,
    enable,
    disable,
    configure,
    keepRunningAfterLogout,
    daemonUpgradeCommand,
  ]),
);
