import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { kojoPi } from "../../../../../src/contexts/agent/adapters/kojoPi.ts";
import { spendVariable } from "../../../../../src/contexts/agent/models/AgentSpend.ts";
import {
  agentSpawnRefusal,
  type RanAgent,
  spawnAgentBinary,
} from "../../../../support/spawnAgent.ts";

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
 *
 * **Two things other than the credential used to stop this suite. Ticket 56 fixed both**, and they
 * are kept here because they are the reason the capture half is worth a paid test at all — each was
 * found by reading pi rather than by running this file, and each would have failed silently.
 *
 * 1. **`--session-dir` makes pi's layout flat.** `kojoPi` passes `--session-dir <sandbox root>` and
 *    `piSessionStorage` read `<root>/<encoded cwd>/`. pi encodes the cwd into a directory name only
 *    for its *default* root — `SessionManager.create` is
 *    `sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)` — so given
 *    `--session-dir X` it writes `X/<timestamp>_<id>.jsonl` and reads `X` with a non-recursive
 *    listing. `existsOnHost` asked a directory pi never wrote, and the resume path landed a captured
 *    transcript where pi does not look: a cold start with no error and a whole prompt on the bill.
 *    `piSessionSubdirectory` now holds the rule, and both layouts are graded without pi, in
 *    `kojoPi.test.ts`'s *finding a transcript pi wrote, without pi*.
 * 2. **A macOS temp path is not the path pi records.** `mkdtemp(tmpdir())` returns
 *    `/var/folders/…`; a child process started there reports `/private/var/folders/…`, which is what
 *    pi writes into the session line and encodes — pi's `resolvePath` is `path.resolve`, which
 *    follows no symlink. `piSessionStorage` now resolves every **host** path once, in `onHost`, and
 *    a sandbox path never, because that names a filesystem this process cannot see.
 *
 * pi ships as **`@earendil-works/pi-coding-agent`** — 0.84.2 at the registry, 0.80.10 on the machine
 * every measurement above was taken on. `@mariozechner/pi-coding-agent` is where it used to live and
 * is stale at 0.73.1, which is what `kojo init` stamped into every pi factory for eleven releases.
 * Ticket 57 moved the stamped install to the current name, pinned.
 */

/**
 * The model to spend on. Overridable, because a factory does not choose a caller's model.
 *
 * The default is the smallest Anthropic model pi's own catalogue lists — `pi --list-models` on
 * 0.80.10 offers nothing below `claude-haiku-4-5`. Nothing here reads judgement: the assertions are
 * a session id, one word carried across two turns, and a second command that carries one message. A
 * larger model would answer the same questions and put a larger number on the bill, and this is the
 * one test in the suite that has a bill.
 */
const model = process.env.KOJO_PI_MODEL ?? "claude-haiku-4-5";

/**
 * The two spellings of "pi can reach Anthropic", in the order `pi --help` lists them.
 *
 * pi takes **either** — `ANTHROPIC_API_KEY` for a metered API key, `ANTHROPIC_OAUTH_TOKEN` for an
 * OAuth token — and the second is how a subscription is carried. A gate that read the first alone
 * would skip on the machine of somebody who is authenticated, and print a reason that is not their
 * reason: the least useful kind of skip, because it sends the reader to fix something that is not
 * broken.
 */
const credentialVariables = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;

/** Whether an environment carries either credential. An empty value is not a credential. */
const hasCredential = (env: Readonly<Record<string, string | undefined>>): boolean =>
  credentialVariables.some((name) => (env[name] ?? "") !== "");

/**
 * What is absent, given a binary and an environment.
 *
 * A function of its arguments rather than of the ambient process, so the gate itself is graded
 * below against environments this machine does not have. The message names **both** variables,
 * built from the list rather than written out, so a third spelling cannot be accepted silently
 * while the skip goes on naming two.
 */
const missingIn = (
  piOnPath: boolean,
  env: Readonly<Record<string, string | undefined>>,
  /** Why the spend switch refuses, when it does. See `agentSpawnRefusal`. */
  spendRefusal: string | undefined,
): ReadonlyArray<string> => [
  ...(piOnPath ? [] : ["the `pi` binary is not on PATH"]),
  ...(hasCredential(env) ? [] : [`neither ${credentialVariables.join(" nor ")} is set`]),
  ...(spendRefusal === undefined ? [] : [`${spendVariable} does not allow it — ${spendRefusal}`]),
];

const binary = Bun.which("pi");
const credentialed = hasCredential(process.env);

/**
 * **The switch is part of the gate, and the spawn checks it again** — ticket 55.
 *
 * Two lines, and the second is the one that matters. Reading it here is what lets the suite *skip*
 * honestly when nobody has said it may spend, instead of failing with a message about a refusal.
 * Checking it again inside `spawnAgentBinary` is what makes flipping this constant by hand — which
 * is exactly what a mutation of the gate does, and exactly how two `pi` calls were made on the day
 * ticket 49 landed — cost nothing.
 *
 * `KOJO_PI_MODEL` is read here rather than below so the refusal can name the model it would have
 * called, which is the same sentence a run would print.
 */
const spendRefusal =
  binary === null
    ? undefined
    : agentSpawnRefusal({
        provider: kojoPi({ model }),
        binary: "pi",
        model,
        reason: "the pi session resume test",
      });

const runnable = binary !== null && credentialed && spendRefusal === undefined;

const missing = missingIn(binary !== null, process.env, spendRefusal);

if (!runnable) {
  console.warn(
    [
      "NOT PROVEN: kojoPi resuming a real pi session.",
      ...missing.map((reason) => `  - ${reason}`),
      `  Install the pi CLI, export ${credentialVariables.join(" or ")}, and set`,
      `  ${spendVariable}=allow to run it. The last one is not a formality: this suite spawns pi`,
      "  itself, so nothing else stands between an edit here and a bill.",
    ].join("\n"),
  );
}

/**
 * One pi call, through the one helper allowed to start an agent binary.
 *
 * It used to build the command here and hand it to `node:child_process`, which is how this file
 * sat outside the spend guard entirely. `spawnAgentBinary` does the same work — the command through
 * a shell, the prompt down stdin, the stream through the provider's own parser — and asks
 * `maySpawn` first. `agentSpawnSites.test.ts` is what keeps this the only such place.
 */
const run = (
  provider: ReturnType<typeof kojoPi>,
  cwd: string,
  prompt: string,
  resumeSession?: string,
): Promise<RanAgent> =>
  spawnAgentBinary({
    provider,
    cwd,
    prompt,
    model,
    reason: "the pi session resume test",
    ...(resumeSession === undefined ? {} : { resumeSession }),
  });

const sessionIdOf = (ran: RanAgent): string => {
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

  it("takes either credential, and names both when it has neither", () => {
    // The half of the gate this machine cannot exercise, exercised anyway: `missingIn` is a
    // function of an environment, so both spellings are graded here whatever is exported around
    // the run. Without this, "accepts ANTHROPIC_OAUTH_TOKEN" would be a claim nothing measures on
    // a machine that has no token — and an untested branch of a gate is how a suite ends up
    // skipping for a reason that was never true.
    expect(missingIn(true, { ANTHROPIC_API_KEY: "sk-not-a-real-key" }, undefined)).toEqual([]);
    expect(missingIn(true, { ANTHROPIC_OAUTH_TOKEN: "not-a-real-token" }, undefined)).toEqual([]);

    // Present but empty is absent. `kojo doctor` reads a stamped `.env` the same way, because a
    // variable somebody meant to fill in is not a credential.
    expect(
      missingIn(true, { ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" }, undefined),
    ).toEqual(["neither ANTHROPIC_API_KEY nor ANTHROPIC_OAUTH_TOKEN is set"]);

    // And the two reasons are independent: a binary without a credential names one thing, an
    // environment without either names the other, and neither hides the other.
    expect(missingIn(false, { ANTHROPIC_OAUTH_TOKEN: "not-a-real-token" }, undefined)).toEqual([
      "the `pi` binary is not on PATH",
    ]);
    expect(missingIn(false, {}, undefined)).toEqual([
      "the `pi` binary is not on PATH",
      "neither ANTHROPIC_API_KEY nor ANTHROPIC_OAUTH_TOKEN is set",
    ]);
  });

  /**
   * **The switch is a third reason to skip, and it is independent of the other two** — ticket 55.
   *
   * A machine with pi installed and a credential exported still must not spend unless somebody
   * said so. Graded here against a synthetic refusal so it holds whatever this machine's own
   * environment says, exactly as the credential half is.
   */
  it("counts the spend switch among the reasons, without hiding the others", () => {
    const refused = "KOJO_AGENT_SPEND is not set and no terminal is attached";

    expect(missingIn(true, { ANTHROPIC_OAUTH_TOKEN: "not-a-real-token" }, refused)).toEqual([
      `${spendVariable} does not allow it — ${refused}`,
    ]);

    // All three at once, in the order a reader meets them: what is missing, then what is not
    // permitted. None of the three hides another.
    expect(missingIn(false, {}, refused)).toEqual([
      "the `pi` binary is not on PATH",
      "neither ANTHROPIC_API_KEY nor ANTHROPIC_OAUTH_TOKEN is set",
      `${spendVariable} does not allow it — ${refused}`,
    ]);
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

      // Criterion 4, against the binary rather than against a fixture. Both roots are named here,
      // so `--session-dir` is passed and the layout is **flat** — the transcript is in the root
      // itself, which is the only directory `--session` then reads. If pi's layout is not what
      // ticket 56 read off its source, this is the line that says so, for the price of a call that
      // has already happened.
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
