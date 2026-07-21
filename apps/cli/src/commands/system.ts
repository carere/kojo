import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  restartSystem,
  startSystem,
  stopSystem,
  systemLogs,
  systemStatus,
} from "../system/lifecycle";

const printResult = (result: unknown) => Console.log(JSON.stringify(result));

const failureCode = (command: string, message: string) => {
  if (message.includes("KOJO_HOME")) {
    return "STARTUP_INVALID_HOME";
  }
  if (message.includes("schema version") || message.includes("newer than this Kojo version")) {
    return "SCHEMA_VERSION_INCOMPATIBLE";
  }
  if (
    message.includes("integrity check") ||
    message.includes("not a database") ||
    message.includes("database disk image is malformed")
  ) {
    return "DATABASE_CORRUPT";
  }
  if (message.includes("state.sqlite") || message.includes("migration")) {
    return "MIGRATION_FAILED";
  }
  if (message.includes("lock")) {
    return "HOME_LOCKED";
  }
  if (message.includes("available") || message.includes("timed out")) {
    return "SYSTEM_UNAVAILABLE";
  }
  if (command === "start" || command === "restart") {
    return "STARTUP_FAILED";
  }
  return "SYSTEM_COMMAND_FAILED";
};

const run = <A>(command: string, operation: () => Promise<A>) =>
  Effect.promise(async () => {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      return {
        command,
        error: {
          action:
            "Inspect `kojo logs`, correct the reported Kojo Home problem, and retry the command.",
          code: failureCode(command, message),
          message,
        },
        home: process.env.KOJO_HOME ?? "",
        process: null,
        schemaVersion: 1,
        status: "failed",
      };
    }
  }).pipe(Effect.flatMap(printResult));

const timeout = Flag.integer("timeout").pipe(
  Flag.withDefault(30),
  Flag.withDescription("Seconds to wait for graceful shutdown"),
);

const lines = Flag.integer("lines").pipe(
  Flag.withDefault(100),
  Flag.withDescription("Number of recent log lines to return"),
);

export const startCommand = Command.make("start", {}, () => run("start", startSystem)).pipe(
  Command.withDescription("Start the Kojo System Process for this Kojo Home"),
);

export const stopCommand = Command.make("stop", { timeout }, ({ timeout }) =>
  run("stop", () => stopSystem(timeout)),
).pipe(Command.withDescription("Gracefully stop the Kojo System Process"));

export const restartCommand = Command.make("restart", { timeout }, ({ timeout }) =>
  run("restart", () => restartSystem(timeout)),
).pipe(Command.withDescription("Gracefully restart the Kojo System Process"));

export const statusCommand = Command.make("status", {}, () => run("status", systemStatus)).pipe(
  Command.withDescription("Report Kojo System Process availability"),
);

export const logsCommand = Command.make("logs", { lines }, ({ lines }) =>
  run("logs", () => systemLogs(lines)),
).pipe(Command.withDescription("Return recent Kojo System Process logs"));
