import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import type { DurableDeferred, Workflow } from "effect/unstable/workflow";
import * as InMemoryAgentInvoker from "../../../../../../src/contexts/agent/adapters/InMemoryAgentInvoker.ts";
import { AgentInvocationError } from "../../../../../../src/contexts/agent/models/AgentInvocationError.ts";
import { GateExpired } from "../../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../../src/contexts/gate/models/OnExpiry.ts";
import * as InMemorySandboxSource from "../../../../../../src/contexts/sandbox/adapters/InMemorySandboxSource.ts";
import { SandboxError } from "../../../../../../src/contexts/sandbox/models/SandboxError.ts";
import { tagged } from "../../../../../../src/contexts/sandbox/models/SandboxProvider.ts";
import { WorkspaceError } from "../../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import { WorkspaceUnreachable } from "../../../../../../src/contexts/sandbox/models/WorkspaceUnreachable.ts";
import { WorktreeUnusable } from "../../../../../../src/contexts/sandbox/models/WorktreeUnusable.ts";
import * as InMemoryTracer from "../../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { CheckViolation } from "../../../../../../src/contexts/workflow/models/CheckViolation.ts";
import { EnvelopeParseError } from "../../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { agent } from "../../../../../../src/contexts/workflow/services/phase/agent.ts";
import { code } from "../../../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../../../src/contexts/workflow/services/phase/gate.ts";
import { sandboxed } from "../../../../../../src/contexts/workflow/services/sandboxed.ts";
import { workflow } from "../../../../../../src/contexts/workflow/services/workflow.ts";
import {
  buildInfoLayer,
  layer as inMemoryExecutionServices,
} from "../../../../../support/InMemoryExecutionServices.ts";
import * as InMemoryGate from "../../../../../support/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../../support/InMemoryGateRepository.ts";
import {
  inMemoryWorkflowEngine,
  selfContainedTestLayer,
  serviceFreeWorkflowEffect,
} from "../../../../../support/inMemoryWorkflowEngine.ts";
import { settle } from "../../../../../support/settleThenAdvance.ts";
import { applyRecordedGateVerdict } from "../../../../../support/TestDaemonGateApplication.ts";

/**
 * Where a phase ran, on the phase's own row.
 *
 * The claim under test is one nullable column: *which phases needed a container* is a `where`
 * clause, not a join against the sandbox rows on overlapping timestamps. Two things have to hold for
 * that to be worth anything — a phase on the host must record **nothing**, and a phase inside a scope
 * must record the **acquisition** it ran in rather than the scope it was written in. The second is
 * what the suspension test below is for: the same phase name, either side of a gate, ran in two
 * different containers, and a column that named the scope would hide it.
 */

const provider = tagged("bind-mount", { name: "fake", env: {} });

const failures = Schema.Union([
  GateExpired,
  GateUnreachable,
  EnvelopeParseError,
  AgentInvocationError,
  CheckViolation,
  WorkspaceError,
  SandboxError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

class Notes extends Schema.Class<Notes>("Notes")({ finding: Schema.String }) {}

const step = (name: string) =>
  code(
    { name, description: `the ${name} step`, success: Schema.Void, error: Schema.Never },
    Effect.void,
  );

/** Host, container, host — three code phases and one agent phase, one of each side of the line. */
const survey = workflow(
  {
    name: "survey",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `survey/${payload.subject}`,
  },
  () =>
    Effect.gen(function* () {
      yield* step("plan");

      const notes = yield* sandboxed(
        { name: "build", branch: "kojo/build", provider },
        Effect.gen(function* () {
          yield* step("compile");
          return yield* agent({
            name: "scout",
            description: "Say what is in the container",
            agent: "scout",
            prompt: "What is here?",
            envelope: Notes,
          });
        }),
      );

      yield* step("land");
      return notes.finding;
    }),
);

/** One scope, one gate inside it: the container is torn down and rebuilt around the wait. */
const interrupted = workflow(
  {
    name: "interrupted",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: failures,
    idempotencyKey: (payload) => `interrupted/${payload.subject}`,
  },
  () =>
    sandboxed(
      { name: "lane", branch: "kojo/lane", provider },
      Effect.gen(function* () {
        yield* step("before");
        yield* gate({
          name: "review",
          description: "Does this land?",
          actor: "engineer",
          choices: ["approve", "reject"],
          deadline: Duration.days(7),
          onExpiry: OnExpiry.fail(),
          asking: 1,
        });
        yield* step("after");
        return "landed";
      }),
    ),
);

const layerFor = () =>
  selfContainedTestLayer(
    Layer.mergeAll(survey.layer, interrupted.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          InMemoryTracer.layer,
          InMemorySandboxSource.layer(),
          InMemoryAgentInvoker.layer({
            scout: { envelope: { finding: "it compiles" }, tokensIn: 90, contextTokens: 4200 },
          }),
          InMemoryGate.layer().pipe(Layer.provideMerge(inMemoryWorkflowEngine)),
          // The gate phase now writes an expiry settlement where the queue reads, so every workflow
          // body consumes the repository beside the gate.
          InMemoryGateRepository.layer,
          inMemoryExecutionServices,
        ),
      ),
      Layer.provide(buildInfoLayer),
    ),
  );

const phasesOf = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.phases);

const start = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
) => serviceFreeWorkflowEffect(definition.execute(payload, { discard: true }));

const status = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  executionId: string,
) =>
  Effect.map(serviceFreeWorkflowEffect(definition.poll(executionId)), (polled) =>
    Option.match(polled, {
      onNone: () => "running" as const,
      onSome: (result) =>
        result._tag === "Suspended"
          ? "suspended"
          : Exit.isSuccess(result.exit)
            ? "succeeded"
            : "failed",
    }),
  );

describe("where a phase ran", () => {
  it.effect("names the sandbox on the phases inside one, and nothing on the phases outside", () =>
    Effect.gen(function* () {
      const runId = yield* start(survey.definition, { subject: "one" });
      yield* settle;
      expect(yield* status(survey.definition, runId)).toBe("succeeded");

      const phases = yield* phasesOf;
      expect(phases.map((record) => record.name)).toEqual(["plan", "compile", "scout", "land"]);

      // The question the column exists for, asked the way a reader asks it: no join, no timestamps.
      const inAContainer = phases
        .filter((record) => record.sandboxId !== undefined)
        .map((record) => record.name);
      expect(inAContainer).toEqual(["compile", "scout"]);

      // And it is *the acquisition*, not a name a phase invented: the fake sandbox watched this id
      // be taken. Both kinds of phase record it, because both write the same row.
      const observed = yield* Effect.flatMap(
        InMemorySandboxSource.ObservedSandboxes,
        (sandboxes) => sandboxes.events,
      );
      const acquired = observed.find((event) => event.moment === "acquired")?.id;
      expect(acquired).toBeDefined();
      for (const name of inAContainer) {
        expect(phases.find((record) => record.name === name)?.sandboxId).toBe(acquired);
      }
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("carries the agent's context occupancy and the envelope it was graded against", () =>
    Effect.gen(function* () {
      yield* start(survey.definition, { subject: "two" });
      yield* settle;

      const scouted = (yield* phasesOf).find((record) => record.name === "scout");
      // Occupancy is not `tokensIn`: one is what the turn cost, the other is how much room the next
      // turn has. A row that carried only the first cannot see a session run out of window.
      expect(scouted?.agent?.tokensIn).toBe(90);
      expect(scouted?.agent?.contextTokens).toBe(4200);
      expect(scouted?.verification?.envelope).toBe("Notes");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("names two different containers either side of a gate", () =>
    Effect.gen(function* () {
      const runId = yield* start(interrupted.definition, { subject: "three" });
      yield* settle;
      expect(yield* status(interrupted.definition, runId)).toBe("suspended");

      const requests = yield* Effect.flatMap(
        InMemoryGate.RequestedGates,
        (gates) => gates.requests,
      );
      yield* applyRecordedGateVerdict({
        token: requests[requests.length - 1]?.token as DurableDeferred.Token,
        choice: "approve",
        reason: "reads fine",
        answerer: "kevin",
      });
      yield* settle;
      expect(yield* status(interrupted.definition, runId)).toBe("succeeded");

      const phases = yield* phasesOf;
      const before = phases.find((record) => record.name === "before")?.sandboxId;
      const after = phases.find((record) => record.name === "after")?.sandboxId;

      // Both ran in a container, and not in the same one: the suspension released the first and the
      // replay built a second. A column naming the *scope* would report one value twice and hide the
      // rebuild that is the price of the gate.
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(before).not.toBe(after);
    }).pipe(Effect.provide(layerFor())),
  );
});
