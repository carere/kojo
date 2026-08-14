import { describe, expect, it } from "@effect/vitest";
import { Effect, type Option, Result, Schema } from "effect";
import { decodeUnknown } from "../../../../../src/contexts/shared/lib/decode.ts";
import { DecodeIssue } from "../../../../../src/contexts/shared/models/DecodeIssue.ts";
import { PathRollback } from "../../../../../src/contexts/shared/models/PathRollback.ts";
import {
  CheckReport,
  CheckResult,
  ClaimFault,
} from "../../../../../src/contexts/workflow/models/CheckReport.ts";
import { CheckViolation } from "../../../../../src/contexts/workflow/models/CheckViolation.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { PermissionBreach } from "../../../../../src/contexts/workflow/models/PermissionBreach.ts";
import {
  correctionFor,
  withCorrections,
} from "../../../../../src/contexts/workflow/services/corrections.ts";

const parseError = new EnvelopeParseError({
  agent: "hotfixer",
  expected: "BuildOutput",
  issues: [
    new DecodeIssue({ path: ["changedFiles", "0"], message: "Expected string, got 3" }),
    new DecodeIssue({ path: ["commitMessage"], message: "Missing key" }),
  ],
  raw: '{"changedFiles":[3]}',
});

const violation = new CheckViolation({
  agent: "hotfixer",
  check: "diffMatchesClaims",
  report: new CheckReport({
    results: [
      new CheckResult({
        check: "artifactsExist",
        description: "every path `artifacts` names is really in the workspace",
        faults: [],
      }),
      new CheckResult({
        check: "diffMatchesClaims",
        description: "`changedFiles` lists exactly the paths the working tree changed",
        faults: [
          new ClaimFault({
            claim: ["changedFiles", "0"],
            subject: "src/parser.ts",
            detail: "the working tree holds no change at this path",
          }),
        ],
      }),
    ],
  }),
});

const breach = new PermissionBreach({
  agent: "hotfixer",
  scope: "read-only",
  paths: [new PathRollback({ path: ".kojo/checks.ts", outcome: { _tag: "Restored" } })],
});

/**
 * A scripted phase: one failure per go, then success.
 *
 * `seen` is what proves the correction reached the next attempt — the loop is worth nothing if the
 * next call is handed the same prompt as the last one.
 */
const scripted = <E>(failures: ReadonlyArray<E>) => {
  const seen: Array<Option.Option<string>> = [];
  const remaining = [...failures];
  return {
    seen,
    attempt: (correction: Option.Option<string>): Effect.Effect<string, E> => {
      seen.push(correction);
      const failure = remaining.shift();
      return failure === undefined ? Effect.succeed("accepted") : Effect.fail(failure);
    },
  };
};

describe("the correction text", () => {
  it("names every field a decode refused, with its path", () => {
    const text = correctionFor(parseError);

    // Written from the issue tree, never from a rendered message: the tree is what carries
    // `changedFiles.0`, and an agent told only "invalid input" spends the next turn guessing.
    expect(text).toContain("changedFiles.0: Expected string, got 3");
    expect(text).toContain("commitMessage: Missing key");
    expect(text).toContain("BuildOutput");
  });

  it("names every claim a check refused, with what the repository holds instead", () => {
    const text = correctionFor(violation);

    expect(text).toContain("diffMatchesClaims");
    expect(text).toContain('changedFiles.0 — "src/parser.ts"');
    expect(text).toContain("the working tree holds no change at this path");
    // The check that held is not repeated back at the agent as something to fix.
    expect(text).not.toContain("artifactsExist");
  });

  it("points at the whole answer when a fault has no path to point at", () => {
    const text = correctionFor(
      new EnvelopeParseError({
        agent: "scout",
        expected: "Scouted",
        issues: [new DecodeIssue({ path: [], message: "Expected an object, got a string" })],
        raw: "I had a look around",
      }),
    );

    expect(text).toContain("the answer as a whole: Expected an object, got a string");
  });
});

/**
 * The correction for an input a real decoder really refused, never for a hand-built issue list.
 *
 * The literal clause below is read out of the *message the decoder wrote*, so a test that wrote that
 * message itself would grade nothing but its own typing: it would stay green if Effect started
 * rendering a literal union some other way, and the correction sent to a paying model would quietly
 * lose the sentence ticket 48 bought. So every assertion in this block starts at a schema and an
 * answer, and the `SchemaError` in between is the real one.
 */
const refusedBy = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  answer: unknown,
): Effect.Effect<string> =>
  decodeUnknown(schema)(answer).pipe(
    Effect.flip,
    Effect.map((error) =>
      correctionFor(
        EnvelopeParseError.fromSchemaError(
          { agent: "drafter", expected: "Drafted", raw: JSON.stringify(answer) },
          error,
        ),
      ),
    ),
    Effect.orDie,
  );

describe("the correction text, over a decode a real decoder refused", () => {
  /** The throwaway factory's `Drafted`, with the narrow field ticket 48's design added to it. */
  class Drafted extends Schema.Class<Drafted>("Drafted")({
    summary: Schema.String,
    risk: Schema.Literals(["low", "medium", "high"]),
  }) {}

  it.effect("says a literal field must equal one of the words, with nothing around it", () =>
    Effect.gen(function* () {
      // The answer a real model gave on 2026-08-13, quoted from the session transcript: the right
      // word, with the sentence the factory asked for stapled to it. It is what the correction that
      // preceded this test failed to rule out.
      const text = yield* refusedBy(Drafted, {
        summary: "Appended a second line to notes/hello.txt.",
        risk: "low — this is a one-line text addition to notes/hello.txt with no code impact",
      });

      // The type the decoder reported is still there. The clause is added to it, never instead of it.
      expect(text).toContain('risk: Expected "low" | "medium" | "high"');
      expect(text).toContain("The whole value must be exactly one of those words");
      expect(text).toContain("with nothing before it and nothing");
      expect(text).toContain("after it — no dash, no sentence, no explanation wrapped around it");
      // The words are quoted back as the JSON the answer has to hold.
      expect(text).toContain('Write it as exactly\n  "low", "medium" or "high";');
      // And the prose is told where to go, because a repair with nowhere to put it writes it here
      // again — which is exactly what the paid repair did.
      expect(text).toContain("anything you have to say beyond that has to go elsewhere");
    }),
  );

  it.effect("says it for a field that accepts one word as well", () =>
    Effect.gen(function* () {
      class Mood extends Schema.Class<Mood>("Mood")({ mood: Schema.Literals(["calm"]) }) {}

      const text = yield* refusedBy(Mood, { mood: "calm, mostly" });

      expect(text).toContain('mood: Expected "calm"');
      expect(text).toContain('Write it as exactly\n  "calm";');
      // One word is not a list, so nothing offers a choice that does not exist.
      expect(text).not.toContain(" or ");
    }),
  );

  it.effect("keeps a word that holds the separator whole", () =>
    Effect.gen(function* () {
      class Odd extends Schema.Class<Odd>("Odd")({ shape: Schema.Literals(["a | b", "c"]) }) {}

      const text = yield* refusedBy(Odd, { shape: "d" });

      // Two words, not three. A correction built by splitting the rendered type on the separator
      // would offer `"a`, `b"` and `"c"`, and send the repair at a value no schema accepts.
      expect(text).toContain('Write it as exactly\n  "a | b" or "c";');
    }),
  );

  it.effect("invents no rule for a fault that is not a set of words", () =>
    Effect.gen(function* () {
      class Mixed extends Schema.Class<Mixed>("Mixed")({
        summary: Schema.String,
        level: Schema.Literals([1, 2]),
        note: Schema.String,
      }) {}

      const text = yield* refusedBy(Mixed, { summary: 3, level: 5 });

      // Every one of these is reported exactly as the decoder wrote it: a wrong type, a set of
      // numbers the clause cannot quote back as JSON words, and an absent key.
      expect(text).toContain("summary: Expected string");
      expect(text).toContain("level: Expected 1 | 2");
      expect(text).toContain("note: Missing key");
      expect(text).not.toContain("The whole value must be exactly");
    }),
  );
});

describe("the correction loop", () => {
  it.effect("turns a refused answer into the next prompt", () =>
    Effect.gen(function* () {
      const phase = scripted([parseError]);

      expect(yield* withCorrections(phase.attempt, 2)).toBe("accepted");
      expect(phase.seen).toHaveLength(2);
      // The first go carries the author's prompt, the second the failure turned into words.
      expect(phase.seen[0]?._tag).toBe("None");
      expect(phase.seen[1]?._tag).toBe("Some");
    }),
  );

  it.effect("corrects a check violation on the same terms as a parse error", () =>
    Effect.gen(function* () {
      const phase = scripted([violation]);

      expect(yield* withCorrections(phase.attempt, 2)).toBe("accepted");
      expect(phase.seen).toHaveLength(2);
    }),
  );

  it.effect("spends the bound and no more", () =>
    Effect.gen(function* () {
      const phase = scripted([parseError, parseError, parseError, parseError]);

      const outcome = yield* withCorrections(phase.attempt, 2).pipe(Effect.result);

      // One first go plus two corrections. The fourth failure is never reached.
      expect(phase.seen).toHaveLength(3);
      expect(Result.isFailure(outcome)).toBe(true);
      // Exhausting the bound fails with the original error, never a wrapper around it — a phase
      // that ran out of corrections failed for the reason its last answer was refused.
      if (Result.isFailure(outcome)) expect(outcome.failure).toBe(parseError);
    }),
  );

  it.effect("does not correct at all when the bound is zero", () =>
    Effect.gen(function* () {
      const phase = scripted([violation]);

      const outcome = yield* withCorrections(phase.attempt, 0).pipe(Effect.result);

      expect(phase.seen).toHaveLength(1);
      if (Result.isFailure(outcome)) expect(outcome.failure).toBe(violation);
    }),
  );

  it.effect("lets a permission breach straight out, uncorrected", () =>
    Effect.gen(function* () {
      const phase = scripted<EnvelopeParseError | PermissionBreach>([breach, parseError]);

      const outcome = yield* withCorrections(phase.attempt, 3).pipe(Effect.result);

      // The write already happened and has already been undone. Re-prompting is meaningless, so
      // the loop never gets a second go — see architecture.md D8.
      expect(phase.seen).toHaveLength(1);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure).toBe(breach);
    }),
  );

  it("cannot be told to correct a breach", () => {
    const refusable = ["EnvelopeParseError", "CheckViolation"] as const;
    const phase: Effect.Effect<string, EnvelopeParseError | CheckViolation> =
      Effect.fail(parseError);

    // The loop's own dispatch, reproduced. Naming a tag the effect cannot raise is a hard type
    // error, which is what makes D8 structural rather than a docstring: `PermissionBreach` cannot
    // be added to the list beside the two below, by anyone, ever. Remove the directive and
    // `bun tsc` fails; remove `"PermissionBreach"` and the directive itself becomes the failure.
    const refused = phase.pipe(
      Effect.catchTag(
        // @ts-expect-error PermissionBreach is not in this effect's error channel
        [...refusable, "PermissionBreach"],
        () => Effect.succeed("corrected"),
      ),
    );

    // And the two that are in the list are accepted, so the assertion above is about the third one
    // rather than about the shape of the call.
    const allowed = phase.pipe(Effect.catchTag(refusable, () => Effect.succeed("corrected")));

    expect(refused).toBeDefined();
    expect(Effect.runSync(allowed)).toBe("corrected");
  });
});
