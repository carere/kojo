import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import * as InMemoryAgentInvoker from "../../../../../src/contexts/agent/adapters/InMemoryAgentInvoker.ts";
import type { AgentSessionId } from "../../../../../src/contexts/agent/models/AgentSessionId.ts";
import { AgentInvoker } from "../../../../../src/contexts/agent/ports/AgentInvoker.ts";

const cold = { session: Option.none<AgentSessionId>() };

const invoking = (
  scripts: Record<string, InMemoryAgentInvoker.Script>,
  call: { readonly agent: string; readonly session?: Option.Option<AgentSessionId> },
  options?: Parameters<typeof InMemoryAgentInvoker.layer>[1],
) =>
  Effect.gen(function* () {
    const invoker = yield* AgentInvoker;
    return yield* Effect.result(
      invoker.invoke({
        agent: call.agent,
        prompt: "do the thing",
        session: call.session ?? cold.session,
      }),
    );
  }).pipe(Effect.provide(InMemoryAgentInvoker.layer(scripts, options)));

describe("the scripted invoker", () => {
  it.effect("answers with the envelope programmed for that agent name", () =>
    Effect.gen(function* () {
      const outcome = yield* invoking(
        {
          router: { envelope: { _tag: "Route", lane: "hotfix" } },
          scout: { envelope: { _tag: "Scout", findings: [] } },
        },
        { agent: "router" },
      );

      expect(Result.isSuccess(outcome)).toBe(true);
      if (!Result.isSuccess(outcome)) return;
      // Text, not a decoded value: the provider never receives the schema, so what comes back is
      // what an agent would have said.
      expect(JSON.parse(outcome.success.output)).toEqual({ _tag: "Route", lane: "hotfix" });
      expect(outcome.success.agent).toBe("router");
    }),
  );

  it.effect("refuses an agent nobody scripted rather than inventing an answer", () =>
    Effect.gen(function* () {
      const outcome = yield* invoking({ router: { envelope: {} } }, { agent: "hotfixer" });

      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) return;
      expect(outcome.failure.fault).toBe("unknown-agent");
      expect(outcome.failure.agent).toBe("hotfixer");
    }),
  );

  it.effect("carries verbatim text through, so an agent can ignore the contract", () =>
    Effect.gen(function* () {
      const outcome = yield* invoking(
        { router: { output: "I could not decide, sorry" } },
        { agent: "router" },
      );

      expect(Result.isSuccess(outcome)).toBe(true);
      if (!Result.isSuccess(outcome)) return;
      expect(outcome.success.output).toBe("I could not decide, sorry");
    }),
  );

  it.effect("opens a cold session and says so", () =>
    Effect.gen(function* () {
      const outcome = yield* invoking({ router: { envelope: {} } }, { agent: "router" });

      expect(Result.isSuccess(outcome)).toBe(true);
      if (!Result.isSuccess(outcome)) return;
      expect(outcome.success.resumed).toBe(false);
      expect(outcome.success.session).toBe("router-session-1");
    }),
  );

  it.effect("re-enters the session it was handed", () =>
    Effect.gen(function* () {
      const outcome = yield* invoking(
        { router: { envelope: {} } },
        { agent: "router", session: Option.some("router-session-1" as AgentSessionId) },
      );

      expect(Result.isSuccess(outcome)).toBe(true);
      if (!Result.isSuccess(outcome)) return;
      expect(outcome.success.resumed).toBe(true);
      expect(outcome.success.session).toBe("router-session-1");
    }),
  );

  // Resume is a capability, not an assumption. An invoker that cannot re-enter a session must say
  // so — a silent cold start would answer the correction loop's cheap retry with a full re-prompt
  // and a transcript the agent has never seen.
  it.effect("refuses a resume it cannot perform instead of quietly starting cold", () =>
    Effect.gen(function* () {
      const outcome = yield* invoking(
        { router: { envelope: {} } },
        { agent: "router", session: Option.some("router-session-1" as AgentSessionId) },
        { capabilities: { resume: false, capture: false } },
      );

      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) return;
      expect(outcome.failure.fault).toBe("resume-unsupported");
    }),
  );

  it.effect("states its capabilities so a caller can ask before it calls", () =>
    Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      expect(invoker.capabilities).toEqual({ resume: true, capture: false });
    }).pipe(
      Effect.provide(
        InMemoryAgentInvoker.layer(
          {},
          // The no-sandbox row of the matrix: the agent writes its session in place on the host, so
          // resuming works and nothing has to be captured.
          { capabilities: { resume: true, capture: false } },
        ),
      ),
    ),
  );

  it.effect("works through a list in order and stops when it is exhausted", () =>
    Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      const ask = () =>
        Effect.result(invoker.invoke({ agent: "router", prompt: "again", ...cold }));

      const first = yield* ask();
      const second = yield* ask();
      const third = yield* ask();

      expect(Result.isSuccess(first) && first.success.output).toBe("first");
      expect(Result.isSuccess(second) && second.success.output).toBe("second");
      // Not a repeat of the last answer: a loop that ran one turn too many has to fail the test,
      // not read as green.
      expect(Result.isFailure(third)).toBe(true);
    }).pipe(
      Effect.provide(
        InMemoryAgentInvoker.layer({ router: [{ output: "first" }, { output: "second" }] }),
      ),
    ),
  );

  it.effect("repeats a single scripted answer, so a phase order test says it once", () =>
    Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      const first = yield* invoker.invoke({ agent: "router", prompt: "a", ...cold });
      const second = yield* invoker.invoke({ agent: "router", prompt: "b", ...cold });

      expect(first.output).toBe(second.output);
      // Two cold calls are two conversations, and the ids say so.
      expect(first.session).not.toBe(second.session);
    }).pipe(Effect.provide(InMemoryAgentInvoker.layer({ router: { output: "same" } }))),
  );
});
