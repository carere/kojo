import type { AgentProvider } from "@ai-hero/sandcastle";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Result, Schema } from "effect";
import * as SandcastleAgentInvoker from "../../../../../src/contexts/agent/adapters/SandcastleAgentInvoker.ts";
import * as YamlRoster from "../../../../../src/contexts/agent/adapters/YamlRoster.ts";
import type { AgentSessionId } from "../../../../../src/contexts/agent/models/AgentSessionId.ts";
import type { AgentSpend } from "../../../../../src/contexts/agent/models/AgentSpend.ts";
import { spendVariable } from "../../../../../src/contexts/agent/models/AgentSpend.ts";
import { AgentInvoker } from "../../../../../src/contexts/agent/ports/AgentInvoker.ts";
import { acquireSandbox } from "../../../../../src/contexts/sandbox/adapters/boundary.ts";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import type { SandboxHandle } from "../../../../../src/contexts/sandbox/models/SandboxHandle.ts";
import { Sandbox } from "../../../../../src/contexts/sandbox/ports/Sandbox.ts";
import { decodeUnknown } from "../../../../../src/contexts/shared/lib/decode.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import { EnvelopeBase } from "../../../../../src/contexts/workflow/models/Envelope.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { withCorrections } from "../../../../../src/contexts/workflow/services/corrections.ts";
import { throwawayRepo } from "../../../../support/throwawayRepo.ts";

/**
 * The real invoker, the real sandbox, a real process — and no model.
 *
 * Everything here is the adapter under test, unmodified: `acquireSandbox` builds a real Sandcastle
 * sandbox on a real branch, `YamlRoster` decodes the real `kojo.config.yaml` a real `kojo init`
 * stamped, and `sandbox.run(...)` spawns a real process inside it. The only thing that is not real
 * is the **model** — the `AgentProvider` below runs a shell script.
 *
 * That is deliberate, and it is where this ticket's budget went. Five real agent calls buy the three
 * claims only a model can settle: that a real envelope decodes, that a real decode failure drives
 * the correction loop, and that permissions catch a real agent's real writes. Everything else about
 * the adapter — that the roster's identity reaches the process because `claudeCode()` cannot carry
 * it, that the prompt travels on stdin, that a session opened by one turn is re-entered by the next
 * without repeating the identity, that a missing roster entry is `unknown-agent` while a dead binary
 * is `provider-failed`, that an answer with no session is refused — is settled here, for free,
 * against the same code path.
 */

/**
 * An `AgentProvider` that spawns a shell script and speaks Sandcastle's stream protocol.
 *
 * It is a real provider by every test Sandcastle applies to one: `run()` calls `buildPrintCommand`,
 * pipes the prompt to the process on stdin, and feeds every stdout line back through
 * `parseStreamLine`. Nothing on the path being graded knows the difference.
 *
 * `sessionStorage` is present because that field is what the invoker reads to decide whether a
 * conversation can be re-entered at all. Its two transfer methods are never reached on a `none`
 * sandbox — the agent runs on the host and writes its session in place — so they refuse rather than
 * pretend to have moved something.
 */
/**
 * POSIX single-quoting, with the close-reopen trick.
 *
 * `JSON.stringify` is wrong here and the failure is quiet: Sandcastle runs the command through a
 * shell, and a `\n` inside double quotes stays as the two characters backslash and `n` — so a
 * two-line script becomes one line with `nprintf` in the middle of it, and the error a test then
 * reads is about a file called `/dev/nullnprintf`.
 */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

const scripted = (script: string): AgentProvider => ({
  name: "scripted",
  env: {},
  captureSessions: false,
  sessionStorage: {
    captureToHost: () => Promise.reject(new Error("no capture on a host run")),
    resumeIntoSandbox: () => Promise.reject(new Error("no transfer on a host run")),
    readHostSession: () => Promise.resolve(undefined),
    existsOnHost: () => Promise.resolve(true),
    hostSessionFilePath: () => undefined,
    findByIdOnHost: (id) => Promise.resolve({ path: `/dev/null/${id}`, searchedRoot: "/dev/null" }),
  },
  buildPrintCommand: ({ prompt, resumeSession }) => ({
    // The prompt goes on **stdin**, exactly as it does for every real provider: Linux caps one
    // argument at 128 KB and a prompt carrying a JSON Schema plus a diff reaches that.
    command: `KOJO_RESUME=${quote(resumeSession ?? "")} sh -c ${quote(script)}`,
    stdin: prompt,
  }),
  parseStreamLine: (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("@session ")) {
      return [{ type: "session_id", sessionId: trimmed.slice("@session ".length) }];
    }
    return trimmed === "" ? [] : [{ type: "text", text: `${line}\n` }];
  },
});

/**
 * A script that records the prompt it was handed and answers with a fixed envelope.
 *
 * The prompt is written to a **file** rather than echoed to stdout, and that is not tidiness: the
 * invoker narrows stdout to the envelope before it hands the answer back, so a prompt echoed to
 * stdout would be narrowed away — and the JSON Schema inside it would be what came out. The
 * assertion has to read what actually reached the process, so it reads the file.
 */
const recording = (log: string, envelope: string): string =>
  [
    "prompt=$(cat)",
    `printf '%s' "$prompt" >> ${JSON.stringify(log)}`,
    `printf 'PROMPT-END\\n' >> ${JSON.stringify(log)}`,
    // The session is a function of nothing, so a resumed turn reports the id it was given back —
    // which is what a real provider does when it re-enters a conversation.
    'if [ -n "$KOJO_RESUME" ]; then printf "@session %s\\n" "$KOJO_RESUME"; else printf "@session scripted-cold\\n"; fi',
    `printf '%s\\n' ${JSON.stringify(envelope)}`,
  ].join("\n");

/** Every prompt the scripted agent was handed, in order. */
const promptsIn = (
  log: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
    return text.split("PROMPT-END\n").filter((entry) => entry.trim() !== "");
  });

interface Fixture {
  readonly root: string;
  /** Where the scripted agent records the prompts it was handed. */
  readonly log: string;
  readonly agent: AgentInvoker["Service"];
}

/**
 * What this file declares to the spend guard, and why it is allowed to.
 *
 * The provider under test is the `scripted` object above — built in this file, spawning `sh` with a
 * script this file wrote. There is no binary name to resolve and no model to reach, so the mode that
 * checks a resolution has nothing to check here. What makes this safe is not the declaration; it is
 * that a reader can see the whole provider on this page.
 *
 * **The seam is `layer`'s and not `fromConfig`'s, deliberately.** A stamped workflow calls
 * `fromConfig`, which takes no spend, so no factory can turn the guard off from a workflow file —
 * only in-process TypeScript, which means Kojo's own tests.
 */
const allowed = {
  _tag: "Allow",
  because: "the provider is a script this test file wrote",
} as const;

const withScriptedAgent = <A, E>(
  script: (log: string) => string,
  use: (fixture: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  /** `"environment"` passes nothing at all, which is how the default is graded. */
  spend: AgentSpend | "environment" = allowed,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repo = yield* throwawayRepo({ model: "sonnet" });
    const log = path.join(repo.root, "prompts.log");

    const acquired = yield* acquireSandbox({
      branch: "kojo/scripted",
      provider: noSandbox(),
      cwd: repo.root,
    });
    const sandbox: SandboxHandle = {
      ...acquired,
      id: makeSandboxId("run-scripted", "review", 0, 1),
      environment: {},
    };

    const layer = SandcastleAgentInvoker.layer({
      provider: () => scripted(script(log)),
      ...(spend === "environment" ? {} : { spend }),
    }).pipe(
      Layer.provide(
        YamlRoster.layer({ config: path.join(repo.root, ".kojo", "kojo.config.yaml") }).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
      Layer.provide(Layer.succeed(Sandbox, sandbox)),
      Layer.orDie,
    );

    return yield* Effect.gen(function* () {
      const agent = yield* AgentInvoker;
      return yield* use({ root: repo.root, log, agent });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const anEnvelope = '{"_tag":"Drafted","summary":"done","files":["notes/hello.txt"]}';

describe("the Sandcastle agent invoker", () => {
  /**
   * **The roster's identity reaches the process, because nothing else carries it.**
   *
   * `claudeCode()` is used as it ships — the ticket's decision — and it builds
   * `claude --print --verbose --output-format stream-json --model X -p -`. There is no
   * `--system-prompt` in it and no `--tools`. An agent is a system prompt, a tool allowlist and a
   * model, so a roster entry handed to the stock provider spawns a *different agent* and succeeds
   * while doing it. The prompt is the only door left; this asserts it is used, by reading the
   * drafter's own stamped `system.md` and `user.md` back out of the process that really ran.
   */
  it.live("sends the roster's system prompt and task template into the real process", () =>
    withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          const answer = yield* fixture.agent.invoke({
            agent: "drafter",
            prompt: "Make the note say goodbye.",
            session: Option.none(),
          });

          const [sent = ""] = yield* promptsIn(fixture.log);
          // From `prompts/drafter/system.md` — the identity.
          expect(sent).toContain("# The drafter");
          // From `prompts/drafter/user.md` — the task template.
          expect(sent).toContain("Work in the repository you are standing in.");
          // And the task the phase passed through.
          expect(sent).toContain("Make the note say goodbye.");
          // The identity comes first: it is who the agent is, before what it was asked.
          expect(sent.indexOf("# The drafter")).toBeLessThan(sent.indexOf("Make the note"));

          expect(answer.output).toBe(anEnvelope);
          expect(answer.model).toBe("sonnet");
          expect(answer.resumed).toBe(false);
          expect(answer.session).toBe("scripted-cold");
        }),
    ),
  );

  /**
   * A correction is one more message, and this is what proves the invoker can send one.
   *
   * The second call carries a session, so `--resume` reaches the provider and the identity does
   * **not** travel again — re-sending it would make the cheap retry the correction loop rests on
   * cost as much as a cold start.
   */
  it.live("re-enters a session on the second turn, and does not repeat the identity", () =>
    withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          expect(fixture.agent.capabilities.resume).toBe(true);
          // `none` never pulls a transcript back, because the agent wrote it on the host already.
          expect(fixture.agent.capabilities.capture).toBe(false);

          const first = yield* fixture.agent.invoke({
            agent: "drafter",
            prompt: "first",
            session: Option.none(),
          });
          const second = yield* fixture.agent.invoke({
            agent: "drafter",
            prompt: "Those fields are wrong. Answer again.",
            session: Option.some(first.session),
          });

          expect(second.resumed).toBe(true);
          expect(second.session).toBe(first.session);

          const [cold = "", correction = ""] = yield* promptsIn(fixture.log);
          expect(cold).toContain("# The drafter");
          expect(correction).not.toContain("# The drafter");
          expect(correction).toBe("Those fields are wrong. Answer again.");
        }),
    ),
  );

  /** The answer is narrowed to the envelope before the phase ever sees it. */
  it.live("hands back the object out of an answer that had prose around it", () =>
    withScriptedAgent(
      (log) => [recording(log, anEnvelope), `printf 'That is the change I made.\\n'`].join("\n"),
      (fixture) =>
        Effect.gen(function* () {
          const answer = yield* fixture.agent.invoke({
            agent: "drafter",
            prompt: "anything",
            session: Option.none(),
          });

          expect(answer.output).toBe(anEnvelope);
        }),
    ),
  );

  /**
   * A name the roster does not hold is `unknown-agent`, never `provider-failed`.
   *
   * The difference decides where the reader goes: `unknown-agent` is a mistake in the workflow that
   * no better prompt fixes. Nothing is spawned, so the prompt log stays empty.
   */
  it.live("refuses a name the roster does not define, without spawning anything", () =>
    withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.result(
            fixture.agent.invoke({ agent: "nobody", prompt: "hello", session: Option.none() }),
          );

          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure.fault).toBe("unknown-agent");
            expect(outcome.failure.agent).toBe("nobody");
          }
          expect(yield* promptsIn(fixture.log)).toEqual([]);
        }),
    ),
  );

  /** A binary that exits non-zero never produced an answer, and says so as `provider-failed`. */
  it.live("reports a process that died as provider-failed", () =>
    withScriptedAgent(
      () => ["cat > /dev/null", 'echo "the model is unreachable" >&2', "exit 3"].join("\n"),
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.result(
            fixture.agent.invoke({ agent: "drafter", prompt: "hello", session: Option.none() }),
          );

          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure.fault).toBe("provider-failed");
            expect(outcome.failure.reason).toContain("the model is unreachable");
          }
        }),
    ),
  );

  /**
   * **The spend switch, honoured by the adapter that spawns the process.** Ticket 49.
   *
   * The proof that it refused *before a process existed* is the prompt log: the scripted agent
   * appends every prompt it is handed, and a refusal that happened after the spawn would leave one
   * there. An empty log is the same evidence the `unknown-agent` case above rests on.
   */
  it.live("refuses before anything is spawned when the switch says refuse", () =>
    withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.result(
            fixture.agent.invoke({ agent: "drafter", prompt: "hello", session: Option.none() }),
          );

          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure.fault).toBe("refused-to-spend");
            expect(outcome.failure.reason).toContain(spendVariable);
            // What would have been called — the agent, the provider, the model, and the run.
            expect(outcome.failure.reason).toContain("drafter");
            expect(outcome.failure.reason).toContain("scripted");
            expect(outcome.failure.reason).toContain("sonnet");
            expect(outcome.failure.reason).toContain("run-scripted");
          }

          // Nothing ran. This is the criterion, and the log is what grades it.
          expect(yield* promptsIn(fixture.log)).toEqual([]);
        }),
      { _tag: "Refuse", because: `${spendVariable}=refuse` },
    ),
  );

  /**
   * **On by default, proven in the environment rather than argued about it.**
   *
   * No `spend` is passed, so the adapter reads this process: a Vitest worker, whose stdin is a pipe
   * and not a terminal. That is exactly the shape of every context this repository runs unattended —
   * the integration tier, the browser tier, CI, and an agent driving a shell — and it is the shape
   * both unauthorised calls in this build were spent in.
   *
   * The variable is cleared for the duration so the test grades the **default** and not whatever the
   * operator's shell happens to hold.
   */
  it.live("refuses by default in an unattended process, with nothing declared", () => {
    const declared = process.env[spendVariable];
    delete process.env[spendVariable];

    return withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          // The premise, asserted rather than assumed: no terminal, nothing declared.
          expect(process.stdin.isTTY).not.toBe(true);
          expect(process.env[spendVariable]).toBeUndefined();

          const outcome = yield* Effect.result(
            fixture.agent.invoke({ agent: "drafter", prompt: "hello", session: Option.none() }),
          );

          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure.fault).toBe("refused-to-spend");
            expect(outcome.failure.reason).toContain("no terminal is attached");
          }
          expect(yield* promptsIn(fixture.log)).toEqual([]);
        }),
      // The point is what the adapter does when it is told nothing at all.
      "environment",
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (declared !== undefined) process.env[spendVariable] = declared;
        }),
      ),
    );
  });

  /**
   * An agent that answers and reports no session is a failure, not an answer.
   *
   * The session is what the next turn re-enters, and there is no second chance to learn it: the
   * transcript is named after the id. Handing the answer back with a made-up session would move the
   * failure two turns downstream and turn it into a message about a missing file.
   */
  it.live("refuses an answer that carries no session id", () =>
    withScriptedAgent(
      () => ["cat > /dev/null", `printf '%s\\n' '{"_tag":"Drafted"}'`].join("\n"),
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.result(
            fixture.agent.invoke({ agent: "drafter", prompt: "hello", session: Option.none() }),
          );

          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure.fault).toBe("provider-failed");
            expect(outcome.failure.reason).toContain("no session id");
          }
        }),
    ),
  );
});

/** The stamped factory's own envelope, declared here so the decode under test is the real one. */
class Drafted extends EnvelopeBase.extend<Drafted>("Drafted")({
  _tag: Schema.tag("Drafted"),
  summary: Schema.String,
  files: Schema.Array(Schema.String),
}) {}

/**
 * Prose on the cold turn, the envelope on the resumed one — decided by the process, not by the test.
 *
 * `$KOJO_RESUME` is empty on a cold call and carries the session id on a resumed one, which is the
 * same signal a real agent gets from `--resume`. Both answers come out of one script, and which one
 * comes out is decided by whether the invoker really re-entered the conversation.
 */
const proseThenEnvelope = (log: string): string =>
  [
    "prompt=$(cat)",
    `printf '%s' "$prompt" >> ${JSON.stringify(log)}`,
    `printf 'PROMPT-END\\n' >> ${JSON.stringify(log)}`,
    'if [ -n "$KOJO_RESUME" ]; then',
    '  printf "@session %s\\n" "$KOJO_RESUME"',
    `  printf '%s\\n' '${anEnvelope}'`,
    "else",
    '  printf "@session scripted-cold\\n"',
    "  printf 'I made the change: notes/hello.txt now says goodbye as well.\\n'",
    "fi",
  ].join("\n");

/**
 * **The correction loop end to end, with everything real except the model's judgement.**
 *
 * A real process answers with real prose; the real narrower hands that prose back unchanged; the
 * real decoder refuses it and builds a real `EnvelopeParseError` out of the real issue tree;
 * `withCorrections` turns that into the real correction prompt; the real invoker sends it back into
 * the **same session** through the real sandbox; and the real second answer decodes.
 *
 * What a model adds to this is the willingness to get it wrong the first time, and this ticket's
 * budget bought that separately — see `tests/integration/cli/realAgent.test.ts`. What is graded here
 * is the machinery, which is the part that can break silently.
 */
describe("a real answer that does not decode, and the correction that repairs it", () => {
  it.live(
    "re-prompts the same session with the decoder's own complaint, and the retry succeeds",
    () =>
      withScriptedAgent(proseThenEnvelope, (fixture) =>
        Effect.gen(function* () {
          let turns = 0;
          let session = Option.none<AgentSessionId>();

          const drafted = yield* withCorrections(
            (correction: Option.Option<string>) =>
              Effect.gen(function* () {
                turns += 1;
                const answer = yield* fixture.agent
                  .invoke({
                    agent: "drafter",
                    prompt: Option.getOrElse(correction, () => "Make the note say goodbye."),
                    session,
                  })
                  .pipe(Effect.orDie);
                session = Option.some(answer.session);

                return yield* decodeUnknown(Schema.fromJsonString(Drafted))(answer.output).pipe(
                  Effect.mapError((error) =>
                    EnvelopeParseError.fromSchemaError(
                      { agent: answer.agent, expected: "Drafted", raw: answer.output },
                      error,
                    ),
                  ),
                );
              }),
            1,
          );

          // Two turns, and the second one is what produced the answer.
          expect(turns).toBe(2);
          expect(drafted.files).toEqual(["notes/hello.txt"]);

          const [cold = "", repair = ""] = yield* promptsIn(fixture.log);
          // The cold turn carried the identity; the repair carried the decoder's complaint instead.
          expect(cold).toContain("# The drafter");
          expect(repair).toContain("was not a valid `Drafted`");
          expect(repair).toContain("These fields are wrong:");
          expect(repair).toContain("Answer again with the whole `Drafted`");
          expect(repair).not.toContain("# The drafter");
        }),
      ),
  );
});
