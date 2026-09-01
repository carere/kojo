import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { macLaunchAgent } from "../contexts/daemon/adapters/MacLaunchAgent.ts";
import { systemdUserService } from "../contexts/daemon/adapters/SystemdUserService.ts";
import type { DaemonStatus } from "../contexts/daemon/models/DaemonStatus.ts";
import { LifecycleError } from "../contexts/daemon/models/LifecycleError.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { type DaemonLifecycle, manageDaemon } from "../contexts/daemon/services/manageDaemon.ts";
import { commandFailed } from "./CommandFailed.ts";

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

const printStatus = (status: DaemonStatus): Effect.Effect<void> =>
  Effect.forEach(daemonStatusLines(status), (statusLine) => Console.log(statusLine), {
    discard: true,
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
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.status));
  }),
).pipe(Command.withDescription("Inspect the installation and service without starting work"));

const start = Command.make(
  "start",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.start));
  }),
).pipe(Command.withDescription("Start the installed Daemon without changing automatic start"));

const stop = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.stop));
  }),
).pipe(Command.withDescription("Stop the Daemon and keep automatic start unchanged"));

const enable = Command.make(
  "enable",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.enable));
  }),
).pipe(Command.withDescription("Enable automatic start without starting a stopped Daemon"));

const disable = Command.make(
  "disable",
  {
    now: Flag.boolean("now").pipe(
      Flag.withDescription("Also stop the current Daemon after disabling automatic start"),
    ),
  },
  Effect.fn(function* ({ now }) {
    yield* printStatus(yield* useLifecycleEffect((lifecycle) => lifecycle.disable(now)));
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
  Command.withSubcommands([install, status, start, stop, enable, disable, keepRunningAfterLogout]),
);
