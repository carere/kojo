// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${…}` below is a *model's prose*
// about a template string, quoted verbatim. It is the exact case the narrower has to survive, so it
// has to stay a plain string — turning it into a template literal would interpolate it away.

import { describe, expect, it } from "@effect/vitest";
import { envelopeBlock } from "../../../../../src/contexts/agent/services/envelopeBlock.ts";

/**
 * The narrowing that stands between a real agent and the decoder.
 *
 * Every case here is one a model actually produces, and the last two are the ones that decide
 * whether the correction loop is real: an answer with no object in it must come back **unchanged**,
 * so the phase fails to decode and the loop gets the fault it exists for. A narrower that invented
 * an object would turn every prose answer into a different error further downstream.
 */
describe("narrowing an agent's answer to the envelope", () => {
  it("takes a bare object as it stands", () => {
    expect(envelopeBlock('{"_tag":"Drafted","files":[]}')).toBe('{"_tag":"Drafted","files":[]}');
  });

  it("strips the prose a model puts in front of the answer", () => {
    const said = ["I made the change. Here it is:", "", '{"_tag":"Drafted","files":["a.ts"]}'].join(
      "\n",
    );

    expect(envelopeBlock(said)).toBe('{"_tag":"Drafted","files":["a.ts"]}');
  });

  it("takes the body of a fenced block, label or no label", () => {
    const said = ["Here you go:", "```json", '{"_tag":"Drafted","files":[]}', "```"].join("\n");

    expect(envelopeBlock(said)).toBe('{"_tag":"Drafted","files":[]}');
    expect(envelopeBlock(said.replace("```json", "```"))).toBe('{"_tag":"Drafted","files":[]}');
  });

  it("takes the last fenced block, so a worked example does not win over the answer", () => {
    const said = [
      "The shape is like this:",
      "```json",
      '{"_tag":"Example","files":["not-the-answer.ts"]}',
      "```",
      "and my answer is:",
      "```json",
      '{"_tag":"Drafted","files":["real.ts"]}',
      "```",
    ].join("\n");

    expect(envelopeBlock(said)).toBe('{"_tag":"Drafted","files":["real.ts"]}');
  });

  /**
   * A summary is prose, and prose has braces in it. `indexOf("{")` paired with `lastIndexOf("}")`
   * takes the first brace of the quoted snippet and the last brace of the envelope, and returns
   * something that is neither — which decodes as a `SchemaError` about a field nobody wrote.
   */
  it("does not splice a brace out of the prose onto the envelope", () => {
    const said = [
      "I replaced the `${name}` interpolation in a template string, then answered:",
      '{"_tag":"Drafted","files":["template.ts"],"summary":"replaced {name}"}',
    ].join("\n");

    expect(envelopeBlock(said)).toBe(
      '{"_tag":"Drafted","files":["template.ts"],"summary":"replaced {name}"}',
    );
  });

  it("keeps a nested object whole", () => {
    const said = '{"_tag":"Scouted","finding":{"path":"a.ts","note":"here"}}';

    expect(envelopeBlock(`Found it.\n\n${said}\n`)).toBe(said);
  });

  it("hands back prose unchanged, so a refusal stays a refusal", () => {
    expect(envelopeBlock("  I could not find the file you meant.  ")).toBe(
      "I could not find the file you meant.",
    );
  });

  it("hands back an unbalanced fragment unchanged rather than closing it", () => {
    expect(envelopeBlock('{"_tag":"Drafted","files":[')).toBe('{"_tag":"Drafted","files":[');
  });
});
