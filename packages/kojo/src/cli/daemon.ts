import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Console, Duration, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FileLifecycleJournalRepository } from "../contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import { SocketDaemonLifecycleControl } from "../contexts/daemon/adapters/LifecycleControlTransport.ts";
import { macLaunchAgent } from "../contexts/daemon/adapters/MacLaunchAgent.ts";
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
import type { LifecycleJournalRepository } from "../contexts/daemon/ports/LifecycleJournalRepository.ts";
import type { NativeService } from "../contexts/daemon/ports/NativeService.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { hostPaths } from "../contexts/daemon/services/hostPaths.ts";
import { LifecycleController } from "../contexts/daemon/services/LifecycleController.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { type DaemonLifecycle, manageDaemon } from "../contexts/daemon/services/manageDaemon.ts";
import { assertPrivateNode } from "../contexts/daemon/services/secureHostPath.ts";
import { clientExit } from "./ClientExit.ts";
import { commandFailed } from "./CommandFailed.ts";
import { timeoutMillis as parseTimeoutMillis } from "./workflow.ts";

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
    if (json) {
      yield* Console.log(
        JSON.stringify({
          formatVersion: 1,
          daemon,
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(configuration === undefined ? {} : { configuration }),
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
    enable,
    disable,
    configure,
    keepRunningAfterLogout,
  ]),
);
