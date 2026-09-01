import type { AgentProvider } from "@ai-hero/sandcastle";
import { claudeCode } from "@ai-hero/sandcastle";
import { Effect, Layer, Option } from "effect";
import { Sandbox } from "../../sandbox/ports/Sandbox.ts";
import { maySpawn } from "../guards/maySpawn.ts";
import { AgentAnswer } from "../models/AgentAnswer.ts";
import type { AgentDefinition } from "../models/AgentDefinition.ts";
import { AgentInvocationError } from "../models/AgentInvocationError.ts";
import type { AgentSessionId } from "../models/AgentSessionId.ts";
import type { AgentSpend } from "../models/AgentSpend.ts";
import { spendFrom, spendVariable } from "../models/AgentSpend.ts";
import type { RosterError } from "../models/RosterError.ts";
import type { AgentCall, AgentCapabilities } from "../ports/AgentInvoker.ts";
import { AgentInvoker } from "../ports/AgentInvoker.ts";
import { Roster } from "../ports/Roster.ts";
import { envelopeBlock } from "../services/envelopeBlock.ts";
import { renderPrompt } from "../services/renderPrompt.ts";
import * as YamlRoster from "./YamlRoster.ts";

/**
 * The reference agent invoker: a real agent process, in the sandbox the phase is standing in.
 *
 * It is the one adapter that makes `kojo run` cost money, and it is built out of two things that
 * already existed and were never joined — Sandcastle's agent providers, and Kojo's `Sandbox` handle.
 * Everything below is the join, and the four decisions in it are the ones worth reading.
 *
 * **1. It requires `Sandbox`, so it is provided *inside* the scope, never at the factory.**
 * `AgentInvoker.invoke` returns an `Effect` with no requirements — a phase asks for an agent, not
 * for a container — so the sandbox has to be captured when the layer is built. A sandbox only exists
 * inside a `sandboxed` region, so this layer is provided by the workflow body inside that region and
 * shadows whatever the factory wired (normally `AbsentAgentInvoker`). That is also what makes the
 * agent land in the *right* container when a factory has two lanes with different images.
 *
 * **2. `claudeCode()` is used exactly as it ships, and the roster's identity therefore travels in
 * the prompt.** `claudeCode(model)` builds `claude --print --verbose --output-format stream-json
 * --model <model> [--resume <id>] -p -`. There is no `--system-prompt` and no `--tools` in it. An
 * agent is a system prompt, a tool allowlist and a model, so handing a roster entry to the stock
 * provider would spawn a *different agent* than the roster describes — and it would succeed while
 * doing it. `kojoPi` solves the same problem for pi by writing a provider, because pi has the flags.
 * Claude does not, so the identity goes in the text of the turn. See `renderPrompt`.
 *
 * **3. Kojo passes no credentials.** There is no `env` here and no secret read from anywhere. The
 * `claude` binary authenticates with the operator's own ambient session, so a token never enters a
 * Kojo value and therefore cannot reach a trace row. The only environment that crosses into the
 * container is the run correlation the acquisition stamped (`correlationEnvironment` — three
 * `KOJO_*` keys), and `SandboxRecord.environment` records exactly that and is asserted on.
 *
 * **4. The capabilities are the intersection of two matrices, and it is asked rather than assumed.**
 * A session can be re-entered only if the sandbox kind allows it *and* the agent provider has
 * session storage at all. The correction loop reads `resume` before it spends a turn, so getting
 * this wrong does not fail — it silently sends a correction as a cold call carrying none of the
 * context that earned it.
 *
 * **5. It asks the spend switch before it asks the sandbox, and an unattended process is refused by
 * default.** This is the one adapter in Kojo that can cost somebody money, so it is the one that
 * has to hold the guard: a check anywhere above it protects whatever called it, and a check in a
 * test protects the test tier. `maySpawn` decides, `AgentSpend` reads the switch, and the refusal
 * is a `refused-to-spend` raised **before `sandbox.agent` is reached**, so no process exists to
 * have spent anything. See ticket 49 and `build-record.md` §9 for the two calls this cost.
 */

/** Which Sandcastle agent provider a roster entry becomes. */
export type ProviderFor = (definition: AgentDefinition) => AgentProvider;

/**
 * The stock Claude Code provider, at the model the roster names.
 *
 * No options. `effort` is a model choice the roster does not carry, `permissionMode` would replace
 * the `--dangerously-skip-permissions` Sandcastle passes on an unattended run, and `env` is the door
 * credentials would come through — so the honest default is to pass none of them.
 */
export const claude: ProviderFor = (definition) => claudeCode(definition.model);

export interface SandcastleAgentOptions {
  /**
   * How a roster entry becomes a provider. Defaults to `claude`.
   *
   * A seam and not a knob: it is what lets an integration test drive this whole adapter — the real
   * sandbox, the real process, the real stream parser, the real session — against a provider that
   * spawns a script instead of a model, and so grade everything except the model's judgement without
   * spending anything.
   */
  readonly provider?: ProviderFor | undefined;
  /**
   * What this invoker may spawn. Defaults to whatever {@link spendVariable} says.
   *
   * A seam for the same reason as `provider`, and it must never become the way a *run* turns the
   * guard off: `cli/` passes none of this, so every real invocation reads the environment. A test
   * that needs a specific mode states it here and is graded on the refusal it gets.
   */
  readonly spend?: AgentSpend | undefined;
  /**
   * What a binary name opens on this machine. Defaults to `Bun.which`.
   *
   * The one impure thing the guard needs, taken as an argument so the decision stays a table.
   */
  readonly resolve?: ((binary: string) => string | undefined) | undefined;
}

/** Where a binary name resolves for this process — the same lookup the spawned shell will do. */
const whichever = (binary: string): string | undefined => Bun.which(binary) ?? undefined;

/**
 * What the switch says, read fresh on every call.
 *
 * Per call rather than once at layer build, because the layer of a stamped workflow is built by a
 * long-lived process — `kojo watch` — and a guard that was read at start-up would keep answering
 * for a variable somebody changed hours ago. It is two environment reads; the call it guards is
 * seconds of a model's time.
 */
const declaredSpend = (): AgentSpend =>
  spendFrom({
    declared: process.env[spendVariable],
    // The whole default rule, in one expression. A Vitest worker, a Playwright fixture, a CI step
    // and an agent-driven shell all have no terminal here, which is what makes the guard on by
    // default in exactly the places both unauthorised calls were spent.
    attended: process.stdin.isTTY === true,
  });

/**
 * The binary a provider's command names, without running anything.
 *
 * `buildPrintCommand` is the same function Sandcastle calls to build the command it spawns, so the
 * first word of it is the binary that would run — asked of the provider rather than guessed from
 * its name. The prompt is empty because nothing here is sent anywhere; only the shape of the
 * command line is read.
 */
const binaryOf = (provider: AgentProvider): string => {
  const built = provider.buildPrintCommand({ prompt: "", dangerouslySkipPermissions: true });
  return (built.command.trim().split(/\s+/)[0] ?? provider.name).replace(/^["']|["']$/g, "");
};

/**
 * Whether this provider can carry a conversation across turns at all.
 *
 * Read off `sessionStorage`, which is the field Sandcastle populates for exactly the three providers
 * that have session files — Claude Code, Codex, pi — and leaves absent for the four that do not.
 * `SandboxRunResult.resume` is present under the same condition, so this is the same question the
 * library asks itself.
 */
const carriesSessions = (provider: AgentProvider): boolean => provider.sessionStorage !== undefined;

const make = (options: SandcastleAgentOptions) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const roster = yield* Roster;
    const providerFor = options.provider ?? claude;

    // Built from the first roster entry rather than per call, because capabilities are a claim
    // about *this invoker* and the port serves them as a value. Every agent in one roster runs
    // through one provider factory, so the answer cannot differ between them — and a roster with no
    // agents in it can answer no call, so `false` is the truthful reading there.
    const sample = roster.names[0];
    const sessions =
      sample === undefined
        ? false
        : carriesSessions(providerFor(yield* roster.definition(sample).pipe(Effect.orDie)));

    const capabilities: AgentCapabilities = {
      resume: sessions && sandbox.capabilities.resumesSessions,
      capture: sessions && sandbox.capabilities.capturesSessions,
    };

    /**
     * A roster miss is `unknown-agent`, and it is the one fault a better prompt cannot fix.
     *
     * The roster was decoded and its prompts were read when the layer was built, so the only way to
     * get here is a workflow naming an agent the roster does not define — which is a mistake in the
     * program, at a real call site, and is what `Roster.definition` staying an `Effect` is for.
     */
    const define = (name: string): Effect.Effect<AgentDefinition, AgentInvocationError> =>
      roster.definition(name).pipe(
        Effect.mapError(
          (cause: RosterError) =>
            new AgentInvocationError({
              agent: name,
              fault: "unknown-agent",
              reason: cause.reason,
              cause,
            }),
        ),
      );

    const invoke = (call: AgentCall): Effect.Effect<AgentAnswer, AgentInvocationError> =>
      Effect.gen(function* () {
        if (Option.isSome(call.session) && !capabilities.resume) {
          return yield* new AgentInvocationError({
            agent: call.agent,
            fault: "resume-unsupported",
            reason:
              `this sandbox is ${sandbox.capabilities.kind} and this agent provider ` +
              `${sessions ? "has" : "has no"} session storage, so the conversation cannot be ` +
              "re-entered. Starting cold would be a different request wearing the same name",
            cause: undefined,
          });
        }

        const definition = yield* define(call.agent);
        const resumed = Option.isSome(call.session);
        const provider = providerFor(definition);

        /**
         * **The last thing asked before a process could exist.**
         *
         * After the roster, because a refusal that could not name the model would be worth less to
         * whoever reads it; before `sandbox.agent`, because that call is where the money goes. The
         * run is named from the correlation the acquisition stamped on the container, which is the
         * same string the trace row carries — so a person reading this sentence can find the run.
         */
        const verdict = maySpawn({
          spend: options.spend ?? declaredSpend(),
          agent: call.agent,
          provider: provider.name,
          model: definition.model,
          run: sandbox.environment.KOJO_RUN_ID ?? sandbox.id,
          binary: binaryOf(provider),
          resolve: options.resolve ?? whichever,
          sandbox: sandbox.capabilities.kind,
        });

        if (verdict._tag === "Refused") {
          return yield* new AgentInvocationError({
            agent: call.agent,
            fault: "refused-to-spend",
            reason: verdict.reason,
            cause: undefined,
          });
        }

        const run = yield* sandbox
          .agent({
            provider,
            // A cold turn carries the identity, the task template and the contract the phase
            // appended. A correction carries only itself — see `renderPrompt`.
            prompt: resumed ? call.prompt : renderPrompt({ agent: definition, task: call.prompt }),
            ...(Option.isSome(call.session) ? { resumeSession: call.session.value } : {}),
          })
          .pipe(
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

        /**
         * An agent that answered and reported no session is a `provider-failed`, not an answer.
         *
         * The session is what a correction turn re-enters, and there is no second chance to learn
         * it: the transcript is named after the id. Returning the answer with a made-up session
         * would put the failure two turns later, on a `--resume` of an id nothing wrote, and the
         * message would be about a missing file rather than about the turn that lost it.
         */
        if (run.session === undefined) {
          return yield* new AgentInvocationError({
            agent: call.agent,
            fault: "provider-failed",
            reason:
              "the agent ran and reported no session id, so nothing can re-enter this " +
              "conversation. Its output was: " +
              (run.output.trim().slice(0, 300) || "(nothing at all)"),
            cause: undefined,
          });
        }

        return new AgentAnswer({
          agent: call.agent,
          model: definition.model,
          session: run.session as AgentSessionId,
          resumed,
          tokensIn: run.tokensIn,
          tokensOut: run.tokensOut,
          contextTokens: run.contextTokens,
          // Narrowed, never decoded. See `envelopeBlock` for why the narrowing must not be able to
          // invent an answer out of prose.
          output: envelopeBlock(run.output),
        });
      });

    return { capabilities, invoke } satisfies AgentInvoker["Service"];
  });

/**
 * The invoker, over a roster somebody else provides.
 *
 * `Sandbox` on the requirement side is the load-bearing half — see decision 1 above.
 */
export const layer = (
  options?: SandcastleAgentOptions,
): Layer.Layer<AgentInvoker, never, Sandbox | Roster> =>
  Layer.effect(AgentInvoker, make(options ?? {}));

/**
 * The invoker over the factory's own `kojo.config.yaml`, which is what a stamped workflow wants.
 *
 * The platform services are provided here rather than demanded from the workflow body, and that is
 * the point of this second entry: a workflow loaded out of `.kojo/workflows/` is typed against
 * `FactoryServices`, which has no `FileSystem` in it, so a body that had to supply one could not be
 * loaded. Kojo already depends on `@effect/platform-bun`; a stamped repository should not have to.
 *
 * `RosterError` stays on the error channel. A roster that does not decode, or an agent whose
 * `prompts/<name>/system.md` is missing, is a factory that cannot run — and the run fails saying
 * which file and which key, before any agent is spawned, because the layer is built before the body
 * that uses it.
 *
 * `@public` because its only callers are **stamped** workflows: `templates/review.ts` and
 * `templates/hotfix.ts` write the import into the target repository, so the use is in a string here
 * and in TypeScript there, and no static analysis of this package can see it.
 *
 * @public
 */
export const fromConfig = (options: {
  readonly config: string;
  readonly provider?: ProviderFor | undefined;
}): Layer.Layer<AgentInvoker, RosterError, Sandbox> =>
  layer({ provider: options.provider }).pipe(
    Layer.provide(YamlRoster.layer({ config: options.config })),
  );
