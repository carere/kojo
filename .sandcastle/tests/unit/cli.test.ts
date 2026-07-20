import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { sandcastleCommand } from "../../main";
import { runEffect, runFailure } from "../helpers/effect";

const command = Command.runWith(sandcastleCommand, { version: "0.1.0" });

const runCommand = (arguments_: ReadonlyArray<string>) =>
  runEffect(
    Effect.gen(function* () {
      yield* command(arguments_);
      return (yield* TestConsole.logLines).join("\n");
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer)),
  );

const runCommandFailure = (arguments_: ReadonlyArray<string>) =>
  runFailure(
    command(arguments_).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer)),
  );

describe("Sandcastle CLI", () => {
  test("documents delivery and preview as root subcommands", async () => {
    const help = await runCommand(["--help"]);

    expect(help).toContain("sandcastle <subcommand> [flags]");
    expect(help).toContain("delivery    Discover, implement, review, and integrate");
    expect(help).toContain("preview     Manage browser previews");
  });

  test("documents delivery flags and rejects invalid positive integers before dispatch", async () => {
    const help = await runCommand(["delivery", "--help"]);
    const invalid = await runCommandFailure(["delivery", "--concurrency", "0"]);
    const emptyTarget = await runCommandFailure(["delivery", "--target", ""]);

    expect(help).toContain("sandcastle delivery [flags]");
    expect(help).toContain("--root integer");
    expect(help).toContain("--target string");
    expect(help).toContain("--concurrency integer");
    expect(help).toContain("--max-iterations integer");
    expect(invalid).toMatchObject({
      _tag: "ShowHelp",
      commandPath: ["sandcastle", "delivery"],
      errors: [{ _tag: "InvalidValue", option: "concurrency", value: "0" }],
    });
    expect(emptyTarget).toMatchObject({
      _tag: "ShowHelp",
      commandPath: ["sandcastle", "delivery"],
      errors: [{ _tag: "InvalidValue", option: "target", value: "" }],
    });
  });

  test("routes preview start and stop help and rejects invalid flags before dispatch", async () => {
    const startHelp = await runCommand(["preview", "start", "--help"]);
    const stopHelp = await runCommand(["preview", "stop", "--help"]);
    const missingBranch = await runCommandFailure(["preview", "start"]);
    const emptyBranch = await runCommandFailure(["preview", "start", "--branch", ""]);
    const unknownFlag = await runCommandFailure(["preview", "start", "--port", "6101"]);

    expect(startHelp).toContain("sandcastle preview start [flags]");
    expect(startHelp).toContain(
      "Start a browser preview for a branch available locally or on origin",
    );
    expect(startHelp).toContain("Branch to preview (local or origin)");
    expect(stopHelp).toContain("sandcastle preview stop [flags]");
    expect(stopHelp).toContain("Stop a branch preview");
    expect(missingBranch).toMatchObject({
      _tag: "ShowHelp",
      commandPath: ["sandcastle", "preview", "start"],
      errors: [{ _tag: "MissingOption", option: "branch" }],
    });
    expect(emptyBranch).toMatchObject({
      _tag: "ShowHelp",
      commandPath: ["sandcastle", "preview", "start"],
      errors: [{ _tag: "InvalidValue", option: "branch", value: "" }],
    });
    expect(unknownFlag).toMatchObject({
      _tag: "ShowHelp",
      commandPath: ["sandcastle", "preview", "start"],
      errors: [{ _tag: "UnrecognizedOption", option: "--port" }],
    });
  });
});
