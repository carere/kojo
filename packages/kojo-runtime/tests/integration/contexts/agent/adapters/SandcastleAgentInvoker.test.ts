import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@ai-hero/sandcastle";
import * as BunServices from "@effect/platform-bun/BunServices";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Result, Schema } from "effect";
import * as SandcastleAgentInvoker from "../../../../../src/contexts/agent/adapters/SandcastleAgentInvoker.ts";
import type { AgentSessionId } from "../../../../../src/contexts/agent/models/AgentSessionId.ts";
import {
  type AgentCall,
  AgentInvoker,
} from "../../../../../src/contexts/agent/ports/AgentInvoker.ts";
import * as DaemonResourceLeaseClient from "../../../../../src/contexts/project/adapters/DaemonResourceLeaseClient.ts";
import { acquireSandbox } from "../../../../../src/contexts/sandbox/adapters/boundary.ts";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import type { SandboxHandle } from "../../../../../src/contexts/sandbox/models/SandboxHandle.ts";
import { Sandbox } from "../../../../../src/contexts/sandbox/ports/Sandbox.ts";
import { decodeUnknown } from "../../../../../src/contexts/shared/lib/decode.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import * as DaemonArtifactPublisher from "../../../../../src/contexts/trace/adapters/DaemonArtifactPublisher.ts";
import { EnvelopeBase } from "../../../../../src/contexts/workflow/models/Envelope.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { withCorrections } from "../../../../../src/contexts/workflow/services/corrections.ts";
import { sandboxResourcesAt } from "../../../../support/sandboxResources.ts";
import { throwawayRepo } from "../../../../support/throwawayRepo.ts";

const gitConfigurationRoot = mkdtempSync(join(tmpdir(), "kojo-sandcastle-git-config-"));
const gitConfiguration = join(gitConfigurationRoot, "config");
writeFileSync(gitConfiguration, "", { mode: 0o600 });
const previousGitConfiguration = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = gitConfiguration;

afterAll(() => {
  if (previousGitConfiguration === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfiguration;
  rmSync(gitConfigurationRoot, { recursive: true, force: true });
});

/** The real invoker, Daemon adapters, sandbox, and process use a scripted provider. */

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
  readonly selection: Pick<AgentCall, "model" | "system" | "provider">;
  readonly root: string;
  /** Where the scripted agent records the prompts it was handed. */
  readonly log: string;
  readonly agent: AgentInvoker["Service"];
}

/** The concrete private-channel adapters, with their transport kept inside this fixture. */
const daemonExecutionAdaptersAt = (root: string) => {
  const field = (body: unknown, name: string): string => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`the ${name} field is absent from the private-channel request`);
    }
    const value = (body as Record<string, unknown>)[name];
    if (typeof value !== "string") {
      throw new Error(`the ${name} field is absent from the private-channel request`);
    }
    return value;
  };
  return Layer.merge(
    DaemonResourceLeaseClient.layer(async (kind, body) =>
      kind === "BeginResourceAcquisition"
        ? {
            acquisitionKey: field(body, "acquisitionKey"),
            providerIdentity: `process:${field(body, "kind")}:${field(body, "acquisitionKey")}`,
            inspectionLocator: `${root}/.kojo-test-registry/${encodeURIComponent(field(body, "acquisitionKey"))}.json`,
          }
        : {},
    ),
    DaemonArtifactPublisher.layer("run-scripted", async (kind, body) =>
      kind === "FinishArtifact" ? { artifactId: `artifact:${field(body, "transferId")}` } : {},
    ),
  );
};

const withScriptedAgent = <A, E>(
  script: (log: string) => string,
  use: (fixture: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repo = yield* throwawayRepo({ model: "sonnet" });
    const log = path.join(repo.root, "prompts.log");

    const acquired = yield* acquireSandbox({
      branch: "kojo/scripted",
      provider: noSandbox(),
      cwd: repo.root,
      resources: sandboxResourcesAt(repo.root, "kojo/scripted"),
    });
    const sandbox: SandboxHandle = {
      ...acquired,
      id: makeSandboxId("run-scripted", "review", 0, 1),
      environment: {},
    };

    const selection = {
      model: "sonnet",
      system: "# The drafter",
      provider: () => scripted(script(log)),
    };
    const layer = SandcastleAgentInvoker.layer.pipe(
      Layer.provide(Layer.succeed(Sandbox, sandbox)),
      Layer.provide(daemonExecutionAdaptersAt(repo.root)),
      Layer.orDie,
    );

    return yield* Effect.gen(function* () {
      const agent = yield* AgentInvoker;
      return yield* use({ root: repo.root, log, agent, selection });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const anEnvelope = '{"_tag":"Drafted","summary":"done","files":["notes/hello.txt"]}';

describe("the Sandcastle agent invoker", () => {
  it.live("selects the provider, model, and prompts at the call", () =>
    withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          const answer = yield* fixture.agent.invoke({
            ...fixture.selection,
            agent: "drafter",
            model: "direct-model",
            system: "DIRECT SYSTEM",
            provider: () => scripted(recording(fixture.log, anEnvelope)),
            prompt: "Make the note say goodbye.",
            session: Option.none(),
          });

          const [sent = ""] = yield* promptsIn(fixture.log);
          expect(sent).toContain("DIRECT SYSTEM");
          expect(sent).not.toContain("Work in the repository you are standing in.");
          // And the task the phase passed through.
          expect(sent).toContain("Make the note say goodbye.");
          // The identity comes first: it is who the agent is, before what it was asked.
          expect(sent.indexOf("DIRECT SYSTEM")).toBeLessThan(sent.indexOf("Make the note"));

          expect(answer.output).toBe(anEnvelope);
          expect(answer.model).toBe("direct-model");
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
          expect(
            fixture.agent.capabilities({
              ...fixture.selection,
              agent: "drafter",
              prompt: "",
              session: Option.none(),
            }).resume,
          ).toBe(true);
          // `none` never pulls a transcript back, because the agent wrote it on the host already.
          expect(
            fixture.agent.capabilities({
              ...fixture.selection,
              agent: "drafter",
              prompt: "",
              session: Option.none(),
            }).capture,
          ).toBe(false);

          const first = yield* fixture.agent.invoke({
            ...fixture.selection,
            agent: "drafter",
            prompt: "first",
            session: Option.none(),
          });
          const second = yield* fixture.agent.invoke({
            ...fixture.selection,
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
            ...fixture.selection,
            agent: "drafter",
            prompt: "anything",
            session: Option.none(),
          });

          expect(answer.output).toBe(anEnvelope);
        }),
    ),
  );

  it.live("accepts an agent label without a roster entry", () =>
    withScriptedAgent(
      (log) => recording(log, anEnvelope),
      (fixture) =>
        Effect.gen(function* () {
          const answer = yield* fixture.agent.invoke({
            ...fixture.selection,
            agent: "nobody",
            prompt: "hello",
            session: Option.none(),
          });
          expect(answer.agent).toBe("nobody");
          expect(answer.output).toBe(anEnvelope);
          expect(yield* promptsIn(fixture.log)).toHaveLength(1);
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
            fixture.agent.invoke({
              ...fixture.selection,
              agent: "drafter",
              prompt: "hello",
              session: Option.none(),
            }),
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
            fixture.agent.invoke({
              ...fixture.selection,
              agent: "drafter",
              prompt: "hello",
              session: Option.none(),
            }),
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
                    ...fixture.selection,
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
