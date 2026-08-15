import { spawn } from "node:child_process";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { maySpawn } from "../../src/contexts/agent/guards/maySpawn.ts";
import { spendFrom, spendVariable } from "../../src/contexts/agent/models/AgentSpend.ts";

/**
 * The one way a test may start an agent binary — ticket 55.
 *
 * **Ticket 49 put the spend guard in `SandcastleAgentInvoker`, and only there.** That covers every
 * call a *run* makes, and it covers nothing a test makes for itself. `kojoPiRealSession.test.ts`
 * built a command with `buildPrintCommand` and handed it straight to `node:child_process`, so
 * `KOJO_AGENT_SPEND` never saw it and the only thing between an edit and a bill was a `skipIf`.
 *
 * That is not a hypothetical. On the day the guard landed, an agent working ticket 52 reached a real
 * `pi` twice: once probing pi's layout in the belief that no credential existed, and once by
 * mutating `runnable` to prove the gate still bites — which un-skipped the paid `describe`. Both
 * were refused by Anthropic for being out of credit, so they cost nothing. **That is luck, not a
 * mechanism**, and the mutation was a *correct* thing to do: rung 3 of the verification ladder
 * demands it.
 *
 * So the guard moves to the thing that spawns. The gate on such a suite should still read the switch
 * — so it *skips* honestly rather than failing — and this refuses anyway, so flipping the gate by
 * hand cannot spend. Two lines, and the second is the one that survives a mutation.
 *
 * It calls the product's own `maySpawn` rather than a second copy of the rule. A guard that agreed
 * with the invoker by resemblance is a guard that will one day disagree with it.
 */

/** What one agent process left behind. */
export interface RanAgent {
  readonly stdout: string;
  readonly exitCode: number;
  /** Every event the provider's own parser found, in order. */
  readonly events: ReturnType<AgentProvider["parseStreamLine"]>;
}

/**
 * Whether this process may start an agent binary at all, and why not when it may not.
 *
 * Exported so a suite's own gate can ask the same question the spawn will ask, and skip rather than
 * fail. `sandbox: "none"` is the truth here: a test spawns on this machine, so the resolver's answer
 * is the one that counts, which is exactly the check `stand-in:<path>` exists to make.
 */
export const agentSpawnRefusal = (options: {
  readonly provider: AgentProvider;
  readonly binary: string;
  readonly model: string;
  /** What this call is for. Named in the refusal, because a bare *refused* sends nobody anywhere. */
  readonly reason: string;
}): string | undefined => {
  const verdict = maySpawn({
    spend: spendFrom({
      declared: process.env[spendVariable],
      // A Vitest worker has no terminal, so an unattended suite is refused by default and running
      // one on purpose is an explicit sentence somebody had to write.
      attended: process.stdin.isTTY === true,
    }),
    agent: options.reason,
    provider: options.provider.name,
    model: options.model,
    run: "a test, outside any run",
    binary: options.binary,
    resolve: (binary) => Bun.which(binary) ?? undefined,
    sandbox: "none",
  });
  return verdict._tag === "Refused" ? verdict.reason : undefined;
};

/**
 * One agent call, exactly as a Sandcastle sandbox would make it — the command through a shell, the
 * prompt down stdin, the stream read back through the provider's own parser — **and refused before
 * the process exists** when the switch says so.
 *
 * The refusal is a thrown error rather than a skip. A suite that reaches here has already decided it
 * wants to spend; if the switch disagrees, that disagreement must be loud. Skipping quietly is what
 * a gate is for, and a gate is upstream of this.
 */
export const spawnAgentBinary = (options: {
  readonly provider: AgentProvider;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly reason: string;
  readonly resumeSession?: string | undefined;
}): Promise<RanAgent> => {
  const { provider } = options;
  const built = provider.buildPrintCommand({
    prompt: options.prompt,
    dangerouslySkipPermissions: true,
    ...(options.resumeSession === undefined ? {} : { resumeSession: options.resumeSession }),
  });

  // The binary is read off the command Sandcastle would run, not guessed from the provider's name,
  // for the same reason `SandcastleAgentInvoker` reads it that way: the command is the thing that
  // gets spawned.
  const binary = (built.command.trim().split(/\s+/)[0] ?? provider.name).replace(
    /^["']|["']$/g,
    "",
  );

  const refusal = agentSpawnRefusal({
    provider,
    binary,
    model: options.model,
    reason: options.reason,
  });
  if (refusal !== undefined) {
    return Promise.reject(
      new Error(
        `refused to spawn an agent binary from a test, and nothing was started.\n${refusal}`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", built.command], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        stdout,
        exitCode: code ?? 0,
        events: stdout.split("\n").flatMap((line) => provider.parseStreamLine(line)),
      }),
    );
    child.stdin.write(built.stdin ?? "");
    child.stdin.end();
  });
};
