import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { spendVariable } from "../../../../../src/contexts/agent/models/AgentSpend.ts";
import { agentSpawnRefusal, spawnAgentBinary } from "../../../../support/spawnAgent.ts";

/**
 * **The spend switch, honoured from a test that has never heard of `AgentInvoker`** — ticket 55.
 *
 * Ticket 49's own integration tests prove the guard through `SandcastleAgentInvoker`, which is the
 * path a *run* takes. This proves it on the other path — the one a test takes when it builds a
 * command and starts the process itself, which is how two `pi` calls were made on the day that
 * ticket landed.
 *
 * The provider below is a real `AgentProvider` by every test Sandcastle applies to one, and its
 * "agent" is a shell command that writes a file. **That file is the evidence**: a refusal that
 * happened after the spawn would leave one behind, exactly as an empty prompt log is what proves the
 * invoker's own refusal came first. Nothing here can reach a model, and nothing here needs a
 * credential.
 */

const marker = "spawned.txt";

/** An `AgentProvider` whose command leaves a trace on disk and answers nothing. */
const writesAFile = (into: string): AgentProvider => ({
  name: "scripted",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({
    command: `sh -c 'cat > /dev/null; printf ran > ${JSON.stringify(join(into, marker))}'`,
    stdin: "",
  }),
  parseStreamLine: () => [],
});

describe("starting an agent binary from outside the invoker", () => {
  let directory: string;
  let declared: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kojo-spawn-guard-"));
    declared = process.env[spendVariable];
  });

  afterEach(async () => {
    if (declared === undefined) delete process.env[spendVariable];
    else process.env[spendVariable] = declared;
    await rm(directory, { recursive: true, force: true });
  });

  const spawn = () =>
    spawnAgentBinary({
      provider: writesAFile(directory),
      cwd: directory,
      prompt: "anything",
      model: "haiku",
      reason: "the spawn guard's own test",
    });

  /**
   * **On by default, and the default is what a Vitest worker gets.**
   *
   * Nothing is declared, and a worker has no terminal, so this is the same condition every
   * unattended context in this repository runs under — CI, an agent driving a shell, and the wave
   * that spent the two `pi` calls.
   */
  it("refuses when nothing is declared, and leaves no process behind", async () => {
    delete process.env[spendVariable];

    await expect(spawn()).rejects.toThrow(spendVariable);
    // The whole criterion, in one line: nothing ran.
    expect(existsSync(join(directory, marker))).toBe(false);
  });

  it("refuses when the switch says refuse, naming what it would have called", async () => {
    process.env[spendVariable] = "refuse";

    await expect(spawn()).rejects.toThrow("the spawn guard's own test");
    expect(existsSync(join(directory, marker))).toBe(false);
  });

  /**
   * A stand-in is checked rather than believed here too, and this is the row that matters: the
   * declared file is not what `sh` resolves to, so the spawn is refused even though a *process*
   * would have been perfectly safe to start. The rule is the same one the invoker applies, because
   * it is literally the same function.
   */
  it("refuses a stand-in that is not what the command's binary resolves to", async () => {
    process.env[spendVariable] = "stand-in:/nowhere/kojo/sh";

    await expect(spawn()).rejects.toThrow("resolves to");
    expect(existsSync(join(directory, marker))).toBe(false);
  });

  /**
   * And it really does spawn when told it may — otherwise every assertion above would pass on a
   * helper that never worked at all, which is the shape §4 of the build record is a list of.
   */
  it("spawns when the switch allows it, which is what makes the refusals mean something", async () => {
    process.env[spendVariable] = "allow";

    const ran = await spawn();

    expect(ran.exitCode).toBe(0);
    expect(existsSync(join(directory, marker))).toBe(true);
  });

  /**
   * The gate of a paid suite asks this before it decides to skip, so it must answer the same way
   * the spawn does — a gate that opened while the spawn refused would turn a skip into a failure.
   */
  it("answers the gate the same way it answers the spawn", () => {
    const ask = () =>
      agentSpawnRefusal({
        provider: writesAFile(directory),
        binary: "sh",
        model: "haiku",
        reason: "the spawn guard's own test",
      });

    process.env[spendVariable] = "allow";
    expect(ask()).toBeUndefined();

    process.env[spendVariable] = "refuse";
    expect(ask()).toContain(spendVariable);

    delete process.env[spendVariable];
    expect(ask()).toContain("no terminal is attached");
  });
});
