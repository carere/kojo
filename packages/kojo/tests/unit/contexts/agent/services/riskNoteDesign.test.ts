import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { contractFor } from "../../../../../src/contexts/agent/services/renderPrompt.ts";
import { DecodeIssue } from "../../../../../src/contexts/shared/models/DecodeIssue.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { correctionFor } from "../../../../../src/contexts/workflow/services/corrections.ts";
import {
  riskField,
  riskProse,
  riskRepair,
  riskRule,
  riskWords,
} from "../../../../support/riskNote.ts";

/**
 * **The designed decode failure, measured before anybody spends on it.**
 *
 * Ticket 51's first two designs each cost real calls and each failed the same way: the premise —
 * *this will make a model's first answer fail to decode* — was true when it was written and stopped
 * being true, quietly, because the constraint was visible in the rendered contract and a model that
 * reads the contract complies. Nothing graded the premise, so nothing said so until the money was
 * gone.
 *
 * This file grades the premise. Every assertion here is free and none of them involves a model.
 *
 * The schema below is built from the same `riskWords` and the same rule text that
 * `riskNote.riskField` writes into the stamped factory. It is a **second expression** of one design,
 * which is a real risk — so `stampedFieldSaysTheSameThing` reads the generated source and checks the
 * parts that decide the outcome.
 */

/** The reason-length the house form insists on, mirrored from `riskNote` through `riskRule`. */
const reasonAtLeast = 8;

/** The field, as the stamped envelope declares it. Built here so the design can be exercised. */
const risk = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      const grade = [...riskWords].find((word) => value.startsWith(`${word} — `));
      if (grade === undefined) return riskRule;
      return value.slice(grade.length + 3).trim().length >= reasonAtLeast ? undefined : riskRule;
    }),
  ),
);

const Drafted = Schema.Struct({ _tag: Schema.tag("Drafted"), risk });

const decode = (value: string) =>
  Effect.runPromise(
    Effect.result(Schema.decodeEffect(Drafted)({ _tag: "Drafted", risk: value }) as never),
  );

/**
 * The `risk` property's own schema, out of the rendered document.
 *
 * Scoped rather than searched whole, and the reason is a fault this test hit while being written:
 * `_tag` renders as `{"type":"string","enum":["Drafted"]}`, so a document-wide search for `enum`
 * fires on the tag and says the design leaks when it does not. A guard that cries wolf about the
 * one thing it exists to watch is worse than no guard.
 */
const riskContract = (): string => {
  const contract = contractFor(Drafted as never);
  const at = contract.indexOf('"risk"');
  expect(at, "the contract does not mention `risk` at all").toBeGreaterThan(0);
  const rest = contract.slice(at);
  return rest.slice(0, rest.indexOf("}") + 1);
};

describe("the designed decode failure", () => {
  /**
   * **The premise, and the reason this design replaced two others.**
   *
   * A cold turn is handed `contractFor`'s output and nothing else about the envelope. If the rule
   * were visible there, a model would comply and there would be no failure to repair — which is
   * exactly what happened twice, against two models, at two strengths of prose rule.
   */
  it("renders a contract that says nothing about the rule", () => {
    const field = riskContract();

    // The field is there, and it is a string. That much is true and has to be.
    expect(field).toContain('"type": "string"');

    // And nothing in it could tell a model the form. Each of these is a thing an earlier design put
    // in front of the model without noticing.
    for (const leak of ["enum", "pattern", "maxLength", "minLength", "allOf", "—"]) {
      expect(field, `the contract leaks ${leak}`).not.toContain(leak);
    }
    for (const word of riskWords) expect(field).not.toContain(word);

    // The whole of what the model is told about this field, quoted so a reader sees the premise
    // rather than infers it from six negatives.
    expect(field.replace(/\s+/g, " ")).toBe('"risk": { "type": "string" }');
  });

  it("refuses the sentence a model writes when it has been shown nothing", async () => {
    const outcome = await decode(riskProse);
    expect(outcome._tag).toBe("Failure");
  });

  it("accepts the form the correction teaches", async () => {
    const outcome = await decode(riskRepair);
    expect(outcome._tag).toBe("Success");
  });

  /**
   * Design 1's repair, kept as a row: `low — …` was what the model reached for when told only the
   * expected *type*. Under this design that answer is **correct**, which is the point — the rule is
   * now stated, so a repair that reaches for it lands.
   */
  it.each([
    ["a bare grade, with no reason", "low", false],
    ["a grade and a dash but no reason", "low — ok", false],
    ["a grade with a hyphen rather than an em dash", "low - only appends a line to notes", false],
    [
      "a grade that is not one of the three",
      "tiny — only appends a line to notes/hello.txt",
      false,
    ],
    [
      "design 1's own repair, which now decodes",
      "low — this only appends one line to a file",
      true,
    ],
    ["the house form", riskRepair, true],
  ])("%s", async (_case, value, decodes) => {
    const outcome = await decode(value);
    expect(outcome._tag).toBe(decodes ? "Success" : "Failure");
  });

  /**
   * **The correction is the only place the rule is ever stated**, so it has to carry it whole. This
   * is what design 1 lacked: its correction reported the expected *type* and the repair guessed.
   */
  it("puts the rule, verbatim and under the field's name, into the correction", async () => {
    const outcome = await decode(riskProse);
    if (outcome._tag !== "Failure") throw new Error("expected the prose to be refused");

    const issues = DecodeIssue.fromSchemaError(outcome.failure as never);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["risk"]);
    expect(issues[0]?.message).toBe(riskRule);

    const correction = correctionFor(
      new EnvelopeParseError({ agent: "drafter", expected: "Drafted", raw: riskProse, issues }),
    );
    expect(correction).toContain("risk: ");
    expect(correction).toContain(riskRule);
    // And the rule the correction teaches is a rule a repair can satisfy, which is the whole claim.
    expect(riskRule).toContain(riskRepair.slice(0, riskRepair.indexOf(" —") + 2));
  });

  /**
   * **The schema above is a second expression of the design, and this is the seam that could rot.**
   *
   * `riskField` is a *string*: TypeScript written into the stamped factory's own `envelopes.ts`,
   * compiled there and never here. So the filter this file exercises and the filter a paid run meets
   * are two pieces of code that have to agree, and nothing but this test makes them.
   *
   * It checks the parts that decide the outcome rather than the whole text — a character-for-character
   * comparison would fail on a reflowed comment and teach nobody anything.
   */
  it("declares in the stamped factory what this file exercises here", () => {
    // A filter, not a pattern and not literals. This one line is the entire premise: change it to
    // `Schema.Literals` and the contract starts showing the model the answer again.
    expect(riskField).toContain("Schema.makeFilter(");
    expect(riskField).not.toContain("Schema.Literals(");
    expect(riskField).not.toContain("Schema.pattern(");

    // The same three grades, the same separator, the same reason length, and the same message.
    for (const word of riskWords) expect(riskField).toContain(`"${word}"`);
    expect(riskField).toContain('word + " — "');
    expect(riskField).toContain(`>= ${reasonAtLeast}`);
    expect(riskField).toContain(JSON.stringify(riskRule));

    // And it is a `risk` field on a struct, which is what the injection appends it as.
    expect(
      riskField.trimStart().startsWith("/**") || riskField.includes("risk: Schema.String"),
    ).toBe(true);
  });
});
