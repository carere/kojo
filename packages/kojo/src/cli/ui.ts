import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { macBrowser } from "../contexts/daemon/adapters/MacBrowser.ts";
import { LifecycleError } from "../contexts/daemon/models/LifecycleError.ts";
import { launchConsole } from "../contexts/daemon/services/launchConsole.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { commandFailed } from "./CommandFailed.ts";

export const ui = Command.make(
  "ui",
  {
    noOpen: Flag.boolean("no-open").pipe(
      Flag.withDescription("Print the sensitive short-lived launch URL instead of opening it"),
    ),
  },
  Effect.fn(function* ({ noOpen }) {
    const line = yield* Effect.tryPromise({
      try: () => launchConsole(macPaths(), macBrowser(), noOpen),
      catch: (cause) =>
        cause instanceof LifecycleError
          ? cause
          : new LifecycleError("DAEMON_ACCESS_FAILED", "the Console launch failed", cause),
    }).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
    yield* Console.log(line);
  }),
).pipe(
  Command.withDescription("Open the active Daemon Console without starting work"),
  Command.withExamples([
    { command: "kojo ui", description: "Open one authenticated Console tab" },
    {
      command: "kojo ui --no-open",
      description: "Print one sensitive 60-second launch URL",
    },
  ]),
);
