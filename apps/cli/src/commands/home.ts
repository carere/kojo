import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
  compactKojoHome,
  repairKojoHomeMigrations,
  restoreKojoHome,
  verifyKojoHome,
  withStoppedKojoHome,
} from "../system/home-maintenance";
import { resolveKojoHome } from "../system/lifecycle";
import { inspectSystem } from "../system/process";

const path = (name: string, description: string) =>
  Argument.string(name).pipe(Argument.withDescription(description));

const print = (result: unknown) => Console.log(JSON.stringify(result));

const failure = (command: string, error: unknown) => {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  return {
    command,
    error: {
      action: message.includes("System Process")
        ? "Stop the Kojo System Process and retry the maintenance command."
        : "Correct the reported Kojo Home or backup problem and retry.",
      code:
        message.includes("System Process") || message.includes("lock")
          ? "HOME_LOCKED"
          : "HOME_MAINTENANCE_FAILED",
      message,
    },
    home: process.env.KOJO_HOME ?? "",
    schemaVersion: 1,
    status: "failed",
  };
};

const offline = <A>(command: string, operation: (home: string) => Promise<A>) =>
  Effect.promise(async () => {
    const home = resolveKojoHome();
    try {
      const result = await withStoppedKojoHome(home, () => operation(home));
      return { command, home, result, schemaVersion: 1, status: "succeeded" };
    } catch (error) {
      return failure(command, error);
    }
  }).pipe(Effect.flatMap(print));

const backupDestination = path("destination", "New folder to receive the complete backup");
const backupCommand = Command.make(
  "backup",
  { destination: backupDestination },
  ({ destination }) =>
    Effect.promise(async () => {
      const home = resolveKojoHome();
      try {
        const system = await inspectSystem(home);
        if (system === undefined) {
          throw new Error("The Kojo System Process must be running for an online backup");
        }
        const response = await fetch("http://localhost/v1/home/backups", {
          body: JSON.stringify({ destination }),
          headers: { "content-type": "application/json" },
          method: "POST",
          unix: system.endpoint,
        });
        const result = (await response.json()) as unknown;
        if (!response.ok) process.exitCode = 1;
        return result;
      } catch (error) {
        return failure("home.backup", error);
      }
    }).pipe(Effect.flatMap(print)),
).pipe(Command.withDescription("Create an online checksummed Kojo Home backup"));

const backupSource = path("backup", "Folder containing a checksummed Kojo Home backup");
const restoreCommand = Command.make("restore", { backup: backupSource }, ({ backup }) =>
  offline("home.restore", (home) => restoreKojoHome(home, backup)),
).pipe(Command.withDescription("Restore a verified backup while the System Process is stopped"));

const verifyCommand = Command.make("verify", {}, () => offline("home.verify", verifyKojoHome)).pipe(
  Command.withDescription("Fully verify state.sqlite and every referenced artifact"),
);

const repairCommand = Command.make("repair-migrations", {}, () =>
  offline("home.repair-migrations", repairKojoHomeMigrations),
).pipe(Command.withDescription("Safely retry ordered migrations after a failed migration"));

const compactCommand = Command.make("compact", {}, () =>
  offline("home.compact", compactKojoHome),
).pipe(Command.withDescription("Compact SQLite and clean abandoned artifact staging files"));

export const homeCommand = Command.make("home").pipe(
  Command.withDescription("Back up, restore, verify, repair, and compact Kojo Home"),
  Command.withSubcommands([
    backupCommand,
    restoreCommand,
    verifyCommand,
    repairCommand,
    compactCommand,
  ]),
);
