import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { describe, expect, it } from "@effect/vitest";
import { kojoPi } from "../../../../../src/contexts/agent/adapters/kojoPi.ts";

/**
 * The one test that spends money, against the one thing nothing else can stand in for.
 *
 * Every other test in this suite grades a command string or a file move. This grades the claim the
 * whole capture half exists for: **a second call re-enters the conversation instead of starting a
 * new one**, and it does that because the transcript is where `pi --session <id>` looks — under the
 * encoded directory of the project pi is running in. A stub cannot fail that claim; only pi can.
 *
 * It needs the real binary and real credentials, so it is skipped without them. **A skip is not a
 * pass.** The suite prints what it did not prove and Vitest reports the tests as skipped rather than
 * green, because the failure this guards against — a resume that silently degrades to a cold
 * start — is invisible in a run's outcome and shows up only on the bill and in the answer.
 */

/** The model to spend on. Overridable, because a factory does not choose a caller's model. */
const model = process.env.KOJO_PI_MODEL ?? "claude-sonnet-4-6";

const binary = Bun.which("pi");
const credentialed = (process.env.ANTHROPIC_API_KEY ?? "") !== "";
const runnable = binary !== null && credentialed;

const missing = [
  ...(binary === null ? ["the `pi` binary is not on PATH"] : []),
  ...(credentialed ? [] : ["ANTHROPIC_API_KEY is not set"]),
];

if (!runnable) {
  console.warn(
    [
      "NOT PROVEN: kojoPi resuming a real pi session.",
      ...missing.map((reason) => `  - ${reason}`),
      "  Install `@mariozechner/pi-coding-agent` and set ANTHROPIC_API_KEY to run it.",
    ].join("\n"),
  );
}

interface Ran {
  readonly stdout: string;
  readonly exitCode: number;
  /** Every event the provider's own parser found, in order. */
  readonly events: ReturnType<AgentProvider["parseStreamLine"]>;
}

/**
 * One pi call, exactly as a Sandcastle sandbox would make it: the command through a shell, the
 * prompt down stdin, and the stream read back through the provider's own parser.
 */
const run = (
  provider: ReturnType<typeof kojoPi>,
  cwd: string,
  prompt: string,
  resumeSession?: string,
): Promise<Ran> => {
  const built = provider.buildPrintCommand({
    prompt,
    dangerouslySkipPermissions: true,
    ...(resumeSession === undefined ? {} : { resumeSession }),
  });

  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", built.command], { cwd, stdio: ["pipe", "pipe", "inherit"] });
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

const sessionIdOf = (ran: Ran): string => {
  const found = ran.events.find((event) => event.type === "session_id");
  expect(found, `no session id in pi's stream:\n${ran.stdout}`).toBeDefined();
  return found?.type === "session_id" ? found.sessionId : "";
};

describe("the gate on the real-agent test", () => {
  it("names what is missing rather than passing quietly", () => {
    // This test always runs, so the file is always loaded and the skip below is always visible as
    // a skip. `runnable` and `missing` are two spellings of one fact; if they ever disagree, a
    // suite that proved nothing could still read as a full pass.
    expect(runnable).toBe(missing.length === 0);
  });
});

describe.skipIf(!runnable)("kojoPi against the real pi binary", () => {
  it("re-enters the session it opened, and the second call carries one message", {
    timeout: 300_000,
  }, async () => {
    const sessions = await mkdtemp(join(tmpdir(), "kojo-pi-sessions-"));
    const cwd = await mkdtemp(join(tmpdir(), "kojo-pi-project-"));
    const provider = kojoPi({
      model,
      system: "You are a terse assistant. Answer in one word and add nothing else.",
      tools: [],
      sessions: { host: sessions, sandbox: sessions },
    });

    try {
      const cold = await run(provider, cwd, "Remember the word ORCHID. Reply with: ready");
      expect(cold.exitCode).toBe(0);
      const opened = sessionIdOf(cold);

      // Criterion 4, against the binary rather than against a fixture: the transcript is under
      // the encoded cwd of the project pi ran in, which is the only directory `--session` reads.
      // If `--session-dir` were ignored, or the encoding were wrong, this is where it shows.
      expect(await provider.sessionStorage.existsOnHost(cwd, opened)).toBe(true);

      const before = await provider.sessionStorage.readHostSession(cwd, opened);
      expect(before).toContain("ORCHID");

      const resumed = await run(provider, cwd, "What word did I ask you to remember?", opened);
      expect(resumed.exitCode).toBe(0);

      // Re-entered, not reopened. A new id here is the silent degradation: the run still ends
      // `succeeded`, having paid for a cold start and answered without the conversation.
      expect(sessionIdOf(resumed)).toBe(opened);

      const answer = resumed.events
        .filter((event) => event.type === "result")
        .map((event) => (event.type === "result" ? event.result : ""))
        .join("");
      expect(answer.toUpperCase()).toContain("ORCHID");

      // What the second call cost: one message. The prompt on stdin is the whole of what was
      // sent — the first turn came from the transcript, not from the wire.
      const second = provider.buildPrintCommand({
        prompt: "What word did I ask you to remember?",
        dangerouslySkipPermissions: true,
        resumeSession: opened,
      });
      expect(second.stdin).toBe("What word did I ask you to remember?");
      expect(second.command).not.toContain("ORCHID");

      // And the transcript grew rather than restarted: both turns are in one file.
      const after = await provider.sessionStorage.readHostSession(cwd, opened);
      expect(after).toContain("ORCHID");
      expect(after).toContain("What word did I ask you to remember?");
      expect((after ?? "").length).toBeGreaterThan((before ?? "").length);

      const onDisk = await readFile(
        (await provider.sessionStorage.findByIdOnHost(opened)).path ?? "",
        "utf-8",
      );
      expect(onDisk).toBe(after);
    } finally {
      await rm(sessions, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
