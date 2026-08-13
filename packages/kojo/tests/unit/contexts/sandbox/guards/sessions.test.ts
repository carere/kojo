import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  requireResume,
  sessionCapabilities,
} from "../../../../../src/contexts/sandbox/guards/sessions.ts";
import {
  capabilitiesOf,
  type SandboxKind,
} from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";

const kinds: ReadonlyArray<SandboxKind> = ["bind-mount", "isolated", "none"];

describe("what a sandbox can do for a session", () => {
  it("says it in the words the agent port asks in", () => {
    expect(kinds.map((kind) => [kind, sessionCapabilities(capabilitiesOf(kind))])).toEqual([
      ["bind-mount", { resume: true, capture: true }],
      // The row the whole ticket turns on: no host filesystem, so nothing to move and nothing to
      // re-enter.
      ["isolated", { resume: false, capture: false }],
      // And the row that is nothing like it, despite both being "not bind-mount": the agent runs
      // on the host and writes its session in place, so capture is unnecessary rather than
      // impossible — and resume still works.
      ["none", { resume: true, capture: false }],
    ]);
  });

  it.effect("lets a workflow that needs a session through on a provider that keeps one", () =>
    Effect.gen(function* () {
      for (const kind of ["bind-mount", "none"] as const) {
        const outcome = yield* requireResume("hotfixer", capabilitiesOf(kind)).pipe(Effect.result);
        expect([kind, Result.isSuccess(outcome)]).toEqual([kind, true]);
      }
    }),
  );

  it.effect("stops a workflow that needs a session where there is none to re-enter", () =>
    Effect.gen(function* () {
      const outcome = yield* requireResume("hotfixer", capabilitiesOf("isolated")).pipe(
        Effect.result,
      );

      // A cold start would have produced an answer, and a worse one, for the price of a whole
      // session. Failing is the point.
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure._tag).toBe("AgentInvocationError");
        expect(outcome.failure.fault).toBe("resume-unsupported");
        expect(outcome.failure.agent).toBe("hotfixer");
        expect(outcome.failure.reason).toContain("isolated");
      }
    }),
  );
});
