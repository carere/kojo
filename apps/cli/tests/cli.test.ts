import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { kojoCommand } from "../main";

const command = Command.runWith(kojoCommand, { version: "0.1.0" });

const runCommand = (arguments_: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* command(arguments_);
      return (yield* TestConsole.logLines).join("\n");
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(BunServices.layer)),
  );

describe("Kojo CLI", () => {
  test("documents system lifecycle, server, and direct delivery surfaces", async () => {
    const help = await runCommand(["--help"]);

    expect(help).toContain("kojo <subcommand> [flags]");
    expect(help).toContain("serve");
    expect(help).toContain("delivery");
    expect(help).toContain("start");
    expect(help).toContain("stop");
    expect(help).toContain("restart");
    expect(help).toContain("status");
    expect(help).toContain("logs");
    expect(help).toContain("project");
    expect(help).toContain("workflow");
  });

  test("documents versioned Project operations", async () => {
    const help = await runCommand(["project", "--help"]);

    expect(help).toContain("add");
    expect(help).toContain("list");
    expect(help).toContain("enable");
    expect(help).toContain("disable");
    expect(help).toContain("relink");
    expect(help).toContain("archive");
  });

  test("documents typed Workflow Run start and source-independent inspection", async () => {
    const help = await runCommand(["workflow", "--help"]);

    expect(help).toContain("start");
    expect(help).toContain("inspect");
    expect(await runCommand(["workflow", "start", "--help"])).toContain("--from-checkout");
  });
});
