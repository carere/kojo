import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { macLaunchAgent } from "../contexts/daemon/adapters/MacLaunchAgent.ts";
import type { DaemonStatus } from "../contexts/daemon/models/DaemonStatus.ts";
import { LifecycleError } from "../contexts/daemon/models/LifecycleError.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { type DaemonLifecycle, manageDaemon } from "../contexts/daemon/services/manageDaemon.ts";
import { commandFailed } from "./CommandFailed.ts";

const productionLifecycle = (): DaemonLifecycle => {
  const paths = macPaths();
  return manageDaemon(paths, macLaunchAgent());
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
  ...(status.detail === undefined ? [] : [line("Manager detail", status.detail)]),
];

const printStatus = (status: DaemonStatus): Effect.Effect<void> =>
  Effect.forEach(daemonStatusLines(status), (statusLine) => Console.log(statusLine), {
    discard: true,
  });

const useLifecycle = <A>(operation: (lifecycle: DaemonLifecycle) => Promise<A>) =>
  Effect.tryPromise({
    try: () => operation(productionLifecycle()),
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "LIFECYCLE_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  }).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));

const install = Command.make(
  "install",
  {},
  Effect.fn(function* () {
    const result = yield* useLifecycle((lifecycle) => lifecycle.install());
    yield* Console.log(
      result.changed
        ? "Installed, enabled, and started one managed macOS Daemon."
        : "Kept the existing managed installation. Its service state did not change.",
    );
    yield* printStatus(result.status);
  }),
).pipe(
  Command.withDescription(
    "Install immutable managed Kojo and Bun content, then enable and start the LaunchAgent",
  ),
);

const status = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycle((lifecycle) => lifecycle.status()));
  }),
).pipe(Command.withDescription("Inspect the installation and service without starting work"));

const start = Command.make(
  "start",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycle((lifecycle) => lifecycle.start()));
  }),
).pipe(Command.withDescription("Start the installed Daemon without changing automatic start"));

const stop = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycle((lifecycle) => lifecycle.stop()));
  }),
).pipe(Command.withDescription("Stop the Daemon and keep automatic start unchanged"));

const enable = Command.make(
  "enable",
  {},
  Effect.fn(function* () {
    yield* printStatus(yield* useLifecycle((lifecycle) => lifecycle.enable()));
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
    yield* printStatus(yield* useLifecycle((lifecycle) => lifecycle.disable(now)));
  }),
).pipe(Command.withDescription("Disable automatic start and leave the current Daemon running"));

export const daemon = Command.make("daemon").pipe(
  Command.withDescription("Install and inspect the one managed Daemon for this OS user"),
  Command.withSubcommands([install, status, start, stop, enable, disable]),
);
