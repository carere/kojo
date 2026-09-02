import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import * as InMemoryAgentInvoker from "../../../../../../src/contexts/agent/adapters/InMemoryAgentInvoker.ts";
import { AgentInvocationError } from "../../../../../../src/contexts/agent/models/AgentInvocationError.ts";
import * as InMemoryWorkspace from "../../../../../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import { WorkspaceError } from "../../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import * as InMemoryTracer from "../../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { artifactsExist } from "../../../../../../src/contexts/workflow/guards/checks/artifactsExist.ts";
import { diffMatchesClaims } from "../../../../../../src/contexts/workflow/guards/checks/diffMatchesClaims.ts";
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
  artifacts: Schema.Array(Schema.String),
}) {}

class Hotfixed extends EnvelopeBase.extend<Hotfixed>("Hotfixed")({
  _tag: Schema.tag("Hotfixed"),
  changedFiles: Schema.Array(Schema.String),
  commitMessage: Schema.String,
}) {}

/**
 * The same three-phase chain an author writes, with a check on each phase that claims something.
 *
 * The router claims nothing about the repository, so it has nothing to verify beyond its shape —
 * which is itself the point that a check-less phase is still a graded phase.
 */
const triage = workflow(
  {
    name: "checked-triage",
    payload: { ticket: Schema.String },
    success: Schema.String,
    error: Schema.Union([EnvelopeParseError, AgentInvocationError, CheckViolation, WorkspaceError]),
    idempotencyKey: (payload) => `checked-triage/${payload.ticket}`,
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
        description: "Find what the ticket touches and write it down",
        agent: "scout",
        prompt: `Scout ${payload.ticket} for the ${route.lane} lane`,
        envelope: Scouted,
        checks: [
          artifactsExist<Scouted>({ claim: "artifacts", paths: (found) => found.artifacts }),
        ],
      });

      const hotfixed = yield* agent({
        name: "hotfix",
        description: "Write the fix the scout's findings point at",
        agent: "hotfixer",
        prompt: `Fix ${payload.ticket} using ${scouted.artifacts.join(", ")}`,
        envelope: Hotfixed,
        checks: [
          diffMatchesClaims<Hotfixed>({
            claim: "changedFiles",
            files: (built) => built.changedFiles,
          }),
        ],
      });

      return `${route.lane}:${hotfixed.commitMessage}`;
    }),
);

/** The tree every run below grades against: one report written, one source file rewritten. */
const workspace = InMemoryWorkspace.layer(
  { "reports/scout.md": "# the fault is in the parser" },
  {
    commands: {
      "git diff HEAD --numstat": { stdout: "3\t1\tsrc/parser.ts" },
      "git ls-files --others --exclude-standard": { stdout: "" },
    },
  },
);

const runTriage = (
  scripts: Record<string, InMemoryAgentInvoker.Script>,
  options?: { readonly capabilities?: { readonly resume: boolean; readonly capture: boolean } },
) =>
  Effect.gen(function* () {
    const outcome = yield* serviceFreeWorkflowEffect(
      triage.definition.execute({ ticket: "KOJO-7" }),
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
              InMemoryAgentInvoker.layer(scripts, options),
              workspace,
              inMemoryWorkflowEngine,
              inMemoryExecutionServices,
            ),
          ),
        ),
      ),
    ),
  );

const good = {
  router: { envelope: { _tag: "Route", lane: "hotfix" } },
  scout: { envelope: { _tag: "Scouted", artifacts: ["reports/scout.md"] } },
  hotfixer: {
    envelope: {
      _tag: "Hotfixed",
      changedFiles: ["src/parser.ts"],
      commitMessage: "fix the parser",
    },
  },
} satisfies Record<string, InMemoryAgentInvoker.Script>;

describe("a three-phase chain whose first envelope is wrong", () => {
  it.effect("runs green after one correction, and the correction re-enters the session", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage({
        ...good,
        // The deliberately wrong first answer: the right shape is never even reached.
        router: [{ envelope: { _tag: "Route", lane: 4 } }, good.router.envelope].map(
          (envelope) => ({
            envelope,
          }),
        ),
      });

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(Result.isSuccess(outcome) && outcome.success).toBe("hotfix:fix the parser");
      expect(phases.map((phase) => phase.name)).toEqual(["route", "scout", "hotfix"]);
      expect(phases.every((phase) => phase.outcome === "succeeded")).toBe(true);

      const routed = phases[0];
      expect(routed?.verification).toMatchObject({ ran: [], failed: [], corrections: 1 });
      // The correction was one more message in the conversation the first call opened, not a
      // second conversation that would have to be told the ticket again.
      expect(routed?.agent).toMatchObject({ session: "router-session-1", resumed: true });
      // And it is still one phase, one row, one attempt — the loop lives inside the phase.
      expect(routed?.attempt).toBe(1);
    }),
  );

  it.effect("re-prompts a violated claim and records which check refused it", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage({
        ...good,
        scout: [
          // Decodes perfectly, and the report it names was never written.
          { envelope: { _tag: "Scouted", artifacts: ["reports/invented.md"] } },
          good.scout.envelope,
        ].map((envelope) => ({ envelope })),
      });

      expect(Result.isSuccess(outcome)).toBe(true);

      const scouted = phases[1];
      expect(scouted?.outcome).toBe("succeeded");
      // `ran` is what graded the accepted answer; `failed` is empty because the accepted answer
      // held. The count is the only thing that says it took two goes.
      expect(scouted?.verification).toMatchObject({
        ran: ["artifactsExist"],
        failed: [],
        corrections: 1,
        correctable: true,
      });
    }),
  );

  it.effect("fails with the violation itself once the bound is spent", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage({
        ...good,
        // Claims a file the working tree never changed, every single time.
        hotfixer: {
          envelope: {
            _tag: "Hotfixed",
            changedFiles: ["src/invented.ts"],
            commitMessage: "fix the parser",
          },
        },
      });

      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) return;
      const failure = outcome.failure;
      expect(failure._tag).toBe("CheckViolation");
      if (failure._tag !== "CheckViolation") return;

      // The original error, not a wrapper — and it still names the claim that was refused.
      expect(failure.check).toBe("diffMatchesClaims");
      expect(failure.report.failed[0]?.faults.map((fault) => fault.subject)).toEqual([
        "src/invented.ts",
        "src/parser.ts",
      ]);

      const built = phases[2];
      expect(built?.errorTag).toBe("CheckViolation");
      expect(built?.verification).toMatchObject({
        ran: ["diffMatchesClaims"],
        failed: ["diffMatchesClaims"],
        corrections: 2,
      });
    }),
  );

  it.effect("does not correct at all when the invoker cannot re-enter a session", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage(
        {
          ...good,
          router: [{ envelope: { _tag: "Route", lane: 4 } }, good.router.envelope].map(
            (envelope) => ({ envelope }),
          ),
        },
        { capabilities: { resume: false, capture: false } },
      );

      // A cold call carrying only the correction is a different request wearing the same name, so
      // the phase does not make it. The row says which of the two reasons it stopped.
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("EnvelopeParseError");
      expect(phases[0]?.verification).toMatchObject({ corrections: 0, correctable: false });
    }),
  );

  it.effect("leaves an invocation failure to the caller rather than correcting it", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runTriage({ router: good.router });

      // Nothing was asked, so there is nothing to correct. The residual channel carries it out.
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("AgentInvocationError");
      expect(phases[1]?.verification).toMatchObject({ corrections: 0, failed: [] });
    }),
  );
});
