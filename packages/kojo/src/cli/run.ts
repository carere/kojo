import type { RunSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { Console, Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { DaemonPaths } from "../contexts/daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { clientExit } from "./ClientExit.ts";
import { commandFailed } from "./CommandFailed.ts";
import { runStatusCommands, runStatusLine } from "./runStatus.ts";

class RunClientError extends Data.TaggedError("RunClientError")<{ readonly reason: string }> {}

const productionPaths = (): DaemonPaths => {
  if (process.platform === "darwin") return macPaths();
  if (process.platform === "linux") return linuxPaths();
  throw new RunClientError({ reason: "Kojo Run inspection supports macOS and Linux" });
};

const readRuns = (): Effect.Effect<RunSnapshot, RunClientError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(productionPaths());
      if (endpoint === undefined)
        throw new Error("the Daemon is not ready; run `kojo daemon start`");
      const response = await fetch("http://localhost/api/v1/runs", {
        unix: endpoint.socketPath,
        headers: { accept: "application/json" },
      } as RequestInit & { readonly unix: string });
      if (!response.ok) throw new Error(`the Daemon refused Run inspection (${response.status})`);
      return (await response.json()) as RunSnapshot;
    },
    catch: (cause) =>
      new RunClientError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  });

const list = Command.make(
  "list",
  {
    projectId: Flag.string("project").pipe(Flag.optional),
    limit: Flag.integer("limit").pipe(Flag.withDefault(50)),
    cursor: Flag.integer("cursor").pipe(Flag.optional),
    all: Flag.boolean("all"),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ projectId, limit, cursor, all, json }) {
    if (limit < 1) return yield* clientExit(2, "--limit must be a positive integer");
    const offset = Option.getOrElse(cursor, () => 0);
    if (offset < 0) return yield* clientExit(2, "--cursor must not be negative");
    const selectedProject = Option.getOrUndefined(projectId);
    const snapshot = yield* readRuns().pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    const matching = snapshot.runs.filter(
      (run) => selectedProject === undefined || run.projectId === selectedProject,
    );
    const selected = all ? matching : matching.slice(offset, offset + limit);
    if (json) {
      yield* Console.log(JSON.stringify({ formatVersion: 1, ...snapshot, runs: selected }));
      return;
    }
    if (selected.length === 0) {
      yield* Console.log("No Runs are recorded.");
      return;
    }
    yield* Effect.forEach(selected, (run) => Console.log(runStatusLine(run, false)), {
      discard: true,
    });
  }),
).pipe(Command.withDescription("List Daemon-owned Runs"));

/** Run inspection and recovery. Starting a Workflow is `kojo workflow start`. */
export const run = Command.make("run").pipe(
  Command.withDescription("List, inspect, cancel, or resume Daemon-owned Runs"),
  Command.withSubcommands([list, ...runStatusCommands]),
);
