import type { AgentProvider } from "@ai-hero/sandcastle";
import { claudeCode, codex as codexProvider } from "@ai-hero/sandcastle";
import { Effect, Layer, Option } from "effect";
import {
  inspectProviderState,
  recordProviderState,
} from "../../project/adapters/ProviderResourceRegistry.ts";
import {
  providerResourceEnvironment,
  resourceLeaseId,
} from "../../project/models/ProviderResource.ts";
import { ResourceLeaseClient } from "../../project/ports/ResourceLeaseClient.ts";
import { Sandbox } from "../../sandbox/ports/Sandbox.ts";
import { ArtifactPublisher } from "../../trace/ports/ArtifactPublisher.ts";
import { AgentAnswer } from "../models/AgentAnswer.ts";
import { AgentDefinition } from "../models/AgentDefinition.ts";
import { AgentInvocationError } from "../models/AgentInvocationError.ts";
import type { AgentSessionId } from "../models/AgentSessionId.ts";
import type { AgentCall, AgentCapabilities, ProviderFor } from "../ports/AgentInvoker.ts";
import { AgentInvoker } from "../ports/AgentInvoker.ts";
import { envelopeBlock } from "../services/envelopeBlock.ts";
import { renderPrompt } from "../services/renderPrompt.ts";

/** Claude Code selected explicitly at an agent call. */
export const claude: ProviderFor = (definition) => claudeCode(definition.model);

/** Codex selected explicitly at an agent call. @public */
export const codex: ProviderFor = (definition) => codexProvider(definition.model);

const definitionOf = (call: AgentCall): AgentDefinition =>
  new AgentDefinition({
    name: call.agent,
    purpose: call.agent,
    model: call.model,
    system: call.system,
    user: "",
    tools: [...(call.tools ?? [])],
  });

const carriesSessions = (provider: AgentProvider): boolean => provider.sessionStorage !== undefined;

const shellValue = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Sandcastle's pre-created Sandbox ignores AgentProvider.env, so bind it to the real command. */
const withProcessEnvironment = (
  provider: AgentProvider,
  environment: Record<string, string>,
): AgentProvider => ({
  ...provider,
  buildPrintCommand: (options) => {
    const command = provider.buildPrintCommand(options);
    const assignments = Object.entries(environment)
      .map(([name, value]) => `${name}=${shellValue(value)}`)
      .join(" ");
    return { ...command, command: `env ${assignments} ${command.command}` };
  },
});

const make = Effect.gen(function* () {
  const sandbox = yield* Sandbox;
  const resources = yield* ResourceLeaseClient;
  const artifacts = yield* ArtifactPublisher;
  let invocationSequence = 0;

  const capabilities = (call: AgentCall): AgentCapabilities => {
    const sessions = carriesSessions(call.provider(definitionOf(call)));
    return {
      resume: sessions && sandbox.capabilities.resumesSessions,
      capture: sessions && sandbox.capabilities.capturesSessions,
    };
  };

  const invoke = (call: AgentCall): Effect.Effect<AgentAnswer, AgentInvocationError> =>
    Effect.gen(function* () {
      const definition = definitionOf(call);
      const provider = call.provider(definition);
      const sessions = carriesSessions(provider);
      if (Option.isSome(call.session) && !(sessions && sandbox.capabilities.resumesSessions)) {
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

      const resumed = Option.isSome(call.session);
      invocationSequence += 1;

      const acquisitionKey = `${sandbox.id}/agent/${call.agent}/${invocationSequence}`;
      const leaseId = resourceLeaseId(acquisitionKey);
      const resource = yield* resources.beginAcquisition({
        leaseId,
        kind: "agent",
        acquisitionKey,
        detail: {
          agent: call.agent,
          model: definition.model,
          provider: provider.name,
          sandbox: sandbox.id,
        },
      });
      const controlledProvider = withProcessEnvironment(
        provider,
        providerResourceEnvironment(resource),
      );
      yield* recordProviderState(resource, "agent", "creating").pipe(Effect.orDie);

      const run = yield* sandbox
        .agent({
          provider: controlledProvider,
          // A cold turn carries the identity, the task template and the contract the phase
          // appended. A correction carries only itself — see `renderPrompt`.
          prompt: resumed ? call.prompt : renderPrompt({ agent: definition, task: call.prompt }),
          ...(Option.isSome(call.session) ? { resumeSession: call.session.value } : {}),
        })
        .pipe(
          Effect.tap((answer) =>
            Effect.gen(function* () {
              const locator = answer.session ?? `${sandbox.id}/${call.agent}`;
              const providerEvidence = yield* inspectProviderState(resource, "agent").pipe(
                Effect.orDie,
              );
              if (providerEvidence?.state !== "released") {
                yield* recordProviderState(resource, "agent", "acquired", locator).pipe(
                  Effect.orDie,
                );
              }
              yield* resources.confirmAcquired(leaseId, {
                providerIdentity: resource.providerIdentity,
                locator,
              });
              yield* resources.beginRelease(leaseId);
              if (providerEvidence?.state === "released") {
                yield* resources.confirmReleased(
                  leaseId,
                  "the provider registry confirms exact-key release",
                );
              } else {
                yield* recordProviderState(resource, "agent", "release-intent", locator).pipe(
                  Effect.orDie,
                );
                yield* resources.preserve(
                  leaseId,
                  "the agent process returned without exact provider release evidence",
                );
              }
              yield* artifacts.publishText({
                name: `agent-${leaseId}.txt`,
                mediaType: "text/plain; charset=utf-8",
                content: answer.output,
              });
            }),
          ),
          Effect.tapError(() =>
            resources.unresolved(
              leaseId,
              "the agent provider did not return a result, so process release is not confirmed",
            ),
          ),
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

/** The invoker runs the selected provider inside the current Sandbox. */
export const layer: Layer.Layer<
  AgentInvoker,
  never,
  Sandbox | ResourceLeaseClient | ArtifactPublisher
> = Layer.effect(AgentInvoker, make);
