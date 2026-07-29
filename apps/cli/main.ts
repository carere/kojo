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
    process.stderr.write("Usage: kojo project list [--json]\n");
    return Promise.resolve(2);
  }

  const client = makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath());

  return Effect.runPromise(
    client.getHostOverview.pipe(
      Effect.match({
        onFailure: (error) => {
          const message =
            error instanceof IncompatibleProtocolError
              ? error.message
              : error instanceof LocalTransportError
                ? error.message
                : "Kojo Host request failed.";
          process.stderr.write(`${message}\n`);
          return error instanceof IncompatibleProtocolError ? 5 : 4;
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
