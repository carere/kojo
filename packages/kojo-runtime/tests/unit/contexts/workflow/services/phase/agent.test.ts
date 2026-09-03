import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import * as InMemoryAgentInvoker from "../../../../../../src/contexts/agent/adapters/InMemoryAgentInvoker.ts";
import { AgentInvocationError } from "../../../../../../src/contexts/agent/models/AgentInvocationError.ts";
import { WorkspaceError } from "../../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import * as InMemoryTracer from "../../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { CheckViolation } from "../../../../../../src/contexts/workflow/models/CheckViolation.ts";
import { EnvelopeBase } from "../../../../../../src/contexts/workflow/models/Envelope.ts";
import { EnvelopeParseError } from "../../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { agent } from "../../../../../../src/contexts/workflow/services/phase/agent.ts";
import { workflow } from "../../../../../../src/contexts/workflow/services/workflow.ts";
import { layer as inMemoryExecutionServices } from "../../../../../support/InMemoryExecutionServices.ts";
import {
  inMemoryWorkflowEngine,
  selfContainedTestLayer,
  serviceFreeWorkflowEffect,
} from "../../../../../support/inMemoryWorkflowEngine.ts";

class Route extends EnvelopeBase.extend<Route>("Route")({
  _tag: Schema.tag("Route"),
  lane: Schema.String,
}) {}

class Scouted extends EnvelopeBase.extend<Scouted>("Scouted")({
  _tag: Schema.tag("Scouted"),
  findings: Schema.Array(Schema.String),
}) {}

class Hotfixed extends EnvelopeBase.extend<Hotfixed>("Hotfixed")({
  _tag: Schema.tag("Hotfixed"),
  changedFiles: Schema.Array(Schema.String),
  commitMessage: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
}) {}

// Three agent phases in a row, the way an author writes them: each one call, each one contract.
const triage = workflow(
  {
    name: "triage",
    payload: { ticket: Schema.String },
    success: Schema.String,
    // An agent phase grades what it is given, so its channel carries a refused answer
    // (`CheckViolation`) and a workspace a check could not read, whether or not this workflow
    // declares a check of its own.
    error: Schema.Union([EnvelopeParseError, AgentInvocationError, CheckViolation, WorkspaceError]),
    idempotencyKey: (payload) => `triage/${payload.ticket}`,
  },
  (payload) =>
    Effect.gen(function* () {
      const route = yield* agent({
        name: "route",
        description: "Read the ticket and pick the lane it belongs in",
        agent: "router",
        prompt: `Route ${payload.ticket}`,
        envelope: Route,
      });

      const scouted = yield* agent({
        name: "scout",
        description: "Find what the ticket touches before anything is changed",
        agent: "scout",
        prompt: `Scout ${payload.ticket} for the ${route.lane} lane`,
        envelope: Scouted,
      });

      const hotfixed = yield* agent({
        name: "hotfix",
        description: "Write the fix the scout's findings point at",
        agent: "hotfixer",
        prompt: `Fix ${payload.ticket}: ${scouted.findings.join(", ")}`,
        envelope: Hotfixed,
      });

      return `${route.lane}:${hotfixed.commitMessage}`;
    }),
);

const runTriage = (scripts: Record<string, InMemoryAgentInvoker.Script>) =>
  Effect.gen(function* () {
    const outcome = yield* serviceFreeWorkflowEffect(
      triage.definition.execute({ ticket: "KOJO-1" }),
    ).pipe(Effect.result);
    const trace = yield* InMemoryTracer.RecordedTrace;
    return { outcome, phases: yield* trace.phases };
  }).pipe(
    Effect.provide(
      selfContainedTestLayer(
        triage.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              InMemoryTracer.layer,
              InMemoryAgentInvoker.layer(scripts),
              inMemoryWorkflowEngine,
              inMemoryExecutionServices,
            ),
          ),
        ),
      ),
    ),
  );

const scriptedFactory = {
  router: { envelope: { _tag: "Route", lane: "hotfix" }, model: "opus", tokensIn: 900 },
  scout: { envelope: { _tag: "Scouted", findings: ["the fault is in the parser"] } },
  hotfixer: {
    envelope: { _tag: "Hotfixed", changedFiles: ["src/parser.ts"] },
    tokensOut: 120,
  },
} satisfies Record<string, InMemoryAgentInvoker.Script>;

describe("a workflow of agent phases", () => {
  // The payoff for the port indirection: three agents, no network, no credentials, no container.
  it.effect("runs end to end on scripted envelopes alone", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage(scriptedFactory);

      expect(Result.isSuccess(outcome)).toBe(true);
      // Each phase decoded its own envelope, and the next prompt was written from it.
      expect(Result.isSuccess(outcome) && outcome.success).toBe("hotfix:");
      expect(phases.map((phase) => phase.name)).toEqual(["route", "scout", "hotfix"]);
      expect(phases.map((phase) => phase.kind)).toEqual(["agent", "agent", "agent"]);
      expect(phases.map((phase) => phase.outcome)).toEqual(["succeeded", "succeeded", "succeeded"]);
      expect(phases).toHaveLength(new Set(phases.map((phase) => phase.phaseId)).size);
    }),
  );

  it.effect("puts the agent, the model, the session and the turn's cost on the phase row", () =>
    Effect.gen(function* () {
      const { phases } = yield* runTriage(scriptedFactory);

      const routed = phases[0];
      expect(routed?.agent).toMatchObject({
        agent: "router",
        model: "opus",
        session: "router-session-1",
        // Started cold, not resumed. The correction loop is what makes this true the other way.
        resumed: false,
        tokensIn: 900,
        tokensOut: 0,
      });

      expect(phases[2]?.agent).toMatchObject({ agent: "hotfixer", tokensOut: 120 });
      // Three cold calls are three conversations, and the trace can tell them apart.
      expect(new Set(phases.map((phase) => phase.agent?.session)).size).toBe(3);
    }),
  );

  it.effect("decodes the envelope itself, so a bad answer is a parse error and not a defect", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runTriage({
        ...scriptedFactory,
        hotfixer: { envelope: { _tag: "Hotfixed", changedFiles: 3, commitMessage: 7 } },
      });

      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) return;
      const failure = outcome.failure;
      expect(failure._tag).toBe("EnvelopeParseError");
      if (failure._tag !== "EnvelopeParseError") return;

      expect(failure.agent).toBe("hotfixer");
      expect(failure.expected).toBe("Hotfixed");
      // Every issue, with the path that produced it — this is the correction loop's input, and one
      // issue per retry is what the `{ errors: "all" }` invariant exists to prevent.
      expect(failure.issues.map((issue) => issue.path.join("."))).toEqual([
        "changedFiles",
        "commitMessage",
      ]);
      expect(failure.issues.every((issue) => issue.message.length > 0)).toBe(true);
      // Kept verbatim: the issue list cannot be turned back into what the agent actually said.
      expect(JSON.parse(failure.raw)).toEqual({
        _tag: "Hotfixed",
        changedFiles: 3,
        commitMessage: 7,
      });
    }),
  );

  it.effect("reads prose as a parse error too, through the same decode path", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage({
        ...scriptedFactory,
        scout: { output: "I had a look around but I am not sure what to tell you" },
      });

      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) return;
      expect(outcome.failure._tag).toBe("EnvelopeParseError");

      // The call happened, so the row still carries what it cost — a phase with no record is a
      // phase nobody can debug, and a failed one is when that matters.
      const scouted = phases[1];
      expect(scouted?.outcome).toBe("failed");
      expect(scouted?.errorTag).toBe("EnvelopeParseError");
      // An agent that answers prose every time is corrected until the bound runs out, and the row
      // carries the last of those calls — re-entered, not cold.
      expect(scouted?.agent).toMatchObject({ agent: "scout", resumed: true });
      expect(scouted?.verification).toMatchObject({ corrections: 2, correctable: true });
      // And the phase after it never ran.
      expect(phases.map((phase) => phase.name)).toEqual(["route", "scout"]);
    }),
  );

  it.effect("keeps a call that never happened apart from an answer that did not decode", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage({ router: scriptedFactory.router });

      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) return;
      expect(outcome.failure._tag).toBe("AgentInvocationError");

      const scouted = phases[1];
      expect(scouted?.outcome).toBe("failed");
      expect(scouted?.errorTag).toBe("AgentInvocationError");
      // No agent block: nothing was asked, so there is no model, no session and no cost to report.
      expect(scouted?.agent).toBeUndefined();
    }),
  );
});
