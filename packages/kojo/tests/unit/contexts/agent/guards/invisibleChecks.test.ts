import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  describeInvisible,
  invisibleChecks,
} from "../../../../../src/contexts/agent/guards/invisibleChecks.ts";
import { EnvelopeBase } from "../../../../../src/contexts/workflow/models/Envelope.ts";

/**
 * **Which of Effect's refinements the rendered contract shows an agent, enumerated by a test** —
 * ticket 58, criterion 1.
 *
 * The list below is the point of this file. It is not documentation of Effect: it is a **measurement
 * of the version this repository pins**, and the day Effect teaches `makeFilter` to render, or stops
 * rendering `isMaxLength`, a row here goes red and somebody finds out. That is the difference
 * between this and the paragraph it replaces — ticket 51 lost two paid calls to a premise that was
 * true when written and quietly stopped being true.
 *
 * `invisibleChecks` does not read this table. It does the arithmetic — *declared minus shown* — so
 * it stays right when the table changes. The table is what tells a person which way it changed.
 */

const filter = Schema.makeFilter((value: string) => (value.length > 2 ? undefined : "too short"));

/** An envelope with one field carrying the refinement under test. */
const withField = (field: Schema.Top) =>
  Schema.Struct({ _tag: Schema.tag("Drafted"), risk: field as never });

const hiddenOn = (field: Schema.Top) => invisibleChecks(withField(field));

describe("which refinements the rendered contract shows", () => {
  /**
   * **Shown.** Each of these reaches the agent on the cold turn, so a well-behaved model complies
   * first time and the correction loop never runs. This is the ordinary case and it is what a
   * factory author should aim for.
   */
  it.each([
    ["a plain string", Schema.String],
    ["literals, which render as an enum", Schema.Literals(["low", "medium", "high"])],
    [
      "isMaxLength, which renders maxLength",
      Schema.String.pipe(Schema.check(Schema.isMaxLength(9))),
    ],
    ["isMinLength", Schema.String.pipe(Schema.check(Schema.isMinLength(2)))],
    ["isTrimmed, which renders a pattern", Schema.String.pipe(Schema.check(Schema.isTrimmed()))],
    ["isUppercased", Schema.String.pipe(Schema.check(Schema.isUppercased()))],
    [
      "two built-in checks together",
      Schema.String.pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(9))),
    ],
  ])("shows %s", (_case, field) => {
    expect(hiddenOn(field as Schema.Top)).toEqual([]);
  });

  /**
   * **Not shown.** A custom filter is the whole of ticket 58 — and the whole of ticket 51's third
   * design, which is why `riskNoteDesign.test.ts` will be the first thing to notice if this ever
   * changes.
   */
  it("does not show a custom filter", () => {
    expect(hiddenOn(Schema.String.pipe(Schema.check(filter)))).toEqual([
      { field: "risk", declared: 1, shown: 0 },
    ]);
  });

  it("counts each unshown rule, so two filters are two", () => {
    expect(hiddenOn(Schema.String.pipe(Schema.check(filter, filter)))).toEqual([
      { field: "risk", declared: 2, shown: 0 },
    ]);
  });

  /**
   * The arithmetic rather than a list of known-good checks, which is what keeps this right when the
   * two kinds are mixed — the case a "does this field have a filter?" test would get wrong.
   */
  it("counts only the unshown half when both kinds are on one field", () => {
    expect(hiddenOn(Schema.String.pipe(Schema.check(Schema.isMaxLength(9), filter)))).toEqual([
      { field: "risk", declared: 2, shown: 1 },
    ]);
  });

  it("finds a rule on the object as a whole, which has no field to name", () => {
    const whole = Schema.Struct({ _tag: Schema.tag("Drafted"), risk: Schema.String }).pipe(
      Schema.check(
        Schema.makeFilter((value: { risk: string }) => (value.risk ? undefined : "needs a risk")),
      ),
    );

    expect(invisibleChecks(whole as never)).toEqual([{ field: undefined, declared: 1, shown: 0 }]);
  });

  it("finds every field, and reports them outermost first", () => {
    const envelope = Schema.Struct({
      _tag: Schema.tag("Drafted"),
      summary: Schema.String,
      risk: Schema.String.pipe(Schema.check(filter)),
      size: Schema.String.pipe(Schema.check(Schema.isMaxLength(9))),
      owner: Schema.String.pipe(Schema.check(filter)),
    });

    expect(invisibleChecks(envelope as never)).toEqual([
      { field: "risk", declared: 1, shown: 0 },
      { field: "owner", declared: 1, shown: 0 },
    ]);
  });

  /**
   * A diagnostic that dies on a factory is worse than one that says nothing about it, so anything
   * that will not render comes back empty and the caller reports what it could not look at.
   */
  it("answers empty rather than throwing on a schema it cannot render", () => {
    const unrenderable = { ast: { propertySignatures: undefined } } as unknown as Schema.Top;
    expect(invisibleChecks(unrenderable)).toEqual([]);
  });

  it("says where and how many, in words a report can print", () => {
    expect(describeInvisible({ field: "risk", declared: 1, shown: 0 })).toBe(
      "`risk` — 1 of 1 rule not shown",
    );
    expect(describeInvisible({ field: "risk", declared: 3, shown: 1 })).toBe(
      "`risk` — 2 of 3 rules not shown",
    );
    expect(describeInvisible({ field: undefined, declared: 1, shown: 0 })).toBe(
      "the answer as a whole — 1 of 1 rule not shown",
    );
  });

  /**
   * **The shape a factory actually holds, which the first version of this guard got wrong.**
   *
   * `Schema.Struct` and `Schema.Class` are two different things to both halves of the comparison: a
   * class's AST is a `Declaration` carrying no properties, and its JSON Schema is a `$ref` into
   * `definitions` rather than an object. The guard read `ast.propertySignatures` and the raw
   * document, so it answered *nothing hidden* about every envelope `kojo init` stamps — a check
   * that passed while doing no work, caught by the doctor test rather than by these.
   *
   * It reads `.fields` and `contractSchema` now, which are what both sides really are.
   */
  it("finds a hidden rule on an EnvelopeBase class, not only on a plain struct", () => {
    class Drafted extends EnvelopeBase.extend<Drafted>("Drafted")({
      _tag: Schema.tag("Drafted"),
      summary: Schema.String,
      risk: Schema.String.pipe(Schema.check(filter)),
      size: Schema.String.pipe(Schema.check(Schema.isMaxLength(9))),
    }) {}

    expect(invisibleChecks(Drafted as never)).toEqual([{ field: "risk", declared: 1, shown: 0 }]);
  });

  it("says nothing about an EnvelopeBase class whose rules all render", () => {
    class Clean extends EnvelopeBase.extend<Clean>("Clean")({
      _tag: Schema.tag("Clean"),
      summary: Schema.String,
      size: Schema.String.pipe(Schema.check(Schema.isMaxLength(9))),
    }) {}

    expect(invisibleChecks(Clean as never)).toEqual([]);
  });
});
