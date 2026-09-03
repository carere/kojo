import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { PathRollback } from "../../../../../src/contexts/shared/models/PathRollback.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { PermissionBreach } from "../../../../../src/contexts/workflow/models/PermissionBreach.ts";

const breach = new PermissionBreach({
  agent: "hotfixer",
  scope: "read-only",
  paths: [new PathRollback({ path: ".kojo/checks.ts", outcome: { _tag: "Restored" } })],
});

const parseError = new EnvelopeParseError({
  agent: "hotfixer",
  expected: "BuildOutput",
  issues: [],
  raw: "{",
});

/** A phase that can fail either way: one error the correction loop owns, one it must not. */
const phase = (
  failure: EnvelopeParseError | PermissionBreach,
): Effect.Effect<string, EnvelopeParseError | PermissionBreach> => Effect.fail(failure);

/**
 * The correction loop, reduced to the one thing this test is about: the tags it handles.
 *
 * A breach is deliberately absent. Upstream that absence is a paragraph in a docstring; here the
 * annotation below is the assertion, and `bun tsc` is what runs it.
 */
const withCorrections = (
  failure: EnvelopeParseError | PermissionBreach,
): Effect.Effect<string, PermissionBreach> =>
  phase(failure).pipe(
    Effect.catchTags({ EnvelopeParseError: () => Effect.succeed("re-prompted") }),
  );

describe("a permission breach", () => {
  it.effect("is not what the correction loop handles", () =>
    Effect.gen(function* () {
      expect(yield* withCorrections(parseError)).toBe("re-prompted");

      const outcome = yield* withCorrections(breach).pipe(Effect.result);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("PermissionBreach");
    }),
  );

  it("cannot have a handler written for it by accident", () => {
    const parsesOnly: Effect.Effect<string, EnvelopeParseError> = Effect.fail(parseError);

    // Adding a handler for a tag the effect cannot raise is a hard type error: the cases
    // intersection maps an unknown key to `never`. That is what makes retrying a breach
    // impossible rather than merely discouraged — see architecture.md D8. Remove the directive
    // and `bun tsc` fails; remove the handler and the directive itself becomes the failure.
    const refused = parsesOnly.pipe(
      // @ts-expect-error PermissionBreach is not in this effect's error channel
      Effect.catchTags({ PermissionBreach: () => Effect.succeed("retried") }),
    );

    expect(refused).toBeDefined();
  });

  it("carries the outcome of every rollback beside its path", () => {
    // The trace and the error answer different questions from the same fact, so the fact has to
    // say more than "a breach happened".
    expect(breach.paths.map((rollback) => [rollback.path, rollback.outcome._tag])).toEqual([
      [".kojo/checks.ts", "Restored"],
    ]);
  });
});
