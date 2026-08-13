import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { Activity } from "effect/unstable/workflow";
import { AgentAnswer } from "../../src/contexts/agent/models/AgentAnswer.ts";
import { AgentInvocationError } from "../../src/contexts/agent/models/AgentInvocationError.ts";
import type { AgentSessionId } from "../../src/contexts/agent/models/AgentSessionId.ts";
import type { AgentCall } from "../../src/contexts/agent/ports/AgentInvoker.ts";
import { AgentInvoker } from "../../src/contexts/agent/ports/AgentInvoker.ts";
import { Sandbox } from "../../src/contexts/sandbox/ports/Sandbox.ts";

/**
 * An agent that is a real process inside the real sandbox.
 *
 * Not `InMemoryAgentInvoker` and not a model either. The real Sandcastle-backed invoker is ticket
 * 15's, and until it exists the only honest way to ask *does an agent invocation actually happen
 * inside the container, and does the correlation reach it* is to run a command through the same
 * `Sandbox` handle a real invoker will run one through, and read the answer back out.
 *
 * Three things about it are deliberately faithful to what a real invoker has to do, and they are the
 * three this suite grades:
 *
 * - **It runs through `Sandbox.exec`, not through `Workspace`.** For a bind-mount provider the
 *   workspace is a directory on the host, so a command run through it is a host process that never
 *   sees `KOJO_RUN_ID`. The agent runs *in the container*, and that is where the correlation is.
 * - **Per-invocation environment goes on the command line.** `SandboxExecOptions` has no `env`, and
 *   neither does Sandcastle's. An agent provider's own `env` is not the door either: on the paths
 *   that merge it, `mergeProviderEnv` *throws* on any key the sandbox provider already set, and on
 *   the `createSandbox` path Kojo uses it is passed as `{}` and silently dropped. What is left is an
 *   `env NAME=value …` prefix at exec time, which is what this does.
 * - **The session is a file on the host.** That is what a bind-mount provider's session capture
 *   leaves behind, and it is why a rebuilt sandbox can resume a conversation the previous container
 *   was holding: the container is gone, the transcript is not.
 */

/** POSIX single-quoting, the same rule `SandboxExecWorkspace` uses for the same reason. */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

export interface InSandboxAgentOptions {
  /** Host directory the transcripts live in. Survives the container, and the process. */
  readonly sessions: string;
  /** One shell script per roster name. It reads `$KOJO_PROMPT` and prints the envelope. */
  readonly scripts: Record<string, string>;
  /**
   * Whether the invocation stamps its own `KOJO_ATTEMPT` over the container's.
   *
   * Off, the agent process sees what the acquisition stamped — run id, sandbox id, attempt `0`.
   * On, the attempt becomes the phase's own, through the only door that exists. Both readings are
   * asserted, because "the correlation reaches the agent" and "an invocation can override it" are
   * two claims and only the first one was ever argued.
   */
  readonly stampAttempt?: boolean;
}

/** One line of transcript. Enough to count turns and to see the conversation continued. */
interface Turn {
  readonly prompt: string;
  readonly output: string;
}

const transcriptOf = (path: string): ReadonlyArray<Turn> => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Turn);
  } catch {
    return [];
  }
};

export const layer = (options: InSandboxAgentOptions): Layer.Layer<AgentInvoker, never, Sandbox> =>
  Layer.effect(
    AgentInvoker,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;

      const fileFor = (session: AgentSessionId): string =>
        join(options.sessions, `${session}.jsonl`);

      const invoke = (call: AgentCall): Effect.Effect<AgentAnswer, AgentInvocationError> =>
        Effect.gen(function* () {
          const script = options.scripts[call.agent];
          if (script === undefined) {
            return yield* new AgentInvocationError({
              agent: call.agent,
              fault: "unknown-agent",
              reason: `no script for ${call.agent}`,
              cause: undefined,
            });
          }

          // A cold call opens a session named after this run's own acquisition, so two runs cannot
          // land in one transcript. `crypto.randomUUID` and not a counter, for the reason
          // `makeSandboxId` gives: the process that resumes a run is not the one that started it.
          const session = Option.getOrElse(
            call.session,
            () => `${call.agent}-${crypto.randomUUID()}` as AgentSessionId,
          );
          const path = fileFor(session);
          const before = transcriptOf(path);

          const attempt = yield* Activity.CurrentAttempt;
          const environment: Record<string, string> = {
            KOJO_PROMPT: call.prompt,
            KOJO_TURN: String(before.length + 1),
            // The agent reports the session it ran in, the way a real one does — pi emits a
            // `session_id` stream event. It is how the id reaches the author's envelope, and
            // therefore how a revision knows what conversation to re-enter.
            KOJO_SESSION: session,
            ...(options.stampAttempt === true ? { KOJO_ATTEMPT: String(attempt) } : {}),
          };

          const prefix = Object.entries(environment)
            .map(([name, value]) => `${name}=${quote(value)}`)
            .join(" ");

          const result = yield* sandbox.exec(`env ${prefix} sh -c ${quote(script)}`).pipe(
            Effect.mapError(
              (cause) =>
                new AgentInvocationError({
                  agent: call.agent,
                  fault: "provider-failed",
                  reason: cause.reason,
                  cause,
                }),
            ),
          );

          if (!result.succeeded) {
            return yield* new AgentInvocationError({
              agent: call.agent,
              fault: "provider-failed",
              // Both streams and the command line. A shell that cannot find something exits 127
              // and sometimes says nothing at all, so a reason built from stderr alone is a reason
              // that reads "the agent exited 127:" and leaves the reader nowhere to go.
              reason: [
                `the agent exited ${result.exitCode}`,
                `stderr: ${result.stderr.trim()}`,
                `stdout: ${result.stdout.trim()}`,
                `command: ${result.argv.join(" ")}`,
              ].join(" · "),
              cause: undefined,
            });
          }

          const output = result.stdout.trim();
          yield* Effect.sync(() => {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `${JSON.stringify({ prompt: call.prompt, output })}\n`);
          });

          return new AgentAnswer({
            agent: call.agent,
            model: "sh",
            session,
            resumed: Option.isSome(call.session),
            tokensIn: call.prompt.length,
            tokensOut: output.length,
            output,
          });
        });

      return {
        // Both true, and both earned: the transcript is a host file, so a call can re-enter one and
        // a rebuilt container inherits it.
        capabilities: { resume: true, capture: true },
        invoke,
      } satisfies AgentInvoker["Service"];
    }),
  );

/** How many turns a session holds, read from the host. The assertion a resume actually happened. */
export const turns = (sessions: string, session: string): number =>
  transcriptOf(join(sessions, `${session}.jsonl`)).length;
