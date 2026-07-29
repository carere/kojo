#!/usr/bin/env bun

import {
  defaultSocketPath,
  IncompatibleProtocolError,
  LocalTransportError,
  makeDefaultLocalClient,
} from "@kojo/control/local-client";
import { Effect } from "effect";
import { renderHostOverview } from "./src/contexts/workflow-execution/projects/use-cases/render-host-overview";

export const runCli = (args: ReadonlyArray<string>) => {
  const json = args.includes("--json");
  const command = args.filter((argument) => argument !== "--json");

  if (command.length !== 2 || command[0] !== "project" || command[1] !== "list") {
    const message = "Invalid command.";
    const next = "Run: kojo project list [--json]";
    process.stderr.write(`${message}\nNext: ${next}\n`);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          command: command.length === 0 ? "kojo" : command.join("."),
          error: { code: "invalid-command", message, next },
          warnings: [],
        })}\n`,
      );
    }
    return Promise.resolve(2);
  }

  const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());

  return Effect.runPromise(
    client.getHostOverview.pipe(
      Effect.match({
        onFailure: (error) => {
          const failure =
            error instanceof IncompatibleProtocolError
              ? {
                  code: "incompatible-protocol",
                  message: error.message,
                  next: "Upgrade Kojo Host or this CLI so their protocol major versions match.",
                }
              : error instanceof LocalTransportError
                ? {
                    code: "host-unavailable",
                    message: error.message,
                    next: "Start the Kojo Host and try again.",
                  }
                : {
                    code: "host-request-failed",
                    message: "Kojo Host request failed.",
                    next: "Try the command again.",
                  };
          process.stderr.write(`${failure.message}\nNext: ${failure.next}\n`);
          if (json) {
            process.stdout.write(
              `${JSON.stringify({
                schemaVersion: 1,
                command: "project.list",
                error: failure,
                warnings: [],
              })}\n`,
            );
          }
          return 3;
        },
        onSuccess: (overview) => {
          process.stdout.write(renderHostOverview(overview, json));
          return 0;
        },
      }),
    ),
  );
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
