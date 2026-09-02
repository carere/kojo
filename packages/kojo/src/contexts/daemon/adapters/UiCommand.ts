import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import { HostConsoleAccessService } from "../adapters/HostConsoleAccessService.ts";
import { macBrowser } from "../adapters/MacBrowser.ts";
import { hostPaths } from "../services/hostPaths.ts";
import { launchConsole } from "../services/launchConsole.ts";

export const ui = Command.make(
  "ui",
  {
    noOpen: Flag.boolean("no-open").pipe(
      Flag.withDescription("Print the sensitive short-lived launch URL instead of opening it"),
    ),
  },
  Effect.fn(function* ({ noOpen }) {
    const line = yield* launchConsole(
      new HostConsoleAccessService(hostPaths()),
      macBrowser(),
      noOpen,
    ).pipe(Effect.catch((cause) => commandFailed(`${cause.code}: ${cause.message}`)));
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
